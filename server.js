const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');
const os = require('os');

const PORT = 8080;

// ─── Logger ───
function log(category, msg, data) {
    const time = new Date().toLocaleTimeString();
    const prefix = `[${time}] [${category}]`;
    if (data !== undefined) console.log(`${prefix} ${msg}`, data);
    else console.log(`${prefix} ${msg}`);
}

// ─── Rooms (shared by chat + call) ───
const rooms = new Map();
const callRooms = new Map();

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

// Check if username is taken globally (across all chat + call rooms)
function isUsernameTaken(name) {
    const lower = name.toLowerCase();
    for (const room of rooms.values()) {
        for (const c of room.clients) {
            if (c.username && c.username.toLowerCase() === lower) return true;
        }
    }
    for (const room of callRooms.values()) {
        for (const c of room.clients) {
            if (c.username && c.username.toLowerCase() === lower) return true;
        }
    }
    return false;
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
    // ─── JSTube API ───
    if (req.url.startsWith('/api/search?')) {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const query = params.get('q');
        if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing q parameter' }));
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

    // ─── Static Files ───
    let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    filePath = path.join(__dirname, 'public', filePath);

    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
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
const termWss = new WebSocketServer({ noServer: true });
const callWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/terminal') {
        log('WS', 'Upgrade request → terminal');
        termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, req));
    } else if (url.pathname === '/call') {
        log('WS', 'Upgrade request → call');
        callWss.handleUpgrade(req, socket, head, (ws) => callWss.emit('connection', ws, req));
    } else {
        log('WS', 'Upgrade request → chat');
        chatWss.handleUpgrade(req, socket, head, (ws) => chatWss.emit('connection', ws, req));
    }
});

// ─── Chat connections ───
chatWss.on('connection', (ws) => {
    ws.roomCode = null;
    ws.username = null;
    log('CHAT', 'New client connected');

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === 'create') {
            if (isUsernameTaken(msg.username)) {
                ws.send(JSON.stringify({ type: 'error', message: 'Username "' + msg.username + '" is already in use.' }));
                log('CHAT', `${msg.username} rejected — name already in use globally`);
                return;
            }
            let code = generateCode();
            while (rooms.has(code) || callRooms.has(code)) code = generateCode();
            rooms.set(code, { clients: new Set([ws]), messages: [] });
            ws.roomCode = code;
            ws.username = msg.username;
            ws.send(JSON.stringify({ type: 'joined', code }));
            broadcastUsers(code);
            log('CHAT', `${msg.username} created room ${code} (${rooms.size} active rooms)`);
        }

        else if (msg.type === 'join') {
            const code = (msg.code || '').toUpperCase();
            const room = rooms.get(code);
            if (!room) {
                ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
                log('CHAT', `${msg.username} tried to join ${code} — not found`);
                return;
            }
            if (isUsernameTaken(msg.username)) {
                ws.send(JSON.stringify({ type: 'error', message: 'Username "' + msg.username + '" is already in use.' }));
                log('CHAT', `${msg.username} rejected from ${code} — name already in use globally`);
                return;
            }
            room.clients.add(ws);
            ws.roomCode = code;
            ws.username = msg.username;
            ws.send(JSON.stringify({ type: 'joined', code, history: room.messages }));
            broadcast(code, { type: 'system', message: msg.username + ' joined the room' });
            broadcastUsers(code);
            log('CHAT', `${msg.username} joined room ${code} (${room.clients.size} users)`);
        }

        else if (msg.type === 'message') {
            if (!ws.roomCode || !ws.username) return;
            const room = rooms.get(ws.roomCode);
            if (!room) return;
            const chatMsg = { type: 'message', username: ws.username, message: msg.message, image: msg.image || null };
            room.messages.push(chatMsg);
            broadcast(ws.roomCode, chatMsg);
            log('CHAT', `[${ws.roomCode}] ${ws.username}: ${msg.image ? '[image]' : msg.message}`);
        }
    });

    ws.on('close', () => {
        if (!ws.roomCode) {
            log('CHAT', 'Client disconnected (no room)');
            return;
        }
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        room.clients.delete(ws);
        log('CHAT', `${ws.username} left room ${ws.roomCode} (${room.clients.size} remaining)`);
        if (ws.username) {
            broadcast(ws.roomCode, { type: 'system', message: ws.username + ' left the room' });
            broadcastUsers(ws.roomCode);
        }
        if (room.clients.size === 0) {
            rooms.delete(ws.roomCode);
            log('CHAT', `Room ${ws.roomCode} deleted (empty) — ${rooms.size} active rooms`);
        }
    });
});

// ─── Call signaling connections ───
let nextPeerId = 1;

callWss.on('connection', (ws) => {
    ws.peerId = nextPeerId++;
    ws.callRoom = null;
    ws.username = null;
    ws.muted = false;
    log('CALL', `Peer ${ws.peerId} connected`);

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === 'create-call') {
            if (isUsernameTaken(msg.username)) {
                ws.send(JSON.stringify({ type: 'error', message: 'Username "' + msg.username + '" is already in use.' }));
                log('CALL', `${msg.username} rejected — name already in use globally`);
                return;
            }
            let code = generateCode();
            while (rooms.has(code) || callRooms.has(code)) code = generateCode();
            callRooms.set(code, { clients: new Set([ws]) });
            ws.callRoom = code;
            ws.username = msg.username;
            ws.send(JSON.stringify({ type: 'call-joined', code, peerId: ws.peerId }));
            broadcastCallUsers(code);
            log('CALL', `${msg.username} created call room ${code}`);
        }

        else if (msg.type === 'join-call') {
            const code = (msg.code || '').toUpperCase();
            const room = callRooms.get(code);
            if (!room) {
                ws.send(JSON.stringify({ type: 'error', message: 'Call room not found' }));
                return;
            }
            if (isUsernameTaken(msg.username)) {
                ws.send(JSON.stringify({ type: 'error', message: 'Username "' + msg.username + '" is already in use.' }));
                return;
            }
            ws.callRoom = code;
            ws.username = msg.username;

            // Tell the new peer about all existing peers
            const existingPeers = [...room.clients].map(c => ({ peerId: c.peerId, username: c.username }));
            ws.send(JSON.stringify({ type: 'call-joined', code, peerId: ws.peerId, peers: existingPeers }));

            // Tell existing peers about the new peer
            for (const client of room.clients) {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({ type: 'peer-joined', peerId: ws.peerId, username: msg.username }));
                }
            }

            room.clients.add(ws);
            broadcastCallUsers(code);
            log('CALL', `${msg.username} joined call ${code} (${room.clients.size} peers)`);
        }

        else if (msg.type === 'signal') {
            // Relay WebRTC signaling to a specific peer
            const room = callRooms.get(ws.callRoom);
            if (!room) return;
            for (const client of room.clients) {
                if (client.peerId === msg.to && client.readyState === 1) {
                    client.send(JSON.stringify({ type: 'signal', from: ws.peerId, signal: msg.signal }));
                    break;
                }
            }
        }

        else if (msg.type === 'mute') {
            ws.muted = !!msg.muted;
            if (ws.callRoom) broadcastCallUsers(ws.callRoom);
            log('CALL', `${ws.username} ${ws.muted ? 'muted' : 'unmuted'}`);
        }
    });

    ws.on('close', () => {
        if (!ws.callRoom) return;
        const room = callRooms.get(ws.callRoom);
        if (!room) return;
        room.clients.delete(ws);
        log('CALL', `${ws.username} left call ${ws.callRoom} (${room.clients.size} remaining)`);

        // Tell remaining peers
        for (const client of room.clients) {
            if (client.readyState === 1) {
                client.send(JSON.stringify({ type: 'peer-left', peerId: ws.peerId }));
            }
        }
        broadcastCallUsers(ws.callRoom);

        if (room.clients.size === 0) {
            callRooms.delete(ws.callRoom);
            log('CALL', `Call room ${ws.callRoom} deleted (empty)`);
        }
    });
});

// ─── Terminal connections ───
const defaultShell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';

termWss.on('connection', (ws) => {
    let shell;
    try {
        shell = pty.spawn(defaultShell, ['--login'], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: os.homedir(),
            env: Object.assign({}, process.env, {
                TERM: 'xterm-256color',
                HOME: os.homedir(),
                npm_config_prefix: '',
            }),
        });
        log('TERM', `Shell spawned (PID ${shell.pid}, shell: ${defaultShell})`);
    } catch (err) {
        log('TERM', `Failed to spawn shell: ${err.message}`);
        ws.send('\r\nFailed to start terminal: ' + err.message + '\r\n');
        ws.close();
        return;
    }

    shell.onData((data) => {
        if (ws.readyState === 1) ws.send(data);
    });

    ws.on('message', (data) => {
        const msg = data.toString();
        if (msg.startsWith('\x01')) {
            try {
                const size = JSON.parse(msg.slice(1));
                shell.resize(size.cols, size.rows);
                log('TERM', `PID ${shell.pid} resized to ${size.cols}x${size.rows}`);
            } catch {}
            return;
        }
        shell.write(msg);
    });

    ws.on('close', () => {
        log('TERM', `Client disconnected, killing PID ${shell.pid}`);
        shell.kill();
    });

    shell.onExit(({ exitCode }) => {
        log('TERM', `Shell PID ${shell.pid} exited (code ${exitCode})`);
        if (ws.readyState === 1) ws.close();
    });
});

// ─── Broadcast helpers ───
function broadcast(code, msg) {
    const room = rooms.get(code);
    if (!room) return;
    const data = JSON.stringify(msg);
    for (const client of room.clients) {
        if (client.readyState === 1) client.send(data);
    }
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
    const data = JSON.stringify({ type: 'call-users', users });
    for (const client of room.clients) {
        if (client.readyState === 1) client.send(data);
    }
}

// ─── Start ───
server.listen(PORT, () => {
    console.log('');
    console.log('  ╔═══════════════════════════════════╗');
    console.log('  ║          { } JS OS Server          ║');
    console.log('  ╠═══════════════════════════════════╣');
    console.log(`  ║  URL:    http://localhost:${PORT}     ║`);
    console.log(`  ║  Shell:  ${defaultShell.padEnd(24)}║`);
    console.log(`  ║  Node:   ${process.version.padEnd(24)}║`);
    console.log(`  ║  OS:     ${(os.platform() + ' ' + os.arch()).padEnd(24)}║`);
    console.log('  ╚═══════════════════════════════════╝');
    console.log('');
    log('SERVER', 'Ready and waiting for connections');
});
