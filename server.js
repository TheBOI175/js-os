const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const os = require('os');
const crypto = require('crypto');

// ─── Load .env file ───
require('dotenv').config();

// ─── Configuration ───
const PORT = parseInt(process.env.PORT) || 8080;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS) || 100000;
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP) || 50;
const HEARTBEAT_MS = 30000;
const MSG_HISTORY_CAP = 100;
const LOG_FORMAT = process.env.LOG_FORMAT || 'pretty';
const INSTANCE_ID = crypto.randomBytes(4).toString('hex');
const MAX_BODY_SIZE = 1024 * 1024;          // 1MB for POST bodies
const MAX_WS_MESSAGE = 1024 * 1024;         // 1MB for WebSocket messages
const MAX_SIGNAL_SIZE = 100 * 1024;         // 100KB for WebRTC signal data
const MAX_MSG_TEXT = 10000;                 // 10000 chars for chat message text
const MAX_MSG_IMAGE = 500 * 1024;           // 500KB for chat image data URLs
const MAX_SEARCH_QUERY = 200;              // 200 chars for JSTube search
const MAX_ROOMS = 10000;                   // max total rooms (chat + call)
const MAX_CODEGEN_ATTEMPTS = 100;          // max retries for generateCode()
const USERNAME_RE = /^[a-zA-Z0-9_ -]{1,20}$/;
const ROOM_CODE_RE = /^[A-Z2-9]{6}$/;

// ─── Logger (supports pretty + JSON modes) ───
const ANSI = {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m',
    red: '\x1b[31m', magenta: '\x1b[35m', white: '\x1b[37m', gray: '\x1b[90m',
};
const LOG_COLORS = {
    SERVER: ANSI.green, HTTP: ANSI.gray, WS: ANSI.cyan,
    CHAT: ANSI.yellow, CALL: ANSI.magenta, JSTUBE: ANSI.cyan, AI: ANSI.cyan, REDIS: ANSI.red,
};

function log(category, msg, data) {
    if (LOG_FORMAT === 'json') {
        const entry = { time: new Date().toISOString(), level: 'info', category, msg, instance: INSTANCE_ID };
        if (data !== undefined) entry.data = data;
        console.log(JSON.stringify(entry));
    } else {
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        const color = LOG_COLORS[category] || ANSI.white;
        const cat = category.padEnd(6);
        const prefix = `${ANSI.dim}${time}${ANSI.reset} ${color}${ANSI.bold}${cat}${ANSI.reset} ${ANSI.dim}│${ANSI.reset}`;
        if (data !== undefined) console.log(`${prefix} ${msg}`, data);
        else console.log(`${prefix} ${msg}`);
    }
}

// ─── Gemini AI (required) ───
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
if (!GEMINI_API_KEY) {
    console.error('\n  ERROR: GEMINI_API_KEY is required.\n  Get a free key from https://aistudio.google.com\n  Then run: GEMINI_API_KEY=your-key npm start\n  Or add it to your .env file.\n');
    process.exit(1);
}

// ─── Redis (required) ───
let Redis;
try { Redis = require('ioredis'); } catch { Redis = null; }

if (!Redis) {
    console.error('\n  ERROR: ioredis package is missing.\n  Run: npm install\n');
    process.exit(1);
}

if (!process.env.REDIS_HOST) {
    console.error('\n  ERROR: REDIS_HOST is required.\n  Redis is needed for username uniqueness, room sync, and scaling.\n\n  Quick start (local):  REDIS_HOST=127.0.0.1 npm start\n  Or add to your .env:  REDIS_HOST=127.0.0.1\n\n  Free hosted Redis:    https://upstash.com (no credit card)\n');
    process.exit(1);
}

let redis = null;
let redisSub = null;
let redisReady = false;

async function initRedis() {
    const opts = {
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        tls: process.env.REDIS_TLS !== 'false' ? {} : undefined,
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 1000, 30000),
    };
    redis = new Redis(opts);
    redisSub = new Redis(opts);

    redis.on('ready', () => { redisReady = true; log('REDIS', 'Connected'); });
    redis.on('error', () => { if (redisReady) { redisReady = false; log('REDIS', 'Connection lost'); } });
    redis.on('close', () => { redisReady = false; });

    redisSub.on('error', (err) => { log('REDIS', 'Subscriber error: ' + err.message); });
    redisSub.on('message', handleRedisMessage);

    try {
        await redis.connect();
        await redisSub.connect();
    } catch (err) {
        console.error('\n  ERROR: Could not connect to Redis at ' + process.env.REDIS_HOST + ':' + (process.env.REDIS_PORT || '6379') + '\n  ' + err.message + '\n\n  Make sure Redis is running:\n    macOS:   brew services start redis\n    Linux:   sudo systemctl start redis\n    Docker:  docker run -p 6379:6379 redis\n');
        process.exit(1);
    }
}

function publishToRedis(channel, data) {
    if (!redisReady || !redis) return;
    try { redis.publish(channel, JSON.stringify({ source: INSTANCE_ID, data })); } catch {}
}

function subscribeRoom(type, code) {
    if (!redisSub) return;
    try { redisSub.subscribe('jsos:' + type + ':' + code); } catch {}
}

function unsubscribeRoom(type, code) {
    if (!redisSub) return;
    try { redisSub.unsubscribe('jsos:' + type + ':' + code); } catch {}
}

function handleRedisMessage(channel, message) {
    try {
        const parsed = JSON.parse(message);
        if (parsed.source === INSTANCE_ID) return; // Ignore own messages

        if (channel.startsWith('jsos:chat:')) {
            const code = channel.slice('jsos:chat:'.length);
            broadcastLocal(code, parsed.data);
        } else if (channel.startsWith('jsos:call:')) {
            const code = channel.slice('jsos:call:'.length);
            const room = callRooms.get(code);
            if (!room) return;
            if (parsed.data._targetPeerId) {
                // Targeted signal — find specific peer
                for (const client of room.clients) {
                    if (client.peerId === parsed.data._targetPeerId && client.readyState === 1) {
                        const { _targetPeerId, ...payload } = parsed.data;
                        client.send(JSON.stringify(payload));
                        break;
                    }
                }
            } else {
                // Broadcast to all local call clients
                const data = JSON.stringify(parsed.data);
                for (const client of room.clients) {
                    if (client.readyState === 1) client.send(data);
                }
            }
        }
    } catch {}
}

// ─── Rate Limiter (Token Bucket) ───
class RateLimiter {
    constructor() {
        this.buckets = new Map();
        this._gc = setInterval(() => {
            const cutoff = Date.now() - 10 * 60 * 1000;
            for (const [key, b] of this.buckets) {
                if (b.lastAccess < cutoff) this.buckets.delete(key);
            }
        }, 5 * 60 * 1000);
    }

    consume(ip, type) {
        const cfg = RateLimiter.CONFIGS[type];
        const key = ip + ':' + type;
        let b = this.buckets.get(key);
        if (!b) {
            b = { tokens: cfg.max, lastRefill: Date.now(), lastAccess: Date.now() };
            this.buckets.set(key, b);
        }
        const now = Date.now();
        const elapsed = (now - b.lastRefill) / 1000;
        b.tokens = Math.min(cfg.max, b.tokens + elapsed * cfg.refillRate);
        b.lastRefill = now;
        b.lastAccess = now;
        if (b.tokens >= 1) { b.tokens--; return true; }
        return false;
    }

    destroy() { clearInterval(this._gc); }
}

RateLimiter.CONFIGS = {
    http: { max: 100, refillRate: 100 / 60 },  // 100 req/min
    ws:   { max: 30,  refillRate: 30 },          // 30 msg/sec
    conn: { max: 10,  refillRate: 10 / 60 },     // 10 conn/min
};

// ─── Connection Tracker ───
class ConnectionTracker {
    constructor() {
        this.total = 0;
        this.perIP = new Map();
    }
    add(ip) {
        this.total++;
        this.perIP.set(ip, (this.perIP.get(ip) || 0) + 1);
    }
    remove(ip) {
        this.total = Math.max(0, this.total - 1);
        const count = (this.perIP.get(ip) || 1) - 1;
        if (count <= 0) this.perIP.delete(ip);
        else this.perIP.set(ip, count);
    }
    canConnect(ip) {
        if (this.total >= MAX_CONNECTIONS) return { ok: false, reason: 'Server at capacity' };
        if ((this.perIP.get(ip) || 0) >= MAX_PER_IP) return { ok: false, reason: 'Too many connections from your IP' };
        return { ok: true };
    }
}

// ─── Helpers ───
function getClientIP(req) {
    if (TRUST_PROXY) {
        const xff = req.headers['x-forwarded-for'];
        if (xff) return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress;
}

function validateUsername(name) {
    if (!name || typeof name !== 'string') return { ok: false, error: 'Username is required' };
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'Username is required' };
    if (!USERNAME_RE.test(trimmed)) return { ok: false, error: 'Username must be 1-20 chars (letters, numbers, spaces, _, -)' };
    return { ok: true, value: trimmed };
}

function safeSend(ws, data) {
    try { if (ws.readyState === 1) ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch {}
}

const rateLimiter = new RateLimiter();
const connTracker = new ConnectionTracker();

// ─── Rooms (shared by chat + call) ───
const rooms = new Map();
const callRooms = new Map();

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < MAX_CODEGEN_ATTEMPTS; attempt++) {
        let code = '';
        for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
        if (!rooms.has(code) && !callRooms.has(code)) return code;
    }
    return null;
}

// Username uniqueness — Redis keys with TTL (auto-expire if server crashes)
const USERNAME_TTL = 7200; // 2 hours — refreshed by heartbeat

async function tryClaimUsername(name) {
    const lower = name.toLowerCase();
    if (redisReady && redis) {
        try {
            const result = await redis.set('jsos:user:' + lower, INSTANCE_ID, 'EX', USERNAME_TTL, 'NX');
            return result === 'OK';
        } catch {}
    }
    // Fallback: local check
    for (const room of rooms.values()) {
        for (const c of room.clients) {
            if (c.username && c.username.toLowerCase() === lower) return false;
        }
    }
    for (const room of callRooms.values()) {
        for (const c of room.clients) {
            if (c.username && c.username.toLowerCase() === lower) return false;
        }
    }
    return true;
}

async function removeUsername(name) {
    if (redisReady && redis) {
        try { await redis.del('jsos:user:' + name.toLowerCase()); } catch {}
    }
}

// Refresh TTL for all active usernames (called by heartbeat)
async function refreshUsernameTTLs() {
    if (!redisReady || !redis) return;
    const pipeline = redis.pipeline();
    for (const room of rooms.values()) {
        for (const c of room.clients) {
            if (c.username) pipeline.expire('jsos:user:' + c.username.toLowerCase(), USERNAME_TTL);
        }
    }
    for (const room of callRooms.values()) {
        for (const c of room.clients) {
            if (c.username) pipeline.expire('jsos:user:' + c.username.toLowerCase(), USERNAME_TTL);
        }
    }
    try { await pipeline.exec(); } catch (err) { log('REDIS', 'Pipeline error: ' + err.message); }
}

// ─── HTTP Server ───
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.mp3': 'audio/mpeg',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
};

// ─── JSTube: YouTube search scraper ───
async function youtubeSearch(query) {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&sp=EgIQAQ%3D%3D';
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(10000),
    });
    const html = await response.text();
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s);
    if (!match) return [];

    const data = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
    if (!contents) return [];

    return contents.filter(c => c.videoRenderer).map(c => {
        const v = c.videoRenderer;
        return {
            videoId: v.videoId,
            title: v.title?.runs?.[0]?.text || '',
            channel: v.ownerText?.runs?.[0]?.text || '',
            views: v.viewCountText?.simpleText || v.viewCountText?.runs?.[0]?.text || '',
            published: v.publishedTimeText?.simpleText || '',
            duration: v.lengthText?.simpleText || 'LIVE',
            thumbnail: 'https://i.ytimg.com/vi/' + v.videoId + '/mqdefault.jpg',
        };
    }).slice(0, 20);
}

const server = http.createServer(async (req, res) => {
    const ip = getClientIP(req);

    // ─── Rate limit HTTP requests ───
    if (!rateLimiter.consume(ip, 'http')) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }));
        return;
    }

    // ─── Health endpoint ───
    if (req.url === '/health') {
        const health = {
            status: 'ok',
            uptime: Math.floor(process.uptime()),
            instance: INSTANCE_ID,
            connections: connTracker.total,
            connectionsPerIP: connTracker.perIP.size,
            chatRooms: rooms.size,
            callRooms: callRooms.size,
            memory: {
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
                heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            },
            redis: redisReady,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
    }

    // ─── JSTube API ───
    if (req.url.startsWith('/api/search?')) {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const query = params.get('q');
        if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing q parameter' }));
            return;
        }
        if (query.length > MAX_SEARCH_QUERY) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Query too long' }));
            return;
        }
        try {
            log('JSTUBE', `Searching: ${query}`);
            const results = await youtubeSearch(query);
            log('JSTUBE', `Found ${results.length} results for "${query}"`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
        } catch (err) {
            log('JSTUBE', `Search error: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // ─── AI Status ───
    if (req.url === '/api/ai/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', model: GEMINI_MODEL }));
        return;
    }

    // ─── AI Chat (streaming SSE via Gemini API) ───
    if (req.url === '/api/ai/chat' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
            if (body.length > MAX_BODY_SIZE) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request body too large' }));
                return;
            }
        }
        let parsed;
        try { parsed = JSON.parse(body); } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }
        const { messages } = parsed;
        if (!messages || !Array.isArray(messages)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'messages array required' }));
            return;
        }
        log('AI', `Chat: ${messages.length} messages, model=${GEMINI_MODEL}`);

        // Convert messages to Gemini format
        const geminiContents = messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        try {
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;
            const geminiRes = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: geminiContents }),
                signal: AbortSignal.timeout(60000),
            });

            if (!geminiRes.ok) {
                const err = await geminiRes.text();
                throw new Error('Gemini API error: ' + geminiRes.status + ' ' + err.slice(0, 200));
            }

            // Stream Gemini SSE response to client
            const reader = geminiRes.body;
            let buffer = '';
            for await (const chunk of reader) {
                if (res.destroyed) break;
                buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6).trim();
                    if (!payload) continue;
                    try {
                        const data = JSON.parse(payload);
                        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        if (text) res.write('data: ' + JSON.stringify({ content: text }) + '\n\n');
                    } catch {}
                }
            }
            res.write('data: [DONE]\n\n');
            res.end();
            log('AI', 'Chat response completed');
        } catch (err) {
            log('AI', 'Chat error: ' + err.message);
            res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n');
            res.end();
        }
        return;
    }

    // ─── Static Files ───
    const publicDir = path.join(__dirname, 'public');
    let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const resolved = path.resolve(publicDir, '.' + filePath);
    if (!resolved.startsWith(publicDir + path.sep) && resolved !== publicDir) {
        log('HTTP', `403 ${req.method} ${req.url} (path traversal blocked)`);
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(resolved);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(resolved, (err, data) => {
        if (err) {
            log('HTTP', `404 ${req.method} ${req.url}`);
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        log('HTTP', `200 ${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

// ─── WebSocket Servers ───
const chatWss = new WebSocketServer({ noServer: true });
const callWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const ip = getClientIP(req);

    // Rate limit new connections
    if (!rateLimiter.consume(ip, 'conn')) {
        log('WS', `Connection from ${ip} rate limited`);
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
    }

    // Check connection limits
    const check = connTracker.canConnect(ip);
    if (!check.ok) {
        log('WS', `Connection from ${ip} rejected: ${check.reason}`);
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
    }

    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/call') {
        log('WS', 'Upgrade request → call');
        callWss.handleUpgrade(req, socket, head, (ws) => {
            ws._clientIP = ip;
            connTracker.add(ip);
            callWss.emit('connection', ws, req);
        });
    } else {
        log('WS', 'Upgrade request → chat');
        chatWss.handleUpgrade(req, socket, head, (ws) => {
            ws._clientIP = ip;
            connTracker.add(ip);
            chatWss.emit('connection', ws, req);
        });
    }
});

// ─── Chat connections ───
chatWss.on('connection', (ws) => {
    ws.roomCode = null;
    ws.username = null;
    ws.isAlive = true;
    log('CHAT', 'New client connected');

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        // Size limit
        if (data.length > MAX_WS_MESSAGE) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Message too large' }));
            return;
        }
        // Rate limit WS messages
        if (!rateLimiter.consume(ws._clientIP, 'ws')) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Slow down! You\'re sending messages too fast.' }));
            return;
        }

        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === 'create') {
            const v = validateUsername(msg.username);
            if (!v.ok) { safeSend(ws, JSON.stringify({ type: 'error', message: v.error })); return; }
            msg.username = v.value;
            if (rooms.size + callRooms.size >= MAX_ROOMS) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Server at room capacity. Try again later.' }));
                return;
            }
            if (!(await tryClaimUsername(msg.username))) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Username "' + msg.username + '" is already in use.' }));
                log('CHAT', `${msg.username} rejected — name already in use globally`);
                return;
            }
            const code = generateCode();
            if (!code) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Could not create room. Try again.' }));
                await removeUsername(msg.username);
                return;
            }
            rooms.set(code, { clients: new Set([ws]), messages: [] });
            ws.roomCode = code;
            ws.username = msg.username;
            subscribeRoom('chat', code);
            safeSend(ws, JSON.stringify({ type: 'joined', code }));
            broadcastUsers(code);
            log('CHAT', `${msg.username} created room ${code} (${rooms.size} active rooms)`);
        }

        else if (msg.type === 'join') {
            const v = validateUsername(msg.username);
            if (!v.ok) { safeSend(ws, JSON.stringify({ type: 'error', message: v.error })); return; }
            msg.username = v.value;
            const code = (msg.code || '').toUpperCase();
            if (!ROOM_CODE_RE.test(code)) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid room code format' }));
                return;
            }
            const room = rooms.get(code);
            if (!room) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Room not found' }));
                log('CHAT', `${msg.username} tried to join ${code} — not found`);
                return;
            }
            if (!(await tryClaimUsername(msg.username))) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Username "' + msg.username + '" is already in use.' }));
                log('CHAT', `${msg.username} rejected from ${code} — name already in use globally`);
                return;
            }
            room.clients.add(ws);
            ws.roomCode = code;
            ws.username = msg.username;
            safeSend(ws, JSON.stringify({ type: 'joined', code, history: room.messages }));
            broadcast(code, { type: 'system', message: msg.username + ' joined the room' });
            broadcastUsers(code);
            log('CHAT', `${msg.username} joined room ${code} (${room.clients.size} users)`);
        }

        else if (msg.type === 'message') {
            if (!ws.roomCode || !ws.username) return;
            const room = rooms.get(ws.roomCode);
            if (!room) return;
            const text = (typeof msg.message === 'string') ? msg.message : '';
            if (text.length > MAX_MSG_TEXT) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Message too long (max 10000 chars)' }));
                return;
            }
            let image = null;
            if (msg.image) {
                if (typeof msg.image !== 'string' || msg.image.length > MAX_MSG_IMAGE) {
                    safeSend(ws, JSON.stringify({ type: 'error', message: 'Image too large' }));
                    return;
                }
                image = msg.image;
            }
            if (!text && !image) return;
            const chatMsg = { type: 'message', username: ws.username, message: text, image };
            room.messages.push(chatMsg);
            if (room.messages.length > MSG_HISTORY_CAP) room.messages.shift();
            broadcast(ws.roomCode, chatMsg);
            log('CHAT', `[${ws.roomCode}] ${ws.username}: ${image ? '[image]' : text}`);
        }
    });

    ws.on('close', async () => {
        connTracker.remove(ws._clientIP);
        if (!ws.roomCode) {
            log('CHAT', 'Client disconnected (no room)');
            return;
        }
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        room.clients.delete(ws);
        log('CHAT', `${ws.username} left room ${ws.roomCode} (${room.clients.size} remaining)`);
        if (ws.username) {
            await removeUsername(ws.username);
            broadcast(ws.roomCode, { type: 'system', message: ws.username + ' left the room' });
            broadcastUsers(ws.roomCode);
        }
        if (room.clients.size === 0) {
            rooms.delete(ws.roomCode);
            unsubscribeRoom('chat', ws.roomCode);
            log('CHAT', `Room ${ws.roomCode} deleted (empty) — ${rooms.size} active rooms`);
        }
    });
});

// ─── Call signaling connections ───
let nextPeerId = 1;

callWss.on('connection', (ws) => {
    ws.peerId = INSTANCE_ID + '-' + (nextPeerId++);
    ws.callRoom = null;
    ws.username = null;
    ws.muted = false;
    ws.isAlive = true;
    log('CALL', `Peer ${ws.peerId} connected`);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        if (data.length > MAX_WS_MESSAGE) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Message too large' }));
            return;
        }
        if (!rateLimiter.consume(ws._clientIP, 'ws')) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'Slow down! Too many messages.' }));
            return;
        }

        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === 'create-call') {
            const v = validateUsername(msg.username);
            if (!v.ok) { safeSend(ws, JSON.stringify({ type: 'error', message: v.error })); return; }
            msg.username = v.value;
            if (rooms.size + callRooms.size >= MAX_ROOMS) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Server at room capacity. Try again later.' }));
                return;
            }
            if (!(await tryClaimUsername(msg.username))) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Username "' + msg.username + '" is already in use.' }));
                log('CALL', `${msg.username} rejected — name already in use globally`);
                return;
            }
            const code = generateCode();
            if (!code) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Could not create room. Try again.' }));
                await removeUsername(msg.username);
                return;
            }
            callRooms.set(code, { clients: new Set([ws]) });
            ws.callRoom = code;
            ws.username = msg.username;
            subscribeRoom('call', code);
            safeSend(ws, JSON.stringify({ type: 'call-joined', code, peerId: ws.peerId }));
            broadcastCallUsers(code);
            log('CALL', `${msg.username} created call room ${code}`);
        }

        else if (msg.type === 'join-call') {
            const v = validateUsername(msg.username);
            if (!v.ok) { safeSend(ws, JSON.stringify({ type: 'error', message: v.error })); return; }
            msg.username = v.value;
            const code = (msg.code || '').toUpperCase();
            if (!ROOM_CODE_RE.test(code)) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid room code format' }));
                return;
            }
            const room = callRooms.get(code);
            if (!room) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Call room not found' }));
                return;
            }
            if (!(await tryClaimUsername(msg.username))) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'Username "' + msg.username + '" is already in use.' }));
                return;
            }
            ws.callRoom = code;
            ws.username = msg.username;

            // Tell the new peer about all existing peers
            const existingPeers = [...room.clients].map(c => ({ peerId: c.peerId, username: c.username }));
            safeSend(ws, JSON.stringify({ type: 'call-joined', code, peerId: ws.peerId, peers: existingPeers }));

            // Tell existing peers about the new peer (local + Redis)
            const joinMsg = { type: 'peer-joined', peerId: ws.peerId, username: msg.username };
            for (const client of room.clients) {
                if (client.readyState === 1) client.send(JSON.stringify(joinMsg));
            }
            publishToRedis('jsos:call:' + code, joinMsg);

            room.clients.add(ws);
            broadcastCallUsers(code);
            log('CALL', `${msg.username} joined call ${code} (${room.clients.size} peers)`);
        }

        else if (msg.type === 'signal') {
            if (!ws.callRoom) return;
            const signalStr = JSON.stringify(msg.signal || {});
            if (signalStr.length > MAX_SIGNAL_SIZE) return;
            const room = callRooms.get(ws.callRoom);
            if (!room) return;
            const signalMsg = { type: 'signal', from: ws.peerId, signal: msg.signal };
            let found = false;
            for (const client of room.clients) {
                if (client.peerId === msg.to && client.readyState === 1) {
                    client.send(JSON.stringify(signalMsg));
                    found = true;
                    break;
                }
            }
            if (!found) {
                publishToRedis('jsos:call:' + ws.callRoom, { ...signalMsg, _targetPeerId: msg.to });
            }
        }

        else if (msg.type === 'mute') {
            ws.muted = !!msg.muted;
            if (ws.callRoom) broadcastCallUsers(ws.callRoom);
            log('CALL', `${ws.username} ${ws.muted ? 'muted' : 'unmuted'}`);
        }
    });

    ws.on('close', async () => {
        connTracker.remove(ws._clientIP);
        if (!ws.callRoom) return;
        const room = callRooms.get(ws.callRoom);
        if (!room) return;
        room.clients.delete(ws);
        if (ws.username) await removeUsername(ws.username);
        log('CALL', `${ws.username} left call ${ws.callRoom} (${room.clients.size} remaining)`);

        // Tell remaining peers (local + Redis)
        const leftMsg = { type: 'peer-left', peerId: ws.peerId };
        for (const client of room.clients) {
            if (client.readyState === 1) client.send(JSON.stringify(leftMsg));
        }
        publishToRedis('jsos:call:' + ws.callRoom, leftMsg);
        broadcastCallUsers(ws.callRoom);

        if (room.clients.size === 0) {
            callRooms.delete(ws.callRoom);
            unsubscribeRoom('call', ws.callRoom);
            log('CALL', `Call room ${ws.callRoom} deleted (empty)`);
        }
    });
});

// ─── Broadcast helpers ───
// Max buffered bytes before skipping a slow client (1MB)
const MAX_BUFFERED = 1024 * 1024;

// broadcastLocal sends only to clients on THIS instance (used by Redis handler)
function broadcastLocal(code, msg) {
    const room = rooms.get(code);
    if (!room) return;
    const data = JSON.stringify(msg);
    for (const client of room.clients) {
        if (client.readyState === 1 && client.bufferedAmount < MAX_BUFFERED) client.send(data);
    }
}

// broadcast sends to local clients AND publishes to Redis for other instances
function broadcast(code, msg) {
    broadcastLocal(code, msg);
    publishToRedis('jsos:chat:' + code, msg);
}

function broadcastUsers(code) {
    const room = rooms.get(code);
    if (!room) return;
    const users = [...room.clients].filter(c => c.username).map(c => c.username);
    broadcast(code, { type: 'users', users });
}

function broadcastCallUsers(code) {
    const room = callRooms.get(code);
    if (!room) return;
    const users = [...room.clients].filter(c => c.username).map(c => ({
        username: c.username,
        peerId: c.peerId,
        muted: c.muted,
    }));
    const msg = { type: 'call-users', users };
    const data = JSON.stringify(msg);
    for (const client of room.clients) {
        if (client.readyState === 1 && client.bufferedAmount < MAX_BUFFERED) client.send(data);
    }
    publishToRedis('jsos:call:' + code, msg);
}

// ─── Heartbeat (ping/pong every 30s, kill dead connections, refresh Redis TTLs) ───
let _heartbeatCount = 0;
const heartbeat = setInterval(() => {
    for (const wss of [chatWss, callWss]) {
        for (const ws of wss.clients) {
            if (ws.isAlive === false) {
                log('WS', 'Terminating dead connection');
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            if (ws.readyState === 1) ws.ping();
        }
    }
    // Refresh username TTLs every 10th heartbeat (~5 min) to save Redis commands
    if (++_heartbeatCount % 10 === 0) refreshUsernameTTLs();
}, HEARTBEAT_MS);

// ─── Graceful shutdown ───
async function gracefulShutdown(signal) {
    log('SERVER', `${signal} received — shutting down gracefully`);

    // Stop heartbeat
    clearInterval(heartbeat);
    rateLimiter.destroy();

    // Close all WebSocket connections
    for (const wss of [chatWss, callWss]) {
        for (const ws of wss.clients) {
            ws.close(1001, 'Server shutting down');
        }
    }

    // Close HTTP server (stop accepting new connections)
    server.close();

    // Disconnect Redis
    if (redis) { try { await redis.quit(); } catch {} }
    if (redisSub) { try { await redisSub.quit(); } catch {} }

    log('SERVER', 'Shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Start ───
initRedis().then(() => {
    server.listen(PORT, () => {
        const Y = ANSI.yellow, G = ANSI.green, D = ANSI.dim, R = ANSI.reset, B = ANSI.bold;
        console.log('');
        console.log(`  ${Y}╔═══════════════════════════════════════╗${R}`);
        console.log(`  ${Y}║${R}       ${Y}${B}{ }${R}  ${B}JS OS Server${R}              ${Y}║${R}`);
        console.log(`  ${Y}╠═══════════════════════════════════════╣${R}`);
        console.log(`  ${Y}║${R}  ${D}URL${R}       ${G}http://localhost:${PORT}${R}${' '.repeat(Math.max(0, 5 - String(PORT).length))}    ${Y}║${R}`);
        console.log(`  ${Y}║${R}  ${D}Node${R}      ${process.version.padEnd(26)}${Y}║${R}`);
        console.log(`  ${Y}║${R}  ${D}OS${R}        ${(os.platform() + ' ' + os.arch()).padEnd(26)}${Y}║${R}`);
        console.log(`  ${Y}║${R}  ${D}Instance${R}  ${INSTANCE_ID.padEnd(26)}${Y}║${R}`);
        console.log(`  ${Y}║${R}  ${D}Redis${R}     ${(redisReady ? G + 'connected' : D + 'standalone').padEnd(35)}${R}${Y}║${R}`);
        console.log(`  ${Y}╚═══════════════════════════════════════╝${R}`);
        console.log('');
        log('SERVER', 'Ready and waiting for connections');
    });
});
