const http = require("http");
const { Server } = require("socket.io");

// ─── Environment Variables ────────────────────────────────────────────────────
// Set these in Render/Railway dashboard → Environment tab:
//   ALLOWED_ORIGIN=https://hallwaychat.online,http://localhost:3000
//   NODE_ENV=production
//   TURN_USERNAME=your_turn_user
//   TURN_CREDENTIAL=your_turn_credential

// SECURITY: Support multiple allowed origins via comma-separated env var
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(",").map(o => o.trim())
  : ["http://localhost:3000", "http://127.0.0.1:3000", "https://hallwaychat.online"];

const NODE_ENV = process.env.NODE_ENV || "development";
const PORT = process.env.PORT || 3001;

const TURN_USERNAME = process.env.TURN_USERNAME || "";
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || "";

// ─── Input Validation ─────────────────────────────────────────────────────────
const MAX_MESSAGE_LENGTH = 500;
const MAX_INTERESTS = 10;
const MAX_REASON_LENGTH = 100;
const MAX_CONNECTIONS_PER_IP = 5;

function sanitizeString(str, maxLength = 200) {
  if (typeof str !== "string") return "";
  return str
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\w\s.,!?@#\-]/g, "")
    .slice(0, maxLength);
}

function validateInterests(interests) {
  if (!Array.isArray(interests)) return [];
  return interests
    .filter((i) => typeof i === "string")
    .map((i) => sanitizeString(i, 40))
    .filter((i) => i.length > 0)
    .slice(0, MAX_INTERESTS);
}

function validateSignalData(data) {
  return data !== null && typeof data === "object";
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const ipConnectionCount = {};
const socketEventCount = {};
const bannedIPs = new Set();

const RATE_LIMITS = {
  "find-match": { max: 20, windowMs: 60_000 },
  "chat-message": { max: 30, windowMs: 10_000 },
  "next": { max: 15, windowMs: 60_000 },
  "report": { max: 5, windowMs: 60_000 },
  "webrtc-offer": { max: 20, windowMs: 60_000 },
  "webrtc-answer": { max: 20, windowMs: 60_000 },
  "ice-candidate": { max: 100, windowMs: 10_000 },
};

function isRateLimited(socketId, event) {
  const limit = RATE_LIMITS[event];
  if (!limit) return false;
  const now = Date.now();
  if (!socketEventCount[socketId]) socketEventCount[socketId] = {};
  const tracker = socketEventCount[socketId][event] || { count: 0, windowStart: now };
  if (now - tracker.windowStart > limit.windowMs) {
    tracker.count = 0;
    tracker.windowStart = now;
  }
  tracker.count++;
  socketEventCount[socketId][event] = tracker;
  if (tracker.count > limit.max) {
    console.warn(`⚠️  Rate limit: ${socketId} on "${event}" (${tracker.count}/${limit.max})`);
    return true;
  }
  return false;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // SECURITY: Dynamic CORS — allow any of the whitelisted origins
  const requestOrigin = req.headers.origin;
  const allowedOrigin = ALLOWED_ORIGINS.includes(requestOrigin)
    ? requestOrigin
    : ALLOWED_ORIGINS[0];

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src *");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/ice-config" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.relay.metered.ca:80" },
        { urls: "turn:global.relay.metered.ca:80", username: TURN_USERNAME, credential: TURN_CREDENTIAL },
        { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: TURN_USERNAME, credential: TURN_CREDENTIAL },
        { urls: "turn:global.relay.metered.ca:443", username: TURN_USERNAME, credential: TURN_CREDENTIAL },
        { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: TURN_USERNAME, credential: TURN_CREDENTIAL },
      ]
    }));
    return;
  }

  // Public stats endpoint for landing page
  if (req.url === "/stats" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(getPublicStats()));
    return;
  }

  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify(
    NODE_ENV === "production"
      ? { status: "ok" }
      : { status: "✅ Hallway server running", waiting: waitingQueue.length, activePairs: Object.keys(activePairs).length / 2 }
  ));
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    // SECURITY: Accept all whitelisted origins
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e5,
});

// ─── App State ────────────────────────────────────────────────────────────────
const waitingQueue = [];
const activePairs = {};
const userInterests = {};

// ─── Stats Tracking (since server start) ──────────────────────────────────────
const stats = {
  totalConnections: 0,      // All-time connections since server start
  totalMatches: 0,          // All-time matches since server start
  matchesToday: 0,          // Matches today (resets at midnight UTC)
  lastResetDate: new Date().toISOString().split("T")[0],
};

// Reset daily matches at midnight UTC
function checkDailyReset() {
  const today = new Date().toISOString().split("T")[0];
  if (today !== stats.lastResetDate) {
    stats.matchesToday = 0;
    stats.lastResetDate = today;
  }
}

function getPublicStats() {
  checkDailyReset();
  return {
    onlineNow: io.engine.clientsCount,
    totalConnections: stats.totalConnections,
    totalMatches: stats.totalMatches,
    matchesToday: stats.matchesToday,
  };
}

function sharedInterests(a, b) {
  return a.filter((i) => b.includes(i)).length;
}

function findBestMatch(newUser) {
  if (waitingQueue.length === 0) return null;
  let bestIndex = 0, bestScore = -1;
  waitingQueue.forEach((user, index) => {
    const score = sharedInterests(newUser.interests, user.interests);
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  });
  return waitingQueue.splice(bestIndex, 1)[0];
}

setInterval(() => io.emit("live-stats", getPublicStats()), 5000);

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  const ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;

  if (bannedIPs.has(ip)) {
    console.warn(`🚫 Blocked banned IP: ${ip}`);
    socket.disconnect(true);
    return;
  }

  ipConnectionCount[ip] = (ipConnectionCount[ip] || 0) + 1;
  if (ipConnectionCount[ip] > MAX_CONNECTIONS_PER_IP) {
    socket.emit("error-message", "Too many connections from your network.");
    socket.disconnect(true);
    return;
  }

  console.log(`✅ User connected: ${socket.id}`);
  stats.totalConnections++;
  socket.emit("live-stats", getPublicStats());

  socket.on("find-match", ({ interests }) => {
    if (isRateLimited(socket.id, "find-match")) {
      socket.emit("error-message", "Too many requests. Please slow down.");
      return;
    }
    const safeInterests = validateInterests(interests);
    userInterests[socket.id] = safeInterests;

    if (activePairs[socket.id]) {
      const oldPartner = activePairs[socket.id];
      socket.to(oldPartner).emit("partner-disconnected");
      delete activePairs[oldPartner];
      delete activePairs[socket.id];
    }

    const newUser = { socketId: socket.id, interests: safeInterests };
    const match = findBestMatch(newUser);

    if (match) {
      activePairs[socket.id] = match.socketId;
      activePairs[match.socketId] = socket.id;
      stats.totalMatches++;
      stats.matchesToday++;
      const common = sharedInterests(safeInterests, match.interests);
      socket.emit("match-found", { partnerId: match.socketId, isInitiator: true, sharedInterests: common });
      io.to(match.socketId).emit("match-found", { partnerId: socket.id, isInitiator: false, sharedInterests: common });
      console.log(`💚 Matched: ${socket.id} ↔ ${match.socketId}`);
    } else {
      waitingQueue.push(newUser);
      socket.emit("waiting");
    }
  });

  socket.on("webrtc-offer", ({ offer, to }) => {
    if (isRateLimited(socket.id, "webrtc-offer")) return;
    if (activePairs[socket.id] !== to) return;
    if (!validateSignalData(offer)) return;
    socket.to(to).emit("webrtc-offer", { offer, from: socket.id });
  });

  socket.on("webrtc-answer", ({ answer, to }) => {
    if (isRateLimited(socket.id, "webrtc-answer")) return;
    if (activePairs[socket.id] !== to) return;
    if (!validateSignalData(answer)) return;
    socket.to(to).emit("webrtc-answer", { answer, from: socket.id });
  });

  socket.on("ice-candidate", ({ candidate, to }) => {
    if (isRateLimited(socket.id, "ice-candidate")) return;
    if (activePairs[socket.id] !== to) return;
    if (!validateSignalData(candidate)) return;
    socket.to(to).emit("ice-candidate", { candidate, from: socket.id });
  });

  socket.on("chat-message", ({ message }) => {
    if (isRateLimited(socket.id, "chat-message")) {
      socket.emit("error-message", "You are sending messages too fast.");
      return;
    }
    const safeMessage = sanitizeString(message, MAX_MESSAGE_LENGTH);
    if (!safeMessage) return;
    const partnerId = activePairs[socket.id];
    if (partnerId) io.to(partnerId).emit("chat-message", { message: safeMessage });
  });

  socket.on("next", () => {
    if (isRateLimited(socket.id, "next")) {
      socket.emit("error-message", "You are skipping too fast.");
      return;
    }
    const partnerId = activePairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit("partner-disconnected");
      delete activePairs[partnerId];
      delete activePairs[socket.id];
      waitingQueue.push({ socketId: partnerId, interests: userInterests[partnerId] || [] });
      io.to(partnerId).emit("waiting");
    }
    const qi = waitingQueue.findIndex((u) => u.socketId === socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);

    const newUser = { socketId: socket.id, interests: userInterests[socket.id] || [] };
    const match = findBestMatch(newUser);
    if (match) {
      activePairs[socket.id] = match.socketId;
      activePairs[match.socketId] = socket.id;
      stats.totalMatches++;
      stats.matchesToday++;
      const common = sharedInterests(newUser.interests, match.interests);
      socket.emit("match-found", { partnerId: match.socketId, isInitiator: true, sharedInterests: common });
      io.to(match.socketId).emit("match-found", { partnerId: socket.id, isInitiator: false, sharedInterests: common });
    } else {
      waitingQueue.push(newUser);
      socket.emit("waiting");
    }
  });

  socket.on("report", ({ reason }) => {
    if (isRateLimited(socket.id, "report")) return;
    const partnerId = activePairs[socket.id];
    const safeReason = sanitizeString(reason || "No reason", MAX_REASON_LENGTH);
    console.log(`🚨 REPORT: ${socket.id} reported ${partnerId} | reason: ${safeReason}`);
    socket.emit("report-received", { message: "Report submitted. Thank you." });
  });

  socket.on("disconnect", () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    if (ipConnectionCount[ip] > 0) ipConnectionCount[ip]--;
    delete socketEventCount[socket.id];
    const partnerId = activePairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit("partner-disconnected");
      delete activePairs[partnerId];
    }
    delete activePairs[socket.id];
    delete userInterests[socket.id];
    const qi = waitingQueue.findIndex((u) => u.socketId === socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Hallway server running on port ${PORT} | ENV: ${NODE_ENV}`);
  console.log(`🌐 Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("\n⏹️  SIGTERM signal received: closing HTTP server");
  server.close(() => {
    console.log("✅ HTTP server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("❌ Forced shutdown - connections did not close gracefully");
    process.exit(1);
  }, 10000);
});

process.on("SIGINT", () => {
  console.log("\n⏹️  SIGINT signal received: closing HTTP server");
  server.close(() => {
    console.log("✅ HTTP server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("❌ Forced shutdown - connections did not close gracefully");
    process.exit(1);
  }, 10000);
});