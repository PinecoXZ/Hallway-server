# 🚀 Hallway Signaling Server

> **Real-time WebRTC matchmaking, signaling, and live telemetry server for Hallway.**

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green?logo=node.js)](https://nodejs.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.7-black?logo=socket.io)](https://socket.io/)
[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-yellow)](#license)

This service orchestrates peer discovery, targeted interest-based matching, and WebRTC SDP/ICE exchange for Hallway students. Media streams are direct browser-to-browser P2P; no audio or video data ever traverses or is stored on this server.

---

## ⚡ Core Capabilities

- **Vibe & Tag Matchmaking**: Matches students based on shared interests and custom `#tags`, falling back gracefully to the campus discovery queue.
- **WebRTC Signaling**: Relays standard `webrtc-offer`, `webrtc-answer`, and `ice-candidate` payloads between verified active pairs.
- **Turnkey ICE Configuration**: Serves `/ice-config` with STUN/TURN server endpoints for seamless NAT traversal across restricted university Wi-Fi networks.
- **Security & Abuse Prevention**:
  - Per-IP connection caps (`MAX_CONNECTIONS_PER_IP = 5`)
  - Sliding-window rate limiters on matchmaking, skips, chat messages, and signaling
  - Input sanitization and payload size limits
  - Strict CORS headers matching authorized origins
- **Telemetry**: Emits real-time live stats (`onlineNow`, `totalMatches`, `matchesToday`) every 5 seconds.

---

## 🛠️ Getting Started

### Prerequisites
- **Node.js** 18+ or 20+ LTS
- `npm` or `pnpm`

### Installation & Local Run

```bash
cd hallway-server
npm install
npm start
```

The server will start listening on port `3001` (or your defined `PORT`).

---

## ⚙️ Environment Variables

Configure these in your hosting environment (Render, Railway, or local `.env`):

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP & WebSocket port | `3001` |
| `NODE_ENV` | Environment mode (`development` / `production`) | `development` |
| `ALLOWED_ORIGIN` | Comma-separated allowed CORS origins | `http://localhost:3000, https://hallwaychat.online` |
| `TURN_USERNAME` | Metered/Coturn STUN/TURN username | `""` |
| `TURN_CREDENTIAL` | Metered/Coturn STUN/TURN password | `""` |

---

## 🌐 Endpoints

- **`GET /`**: Health status and active connection metrics
- **`GET /stats`**: Live user count and connection stats for landing page badge
- **`GET /ice-config`**: STUN/TURN server candidate array for WebRTC peer initialization

---

## 🚀 Deployment

### Deploy to Render / Railway
This repository includes a `Procfile` ready for one-click deployment:

```procfile
web: node server.js
```

1. Create a **New Web Service** on Render or Railway pointing to this repository.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Set Environment Variables:
   - `ALLOWED_ORIGIN`: `https://hallwaychat.online,http://localhost:3000`
   - `NODE_ENV`: `production`

---

## 📄 License

&copy; 2026 Hallway Technologies Pvt. Ltd. All rights reserved.
