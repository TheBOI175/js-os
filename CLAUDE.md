# JS OS — Project Context

## Who is Aarav

Aarav is Laksh's son. This is a **personal/hobby project** — prioritize fun, simplicity, and learning over enterprise patterns. Keep suggestions practical and fun, not corporate.

## Project History

Started as **PHP Chat**, moved to **Node.js with WebSockets**. Terminal app was replaced with **JS Note** (music composer) on 2026-03-20, then JS Note was replaced with **Gemma AI** (Google Gemini API) on 2026-03-21. Production hardening added on 2026-03-20. The folder is `js-chat`.

## Stack & Architecture

**No frameworks.** Native Node.js HTTP server + `ws` + `ioredis` (Redis). Gemini API for AI (just an API key, no extra deps). That's it.

### File Structure
```
js-chat/
├── CLAUDE.md
├── server.js              ← HTTP + WebSocket server (chat, call, JSTube API, AI proxy)
├── package.json           ← deps: ws, ioredis
├── package-lock.json
└── public/
    ├── index.html         ← HTML structure (no inline CSS/JS)
    ├── sw.js              ← Service worker for push notifications
    ├── css/
    │   └── style.css      ← All styles
    ├── js/
    │   ├── config.js      ← Global config (app names, changeable in one place)
    │   └── app.js         ← All client logic (OOP classes)
    ├── images/
    │   └── logo.png       ← JS-themed logo (tiled background + favicon)
    └── sounds/
        ├── startup.mp3
        ├── message_sent.mp3
        └── minimize_fullscreen_close.mp3
```

### Server (`server.js`)

- **HTTP**: Static files from `public/` + `/health` endpoint + `/api/search` (JSTube) + AI endpoints
- **Two WebSocket servers** (noServer + upgrade routing):
  - `ws://host/` — Chat (rooms with create/join/broadcast)
  - `ws://host/call` — Call signaling (WebRTC)
- **AI endpoints** (proxy to Google Gemini):
  - `GET /api/ai/status` — check AI status
  - `GET /api/ai/models` — list available models
  - `POST /api/ai/chat` — stream AI response as SSE (Server-Sent Events)
- **Production features**: Rate limiting (token bucket per IP), connection limits (100K global, 50/IP), WebSocket heartbeat (30s ping/pong), broadcast backpressure (>1MB skip), graceful shutdown (SIGTERM/SIGINT)
- **Redis** (required): pub/sub for cross-instance chat/call sync, username uniqueness via keys with 2hr TTL. `REDIS_HOST` must be set or server refuses to start
- **Gemini AI** (required): `GEMINI_API_KEY` must be set or server refuses to start. Free key from aistudio.google.com. Model configurable via `GEMINI_MODEL` (default: gemini-2.5-flash)
- **Logging**: ANSI colored pretty logs or JSON mode (`LOG_FORMAT=json`). Categories: `SERVER`, `HTTP`, `WS`, `CHAT`, `CALL`, `JSTUBE`, `AI`, `REDIS`

### Client (`public/js/app.js`) — OOP Classes

- **`Logger`** — Color-coded debug logging with levels
- **`SoundManager`** — Plays startup, message, and window sounds
- **`NotificationManager`** — Service worker notifications when tab is hidden
- **`WindowManager`** — Window open/close with CSS animations
- **`ChatClient`** — WebSocket chat with create/join/message/disconnect
- **`CallClient`** — WebRTC voice calls with mesh peer connections
- **`GemmaClient`** — HTTP streaming to Gemini API via SSE, with AbortController for cancellation
- **`ConversationStore`** — localStorage persistence for AI conversation histories
- **`JSTubeManager`** — YouTube search + iframe embed player
- **`BaseApp`** — Abstract base class for all apps
- **`JSChatApp`**, **`GemmaApp`**, **`JSTubeApp`**, **`JSCallApp`** — App subclasses
- **`Desktop`** — Main orchestrator, config system, splash screen, error dialogs

### Global Config (`public/js/config.js`)

```js
window.JSOS_CONFIG = {
    os:   'JS OS',
    chat: 'JS Chat',
    ai:   'Gemma',
    tube: 'JSTube',
    call: 'JS Call',
};
```
Change names here → they propagate everywhere via `data-name` attributes.

## UI & Aesthetics

**The aesthetics are sacred. Never change the visual design without asking.**

### Theme
- **Colors**: JS yellow `#F7DF1E` + dark `#323330` / `#1e1e1e`
- **Background**: `#6b5f0d` with tiled logo pattern
- **Font**: Tahoma, Arial, sans-serif (retro Windows 2000 style)

### Apps (4 total)
1. **JS Chat** — Room-based chat with image sharing, user panel, status bar
2. **Gemma AI** — AI chat powered by Google Gemini with streaming responses, code blocks, conversation history, message editing
3. **JSTube** — YouTube search + embedded player
4. **JS Call** — WebRTC voice calls with mute/unmute

### Window Behavior
- Explorer closes → app opens (scale animations)
- Close button: disconnects/cleans up, reopens explorer. Does NOT play sound.
- Minimize/maximize buttons play sound but are non-functional

## Rules & Preferences

1. **No frameworks** — native Node + ws + ioredis only (Gemini is just a fetch call)
2. **Aesthetics are sacred** — don't touch visuals without asking
3. **OOP** — client code uses classes, follow existing pattern
4. **Separated files** — HTML/CSS/JS in their folders
5. **Sounds matter** — startup on boot, message on chat, window on minimize/maximize
6. **Keep it simple** — no auth, no databases unless asked
7. **Don't add dependencies without asking**
8. **Logo** — Aarav provides it. Don't replace it.
9. **Config** — app names go in `config.js`, not hardcoded

## How to Run

```bash
cd ~/Desktop/js-os
npm start
```

Opens at **http://localhost:8080** (configurable via `PORT` env var).

Both Redis and Gemini are required:
```bash
GEMINI_API_KEY=your-key-here REDIS_HOST=127.0.0.1 npm start
```
Or just add them to `.env` and run `npm start`.

## Deployment

- **Cloudflare** for domain/CDN
- **Redis** (required — Upstash free tier or self-hosted)
- **Gemini API key** (required — free from aistudio.google.com)
- Server handles: rate limiting, connection limits, heartbeat, backpressure, graceful shutdown
