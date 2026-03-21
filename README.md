# { } JS OS

A retro Windows 2000-style web operating system built with vanilla JavaScript, Node.js, and WebSockets. No frameworks.

## Apps

| App | Description |
|-----|-------------|
| **JS Chat** | Room-based chat with image sharing, user panel, and invite codes |
| **JS AI AI** | AI chat powered by Google Gemini with streaming responses, code blocks, conversation history, and message editing |
| **JSTube** | YouTube search and embedded video player |
| **JS Call** | WebRTC voice calls with mute/unmute and room codes |

## Setup

```bash
git clone https://github.com/TheBOI175/js-chat.git
cd js-os
npm install
```

**A Gemini API key and Redis are required.** The server will not start without both.

1. Get a free Gemini key from [Google AI Studio](https://aistudio.google.com)
2. Start Redis locally (`brew services start redis`, `sudo systemctl start redis`, or `docker run -p 6379:6379 redis`) — or use [Upstash](https://upstash.com) for free hosted Redis
3. Add them to your `.env` file:
   ```
   GEMINI_API_KEY=your-key-here
   REDIS_HOST=127.0.0.1
   ```
4. Start the server:
   ```bash
   npm start
   ```

Open **http://localhost:8080**

## Environment Variables

Set these in your `.env` file.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | **Yes** | — | Google Gemini API key |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model to use |
| `PORT` | No | `8080` | Server port |
| `REDIS_HOST` | **Yes** | — | Redis host (e.g. `127.0.0.1`) |
| `REDIS_PORT` | No | `6379` | Redis port |
| `REDIS_PASSWORD` | No | — | Redis password |
| `LOG_FORMAT` | No | `pretty` | `pretty` or `json` |
| `TRUST_PROXY` | No | `false` | Trust X-Forwarded-For header |

## Production Features

- **Rate limiting** — token bucket per IP (100 HTTP/min, 30 WS msg/sec)
- **Connection limits** — 100K global, 50 per IP
- **WebSocket heartbeat** — 30s ping/pong, kills dead connections
- **Broadcast backpressure** — skips slow clients (>1MB buffered)
- **Redis pub/sub** — cross-instance chat/call sync
- **Graceful shutdown** — SIGTERM/SIGINT handlers
- **Health endpoint** — `GET /health` returns JSON stats

## Stack

- **Server**: Native Node.js HTTP + `ws` (WebSocket) + `ioredis` (Redis)
- **Client**: Vanilla JS (OOP classes), HTML, CSS
- **AI**: Google Gemini API (streaming SSE)
- **Calls**: WebRTC with STUN
- **No frameworks**. No Express, no React, no Socket.io.

## Version History

### v3.0 — Gemini AI (2026-03-21)
- Replaced JS Note music app with JS AI AI chat
- Google Gemini API with streaming responses
- Conversation history (localStorage), message editing, code blocks
- Gemini API key required to start

### v2.0 — Production Hardening (2026-03-20)
- Rate limiting, connection limits, heartbeat, backpressure
- Redis pub/sub for multi-instance scaling
- Health endpoint, structured logging, graceful shutdown
- Replaced Terminal with JS Note music composer
- Global config system

### v1.0 — Initial Release (2026-03-19)
- 4 apps: JS Chat, Terminal, JSTube, JS Call
- Retro Windows 2000 UI with splash screen
- WebSocket chat, WebRTC voice calls
- OOP architecture

## License

ISC
