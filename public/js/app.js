// ═══════════════════════════════════════════════════════════
//  JS OS — Full OOP Architecture
//  Logger → Utility classes → Client classes → BaseApp → App subclasses → Desktop
// ═══════════════════════════════════════════════════════════

// ─── Logger: single class for all client-side debug logging ───
class Logger {
    static LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, OFF: 4 };
    static COLORS = {
        DESKTOP: '#F7DF1E', WINDOW: '#c9b518', SOUND: '#c678dd', NOTIFY: '#61afef',
        CHAT: '#98c379', CALL: '#56b6c2', TERMINAL: '#e06c75', JSTUBE: '#c97a7a',
        WS: '#e0e0e0', WEBRTC: '#c678dd', IMAGE: '#F7DF1E', APP: '#F7DF1E',
    };

    constructor(level = Logger.LEVELS.DEBUG) {
        this._level = level;
        this._startTime = Date.now();
    }

    set level(l) { this._level = typeof l === 'string' ? (Logger.LEVELS[l.toUpperCase()] ?? 0) : l; }
    get level() { return this._level; }

    _format(category) {
        const elapsed = ((Date.now() - this._startTime) / 1000).toFixed(2);
        return [`%c[${elapsed}s] [${category}]`, `color: ${Logger.COLORS[category] || '#888'}; font-weight: bold`];
    }

    debug(category, ...args) { if (this._level <= 0) { const [fmt, css] = this._format(category); console.debug(fmt, css, ...args); } }
    info(category, ...args) { if (this._level <= 1) { const [fmt, css] = this._format(category); console.info(fmt, css, ...args); } }
    warn(category, ...args) { if (this._level <= 2) { const [fmt, css] = this._format(category); console.warn(fmt, css, ...args); } }
    error(category, ...args) { if (this._level <= 3) { const [fmt, css] = this._format(category); console.error(fmt, css, ...args); } }
}

// Global logger instance — change level to Logger.LEVELS.OFF to silence all
const log = new Logger(Logger.LEVELS.DEBUG);

// ─── Utility: SoundManager ───
class SoundManager {
    constructor() {
        this.sounds = {
            startup: document.getElementById('sound-startup'),
            notify: document.getElementById('sound-message'),
            window: document.getElementById('sound-window'),
        };
    }
    play(name) {
        const s = this.sounds[name];
        if (s) { s.currentTime = 0; s.play().catch(() => {}); log.debug('SOUND', 'Playing:', name); }
        else { log.warn('SOUND', 'Sound not found:', name); }
    }
}

// ─── Utility: NotificationManager ───
class NotificationManager {
    constructor() {
        this.swReg = null;
        this.enabled = true;
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').then(reg => this.swReg = reg);
        }
        this.pageVisible = true;
        document.addEventListener('visibilitychange', () => {
            this.pageVisible = document.visibilityState === 'visible';
        });
    }
    requestPermission() { if ('Notification' in window) { Notification.requestPermission(); log.info('NOTIFY', 'Permission requested'); } }
    notify(title, body, tag) {
        if (!this.enabled || this.pageVisible) return;
        if (!this.swReg || !this.swReg.active || Notification.permission !== 'granted') return;
        this.swReg.active.postMessage({ type: 'NOTIFY', title, body, tag });
        log.debug('NOTIFY', 'Sent:', title, '-', body);
    }
    chatMessage(username, text) { this.notify('JS Chat', username + ': ' + text, 'chat'); }
    terminalActivity(text) { this.notify('Terminal', text, 'terminal'); }
}

// ─── Utility: WindowManager ───
class WindowManager {
    constructor(sound) {
        this.sound = sound;
        this.windows = new Map();
    }
    register(id, el, opts = {}) {
        this.windows.set(id, el);
        const skip = opts.disableButtons || [];
        el.querySelectorAll('.window-btn[data-action]').forEach(btn => {
            if (skip.includes(btn.dataset.action)) return;
            btn.addEventListener('click', () => this.sound.play('window'));
        });
        log.debug('WINDOW', 'Registered:', id, skip.length ? '(disabled: ' + skip.join(',') + ')' : '');
    }
    open(id) {
        const el = this.windows.get(id);
        if (!el) { log.warn('WINDOW', 'Cannot open unknown window:', id); return; }
        el.classList.remove('closing');
        el.classList.add('opening', 'visible');
        el.style.display = 'block';
        log.info('WINDOW', 'Opened:', id);
    }
    close(id) {
        const el = this.windows.get(id);
        if (!el) { log.warn('WINDOW', 'Cannot close unknown window:', id); return; }
        return new Promise(resolve => {
            el.classList.remove('opening');
            el.classList.add('closing');
            el.addEventListener('animationend', () => {
                el.style.display = 'none';
                el.classList.remove('closing', 'visible');
                log.info('WINDOW', 'Closed:', id);
                resolve();
            }, { once: true });
        });
    }
}

// ═══════════════════════════════════════════════════════════
//  Client / Manager classes (protocol + feature logic, no UI)
// ═══════════════════════════════════════════════════════════

// ─── ChatClient (WebSocket) ───
class ChatClient {
    constructor(sound, notifications) {
        this.sound = sound;
        this.notifications = notifications;
        this.ws = null;
        this.username = '';
        this.roomCode = '';
        this.onJoined = null;
        this.onMessage = null;
        this.onSystem = null;
        this.onError = null;
        this.onDisconnect = null;
        this.onUsers = null;
    }
    connect(action, username, code) {
        this.username = username;
        log.info('CHAT', 'Connecting as', username, '(' + action + ')' + (code ? ' to ' + code : ''));
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(protocol + '//' + location.host);
        this.ws.onopen = () => {
            log.debug('WS', 'Chat WebSocket opened');
            if (action === 'create') this.ws.send(JSON.stringify({ type: 'create', username }));
            else this.ws.send(JSON.stringify({ type: 'join', username, code }));
        };
        this.ws.onmessage = (e) => this._handle(JSON.parse(e.data));
        this.ws.onclose = () => {
            log.info('WS', 'Chat WebSocket closed');
            if (!this._intentionalClose && this.onDisconnect) this.onDisconnect();
            this._intentionalClose = false;
        };
    }
    send(text, image) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'message', message: text, image: image || null }));
            log.debug('CHAT', 'Sent:', image ? '[image]' : text);
        }
    }
    disconnect() {
        this._intentionalClose = true;
        if (this.ws) { this.ws.close(); this.ws = null; }
        log.info('CHAT', 'Disconnected:', this.username);
        this.username = ''; this.roomCode = '';
    }
    _handle(msg) {
        log.debug('CHAT', 'Received:', msg.type, msg.type === 'message' ? '(' + msg.username + ')' : '');
        if (msg.type === 'joined') { this.roomCode = msg.code; log.info('CHAT', 'Joined room:', msg.code); if (this.onJoined) this.onJoined(msg.code, msg.history || []); }
        else if (msg.type === 'message') {
            if (this.onMessage) this.onMessage(msg.username, msg.message, msg.image);
            if (msg.username !== this.username && document.hidden) {
                this.sound.play('notify');
                this.notifications.chatMessage(msg.username, msg.message || '[image]');
            }
        }
        else if (msg.type === 'system') { if (this.onSystem) this.onSystem(msg.message); }
        else if (msg.type === 'users') { if (this.onUsers) this.onUsers(msg.users); }
        else if (msg.type === 'error') { if (this.onError) this.onError(msg.message); }
    }
}

// ─── CallClient (WebRTC + WebSocket signaling) ───
class CallClient {
    constructor() {
        this.ws = null; this.username = ''; this.roomCode = ''; this.peerId = null;
        this.muted = false; this.localStream = null; this.peers = new Map();
        this.onJoined = null; this.onUsers = null; this.onError = null; this.onDisconnect = null;
        this._intentionalClose = false;
    }
    async connect(action, username, code) {
        this.username = username;
        log.info('CALL', 'Connecting as', username, '(' + action + ')');
        try { this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); log.info('CALL', 'Microphone access granted'); }
        catch { log.error('CALL', 'Microphone access denied'); if (this.onError) this.onError('Microphone access denied.'); return; }
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(protocol + '//' + location.host + '/call');
        this.ws.onopen = () => {
            log.debug('WS', 'Call WebSocket opened');
            if (action === 'create') this.ws.send(JSON.stringify({ type: 'create-call', username }));
            else this.ws.send(JSON.stringify({ type: 'join-call', username, code }));
        };
        this.ws.onmessage = (e) => this._handle(JSON.parse(e.data));
        this.ws.onclose = () => { log.info('WS', 'Call WebSocket closed'); if (!this._intentionalClose && this.onDisconnect) this.onDisconnect(); this._intentionalClose = false; };
    }
    toggleMute() {
        this.muted = !this.muted;
        if (this.localStream) this.localStream.getAudioTracks().forEach(t => { t.enabled = !this.muted; });
        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'mute', muted: this.muted }));
        log.info('CALL', this.muted ? 'Muted' : 'Unmuted');
        return this.muted;
    }
    disconnect() {
        this._intentionalClose = true;
        log.info('CALL', 'Disconnecting, closing', this.peers.size, 'peer connections');
        for (const [, p] of this.peers) p.connection.close();
        this.peers.clear();
        if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null; }
        if (this.ws) { this.ws.close(); this.ws = null; }
        this.username = ''; this.roomCode = ''; this.peerId = null; this.muted = false;
    }
    _handle(msg) {
        log.debug('CALL', 'Signal received:', msg.type);
        if (msg.type === 'call-joined') {
            this.roomCode = msg.code; this.peerId = msg.peerId;
            log.info('CALL', 'Joined call room:', msg.code, '(peerId:', msg.peerId + ')', msg.peers ? 'with ' + msg.peers.length + ' existing peers' : '');
            if (this.onJoined) this.onJoined(msg.code);
            if (msg.peers) msg.peers.forEach(p => this._createPC(p.peerId, p.username, true));
        }
        else if (msg.type === 'signal') this._handleSignal(msg.from, msg.signal);
        else if (msg.type === 'peer-left') { const p = this.peers.get(msg.peerId); if (p) { p.connection.close(); this.peers.delete(msg.peerId); } }
        else if (msg.type === 'call-users') { if (this.onUsers) this.onUsers(msg.users); }
        else if (msg.type === 'error') { if (this.onError) this.onError(msg.message); }
    }
    _createPC(remotePeerId, remoteUsername, initiator) {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        if (this.localStream) this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
        pc.ontrack = (e) => { const a = new Audio(); a.srcObject = e.streams[0]; a.play().catch(() => {}); };
        pc.onicecandidate = (e) => { if (e.candidate && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'signal', to: remotePeerId, signal: { candidate: e.candidate } })); };
        this.peers.set(remotePeerId, { connection: pc, username: remoteUsername });
        log.debug('WEBRTC', 'Peer connection created for', remotePeerId, initiator ? '(initiator)' : '(responder)');
        if (initiator) pc.createOffer().then(o => { pc.setLocalDescription(o); this.ws.send(JSON.stringify({ type: 'signal', to: remotePeerId, signal: { sdp: o } })); log.debug('WEBRTC', 'Sent offer to', remotePeerId); });
        return pc;
    }
    async _handleSignal(from, signal) {
        const peer = this.peers.get(from);
        if (signal.sdp?.type === 'offer') {
            const pc = this._createPC(from, null, false);
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
            this.ws.send(JSON.stringify({ type: 'signal', to: from, signal: { sdp: ans } }));
        } else if (signal.sdp?.type === 'answer' && peer) { await peer.connection.setRemoteDescription(new RTCSessionDescription(signal.sdp)); }
        else if (signal.candidate && peer) { await peer.connection.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {}); }
    }
}

// ─── Terminal theme constant ───
const TERM_THEME = {
    background: '#1e1e1e', foreground: '#e0e0e0', cursor: '#F7DF1E', cursorAccent: '#1e1e1e',
    selectionBackground: 'rgba(247, 223, 30, 0.25)',
    black: '#1e1e1e', red: '#c97a7a', green: '#98c379', yellow: '#F7DF1E',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#e0e0e0',
    brightBlack: '#555', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#F7DF1E',
    brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
};

// ─── TerminalSessionManager (manages tabbed pty sessions) ───
class TerminalSessionManager {
    constructor(panesEl, tabsEl, newTabBtn) {
        this.panesEl = panesEl; this.tabsEl = tabsEl; this.newTabBtn = newTabBtn;
        this.sessions = new Map(); this._nextId = 1; this._activeId = null;
        this.newTabBtn.addEventListener('click', () => this.addTab());
    }
    open() { log.info('TERMINAL', 'Opening first tab'); this.addTab(); }
    addTab() {
        const id = this._nextId++; log.info('TERMINAL', 'Creating tab', id);
        const paneEl = document.createElement('div'); paneEl.className = 'terminal-pane'; this.panesEl.appendChild(paneEl);
        const tabEl = document.createElement('div'); tabEl.className = 'terminal-tab';
        tabEl.innerHTML = '<span class="terminal-tab-label">Shell ' + id + '</span><span class="terminal-tab-close">&times;</span>';
        this.tabsEl.insertBefore(tabEl, this.newTabBtn);
        tabEl.querySelector('.terminal-tab-label').addEventListener('click', () => this.switchTab(id));
        tabEl.querySelector('.terminal-tab-close').addEventListener('click', (e) => { e.stopPropagation(); this.closeTab(id); });
        const xterm = new window.Terminal({ theme: TERM_THEME, fontFamily: "'Courier New', monospace", fontSize: 14, cursorBlink: true, scrollback: 1000 });
        const fitAddon = new window.FitAddon.FitAddon(); xterm.loadAddon(fitAddon); xterm.open(paneEl);
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(protocol + '//' + location.host + '/terminal');
        ws.onopen = () => { const d = fitAddon.proposeDimensions(); if (d) ws.send('\x01' + JSON.stringify({ cols: d.cols, rows: d.rows })); };
        ws.onmessage = (e) => { xterm.write(e.data); };
        ws.onclose = () => { xterm.write('\r\n\x1b[33m[Connection closed]\x1b[0m\r\n'); };
        xterm.onData((data) => { if (ws?.readyState === 1) ws.send(data); });
        const ro = new ResizeObserver(() => { fitAddon.fit(); const d = fitAddon.proposeDimensions(); if (d && ws?.readyState === 1) ws.send('\x01' + JSON.stringify({ cols: d.cols, rows: d.rows })); });
        ro.observe(paneEl);
        this.sessions.set(id, { xterm, fitAddon, ws, paneEl, tabEl, ro }); this.switchTab(id); log.debug('TERMINAL', 'Tab', id, 'ready'); return id;
    }
    switchTab(id) {
        const s = this.sessions.get(id); if (!s) return;
        for (const [, v] of this.sessions) { v.paneEl.classList.remove('active'); v.tabEl.classList.remove('active'); }
        s.paneEl.classList.add('active'); s.tabEl.classList.add('active');
        this._activeId = id; s.fitAddon.fit(); s.xterm.focus();
    }
    closeTab(id) {
        const s = this.sessions.get(id); if (!s) return;
        log.info('TERMINAL', 'Closing tab', id);
        s.ro.disconnect(); if (s.ws) s.ws.close(); s.xterm.dispose(); s.paneEl.remove(); s.tabEl.remove(); this.sessions.delete(id);
        if (this._activeId === id) { const r = [...this.sessions.keys()]; if (r.length) this.switchTab(r[r.length - 1]); }
    }
    focus() { const s = this.sessions.get(this._activeId); if (s) s.xterm.focus(); }
    closeAll() { log.info('TERMINAL', 'Closing all', this.sessions.size, 'tabs'); for (const id of [...this.sessions.keys()]) this.closeTab(id); this._nextId = 1; }
}

// ─── JSTubeManager (YouTube search + embedded player) ───
class JSTubeManager {
    constructor(resultsEl, playerEl, videoEl, videoInfoEl, backBtn, searchForm, searchInput, statusEl) {
        this.resultsEl = resultsEl; this.playerEl = playerEl; this.videoEl = videoEl;
        this.videoInfoEl = videoInfoEl; this.statusEl = statusEl; this.searchInput = searchInput;
        this._iframe = null;
        searchForm.addEventListener('submit', (e) => { e.preventDefault(); const q = searchInput.value.trim(); if (q) this.search(q); });
        backBtn.addEventListener('click', () => this.showResults());
    }
    async search(query) {
        log.info('JSTUBE', 'Searching:', query);
        this.statusEl.textContent = 'Searching...';
        this.resultsEl.innerHTML = '<div class="jstube-loading">Searching for "' + query + '"...</div>';
        this.showResults();
        try {
            const r = await fetch('/api/search?q=' + encodeURIComponent(query));
            const results = await r.json();
            if (results.error) throw new Error(results.error);
            this.resultsEl.innerHTML = '';
            if (!results.length) { this.resultsEl.innerHTML = '<div class="jstube-placeholder">No results found</div>'; this.statusEl.textContent = 'No results'; return; }
            results.forEach(v => {
                const card = document.createElement('div'); card.className = 'jstube-card';
                card.innerHTML = '<img class="jstube-thumb" src="' + v.thumbnail + '" alt="" loading="lazy"><div class="jstube-card-info">' +
                    '<div class="jstube-card-title">' + this._esc(v.title) + '</div>' +
                    '<div class="jstube-card-channel">' + this._esc(v.channel) + '</div>' +
                    '<div class="jstube-card-meta">' + this._esc(v.views) + ' &middot; ' + this._esc(v.published) + ' &middot; ' + v.duration + '</div></div>';
                card.addEventListener('click', () => this.playVideo(v));
                this.resultsEl.appendChild(card);
            });
            log.info('JSTUBE', 'Found', results.length, 'results');
            this.statusEl.textContent = results.length + ' results';
        } catch (err) { log.error('JSTUBE', 'Search failed:', err.message); this.resultsEl.innerHTML = '<div class="jstube-placeholder">Search failed: ' + err.message + '</div>'; this.statusEl.textContent = 'Error'; }
    }
    playVideo(video) {
        log.info('JSTUBE', 'Playing:', video.title, '[' + video.videoId + ']');
        this.resultsEl.style.display = 'none'; this.playerEl.style.display = '';
        if (this._iframe) this._iframe.remove();
        this._iframe = document.createElement('iframe');
        this._iframe.src = 'https://www.youtube.com/embed/' + video.videoId + '?autoplay=1&rel=0';
        this._iframe.style.cssText = 'width:100%; height:360px; border:none;';
        this._iframe.allow = 'autoplay; encrypted-media'; this._iframe.allowFullscreen = true;
        this.videoEl.style.display = 'none'; this.videoEl.parentElement.appendChild(this._iframe);
        this.videoInfoEl.innerHTML = '<div class="jstube-video-title">' + this._esc(video.title) + '</div>' +
            '<div class="jstube-video-channel">' + this._esc(video.channel) + '</div>' +
            '<div class="jstube-video-meta">' + this._esc(video.views) + ' &middot; ' + this._esc(video.published) + '</div>';
        this.statusEl.textContent = 'Playing: ' + video.title;
    }
    showResults() { this.playerEl.style.display = 'none'; this.resultsEl.style.display = ''; if (this._iframe) { this._iframe.remove(); this._iframe = null; } this.videoEl.style.display = ''; }
    reset() { this.showResults(); this.resultsEl.innerHTML = '<div class="jstube-placeholder">Search for videos to get started</div>'; this.searchInput.value = ''; this.statusEl.textContent = 'Ready'; }
    _esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
}

// ═══════════════════════════════════════════════════════════
//  BaseApp — abstract base class for all JS OS applications
// ═══════════════════════════════════════════════════════════

class BaseApp {
    constructor(desktop, windowId, iconId) {
        this.desktop = desktop;
        this.windowEl = document.getElementById(windowId);
        this.iconEl = document.getElementById(iconId);
        this.name = windowId.replace('-window', '');
        log.debug('APP', 'BaseApp created:', this.name);

        // Bind icon click → launch this app
        this.iconEl.addEventListener('click', () => this.desktop.launchApp(this.name));
        // Bind close button → close this app
        this.windowEl.querySelector('.btn-close').addEventListener('click', () => this.desktop.closeApp(this.name));
    }

    /** Called after the window opens. Override to set focus, init connections, etc. */
    onLaunch() {}

    /** Called before the window closes. Override to disconnect, cleanup, etc. */
    onClose() {}
}

// ═══════════════════════════════════════════════════════════
//  App subclasses — each one is a self-contained JS OS app
// ═══════════════════════════════════════════════════════════

// ─── JS Chat App ───
class JSChatApp extends BaseApp {
    constructor(desktop) {
        super(desktop, 'chat-window', 'app-icon');
        this.client = new ChatClient(desktop.sound, desktop.notifications);
        this._pendingImage = null;

        this.els = {
            lobby: document.getElementById('lobby'),
            chatView: document.getElementById('chat-view'),
            chatForm: document.getElementById('chat-form'),
            messages: document.getElementById('messages'),
            username: document.getElementById('lobby-username'),
            code: document.getElementById('lobby-code'),
            error: document.getElementById('lobby-error'),
            windowTitle: document.getElementById('window-title'),
            roomCodeDisplay: document.getElementById('room-code-display'),
            chatStatusbar: document.getElementById('chat-statusbar'),
            statusUsername: document.getElementById('status-username'),
            userList: document.getElementById('user-list'),
            userCount: document.getElementById('user-count'),
        };

        this._bindClient();
        this._bindUI();
        this._bindImagePaste();
    }

    onLaunch() {
        this.desktop.notifications.requestPermission();
        this.els.username.focus();
    }

    onClose() {
        this.client.disconnect();
        this.els.lobby.style.display = '';
        this.els.chatView.style.display = 'none';
        this.els.chatForm.style.display = 'none';
        this.els.messages.innerHTML = '';
        this.els.error.textContent = '';
        this.els.roomCodeDisplay.textContent = '';
        this.els.windowTitle.textContent = '{ } JS Chat';
        this.els.chatStatusbar.style.display = 'none';
        this.els.statusUsername.textContent = '';
        this.els.userList.innerHTML = '';
        this.els.userCount.textContent = '';
        this._clearImagePreview();
        document.getElementById('message').value = '';
    }

    _bindClient() {
        this.client.onJoined = (code, history) => {
            this.els.lobby.style.display = 'none';
            this.els.chatView.style.display = '';
            this.els.chatForm.style.display = '';
            this.els.chatStatusbar.style.display = '';
            this.els.statusUsername.textContent = this.client.username;
            this.els.roomCodeDisplay.textContent = code;
            this.els.windowTitle.textContent = '{ } JS Chat';
            document.getElementById('message').focus();
            history.forEach(m => {
                if (m.type === 'message') this._addMessage(m.username, m.message, m.image);
                else if (m.type === 'system') this._addSystemMessage(m.message);
            });
        };
        this.client.onMessage = (user, text, image) => this._addMessage(user, text, image);
        this.client.onSystem = (text) => this._addSystemMessage(text);
        this.client.onError = (text) => this.desktop.showErrorDialog(text);
        this.client.onDisconnect = () => this._addSystemMessage('Disconnected from server.');
        this.client.onUsers = (users) => {
            this.els.userList.innerHTML = '';
            users.forEach(name => {
                const li = document.createElement('li'); li.textContent = name;
                if (name === this.client.username) li.className = 'self';
                this.els.userList.appendChild(li);
            });
            this.els.userCount.textContent = users.length + ' online';
        };
    }

    _bindUI() {
        document.getElementById('btn-create').addEventListener('click', () => this._createRoom());
        document.getElementById('btn-join').addEventListener('click', () => this._joinRoom());

        this.els.chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('message');
            const text = input.value.trim();
            if (!text && !this._pendingImage) return;
            this.client.send(text || '', this._pendingImage || null);
            input.value = ''; this._clearImagePreview(); input.focus();
        });

        this.els.roomCodeDisplay.addEventListener('click', () => {
            navigator.clipboard.writeText(this.client.roomCode);
            this.desktop.showToast('Room code copied!');
        });

        // Enter key shortcuts for lobby inputs
        this.els.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._joinRoom(); });
        this.els.username.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !this.els.code.value) this._createRoom(); });
    }

    _bindImagePaste() {
        document.getElementById('image-preview-remove').addEventListener('click', () => this._clearImagePreview());
        document.addEventListener('paste', (e) => {
            if (!this.client.roomCode || this.els.chatForm.style.display === 'none') return;
            const items = e.clipboardData?.items; if (!items) return;
            for (const item of items) {
                if (!item.type.startsWith('image/')) continue;
                e.preventDefault();
                const blob = item.getAsFile(); if (!blob) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        let w = img.width, h = img.height; const maxW = 800;
                        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
                        canvas.width = w; canvas.height = h;
                        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                        if (dataUrl.length > 700000) { log.warn('IMAGE', 'Image too large:', dataUrl.length, 'bytes'); this.desktop.showErrorDialog('Image is too large to send.'); return; }
                        log.info('IMAGE', 'Image pasted, size:', Math.round(dataUrl.length / 1024) + 'KB');
                        this._pendingImage = dataUrl;
                        document.getElementById('image-preview-img').src = dataUrl;
                        document.getElementById('image-preview').style.display = '';
                        document.getElementById('message').removeAttribute('required');
                    };
                    img.src = ev.target.result;
                };
                reader.readAsDataURL(blob);
                break;
            }
        });
    }

    _clearImagePreview() {
        this._pendingImage = null;
        document.getElementById('image-preview').style.display = 'none';
        document.getElementById('image-preview-img').src = '';
        document.getElementById('message').setAttribute('required', '');
    }

    _createRoom() {
        const name = this.els.username.value.trim();
        if (!name) { this.els.error.textContent = 'Enter a username first'; return; }
        this.els.error.textContent = ''; this.client.connect('create', name);
    }
    _joinRoom() {
        const name = this.els.username.value.trim();
        const code = this.els.code.value.trim().toUpperCase();
        if (!name) { this.els.error.textContent = 'Enter a username first'; return; }
        if (!code || code.length !== 6) { this.els.error.textContent = 'Enter a valid 6-character room code'; return; }
        this.els.error.textContent = ''; this.client.connect('join', name, code);
    }

    _addMessage(username, text, image) {
        const container = document.createElement('div');
        const p = document.createElement('p'); p.textContent = username + ': ' + (text || '');
        container.appendChild(p);
        if (image) {
            const img = document.createElement('img'); img.src = image; img.className = 'chat-image'; img.alt = 'Shared image';
            img.addEventListener('click', () => window.open(image, '_blank'));
            container.appendChild(img);
        }
        this.els.messages.appendChild(container);
        this.els.messages.scrollTop = this.els.messages.scrollHeight;
    }
    _addSystemMessage(text) {
        const p = document.createElement('p'); p.className = 'system-msg'; p.textContent = text;
        this.els.messages.appendChild(p);
        this.els.messages.scrollTop = this.els.messages.scrollHeight;
    }
}

// ─── Terminal App ───
class TerminalApp extends BaseApp {
    constructor(desktop) {
        super(desktop, 'terminal-window', 'terminal-icon');
        this.manager = new TerminalSessionManager(
            document.getElementById('terminal-panes'),
            document.getElementById('terminal-tabs'),
            document.getElementById('terminal-new-tab')
        );
    }
    onLaunch() { this.manager.open(); setTimeout(() => this.manager.focus(), 100); }
    onClose() { this.manager.closeAll(); }
}

// ─── JSTube App ───
class JSTubeApp extends BaseApp {
    constructor(desktop) {
        super(desktop, 'jstube-window', 'jstube-icon');
        this.manager = new JSTubeManager(
            document.getElementById('jstube-results'),
            document.getElementById('jstube-player'),
            document.getElementById('jstube-video'),
            document.getElementById('jstube-video-info'),
            document.getElementById('jstube-back-btn'),
            document.getElementById('jstube-search-form'),
            document.getElementById('jstube-search'),
            document.getElementById('jstube-status')
        );
    }
    onLaunch() { document.getElementById('jstube-search').focus(); }
    onClose() { this.manager.reset(); }
}

// ─── JS Call App ───
class JSCallApp extends BaseApp {
    constructor(desktop) {
        super(desktop, 'call-window', 'call-icon');
        this.client = new CallClient();

        this.els = {
            lobby: document.getElementById('call-lobby'),
            view: document.getElementById('call-view'),
            username: document.getElementById('call-username'),
            code: document.getElementById('call-code'),
            error: document.getElementById('call-error'),
            codeDisplay: document.getElementById('call-code-display'),
            userCount: document.getElementById('call-user-count'),
            usersGrid: document.getElementById('call-users-grid'),
            muteBtn: document.getElementById('call-mute-btn'),
            leaveBtn: document.getElementById('call-leave-btn'),
            statusbar: document.getElementById('call-statusbar'),
            statusUsername: document.getElementById('call-status-username'),
            muteLabel: document.getElementById('mute-label'),
        };

        this._bindClient();
        this._bindUI();
    }

    onLaunch() {
        this.desktop.notifications.requestPermission();
        this.els.username.focus();
    }

    onClose() {
        this.client.disconnect();
        this._resetUI();
    }

    _bindClient() {
        this.client.onJoined = (code) => {
            this.els.lobby.style.display = 'none';
            this.els.view.style.display = '';
            this.els.statusbar.style.display = '';
            this.els.statusUsername.textContent = this.client.username;
            this.els.codeDisplay.textContent = code;
        };
        this.client.onUsers = (users) => {
            this.els.usersGrid.innerHTML = '';
            users.forEach(u => {
                const card = document.createElement('div');
                card.className = 'call-user-card' + (u.muted ? ' muted' : '');
                card.innerHTML = '<div class="call-user-avatar">' + u.username.charAt(0).toUpperCase() + '</div>' +
                    '<div class="call-user-name">' + u.username + '</div>' +
                    '<div class="call-user-status ' + (u.muted ? 'muted-status' : '') + '">' + (u.muted ? 'Muted' : 'Speaking') + '</div>';
                this.els.usersGrid.appendChild(card);
            });
            this.els.userCount.textContent = users.length + ' in call';
        };
        this.client.onError = (text) => this.desktop.showErrorDialog(text);
        this.client.onDisconnect = () => this._resetUI();
    }

    _bindUI() {
        document.getElementById('btn-create-call').addEventListener('click', () => this._createCall());
        document.getElementById('btn-join-call').addEventListener('click', () => this._joinCall());
        this.els.muteBtn.addEventListener('click', () => {
            const muted = this.client.toggleMute();
            this.els.muteBtn.classList.toggle('muted', muted);
            this.els.muteLabel.textContent = muted ? 'Unmute' : 'Mute';
        });
        this.els.leaveBtn.addEventListener('click', () => { this.client.disconnect(); this._resetUI(); });
        this.els.codeDisplay.addEventListener('click', () => {
            navigator.clipboard.writeText(this.client.roomCode);
            this.desktop.showToast('Call code copied!');
        });
        this.els.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._joinCall(); });
        this.els.username.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !this.els.code.value) this._createCall(); });
    }

    _resetUI() {
        this.els.lobby.style.display = '';
        this.els.view.style.display = 'none';
        this.els.statusbar.style.display = 'none';
        this.els.error.textContent = ''; this.els.codeDisplay.textContent = '';
        this.els.usersGrid.innerHTML = ''; this.els.userCount.textContent = '';
        this.els.statusUsername.textContent = '';
        this.els.muteBtn.classList.remove('muted'); this.els.muteLabel.textContent = 'Mute';
    }

    _createCall() {
        const name = this.els.username.value.trim();
        if (!name) { this.els.error.textContent = 'Enter a username first'; return; }
        this.els.error.textContent = ''; this.client.connect('create', name);
    }
    _joinCall() {
        const name = this.els.username.value.trim();
        const code = this.els.code.value.trim().toUpperCase();
        if (!name) { this.els.error.textContent = 'Enter a username first'; return; }
        if (!code || code.length !== 6) { this.els.error.textContent = 'Enter a valid 6-character room code'; return; }
        this.els.error.textContent = ''; this.client.connect('join', name, code);
    }
}

// ═══════════════════════════════════════════════════════════
//  Desktop — main orchestrator, manages all apps
// ═══════════════════════════════════════════════════════════

class Desktop {
    constructor() {
        this.sound = new SoundManager();
        this.notifications = new NotificationManager();
        this.windowManager = new WindowManager(this.sound);
        this.apps = new Map();
        this.explorerEl = document.getElementById('explorer-window');
        this.toastEl = document.getElementById('copy-toast');

        // Register explorer window
        this.windowManager.register('explorer', this.explorerEl);

        // Register all apps — to add a new app, just add one line here
        this.registerApp(new JSChatApp(this));
        this.registerApp(new TerminalApp(this));
        this.registerApp(new JSTubeApp(this));
        this.registerApp(new JSCallApp(this));

        // Splash screen
        this._bindSplash();
    }

    /** Register an app with the desktop */
    registerApp(app) {
        this.apps.set(app.name, app);
        this.windowManager.register(app.name, app.windowEl, { disableButtons: ['close'] });
        log.info('DESKTOP', 'App registered:', app.name);
    }

    /** Remove an app from the desktop */
    removeApp(name) {
        this.apps.delete(name);
        log.info('DESKTOP', 'App removed:', name);
    }

    /** Launch an app by name */
    launchApp(name) {
        const app = this.apps.get(name);
        if (!app) { log.warn('DESKTOP', 'Unknown app:', name); return; }
        log.info('DESKTOP', 'Launching:', name);
        this.windowManager.close('explorer').then(() => {
            this.windowManager.open(name);
            app.onLaunch();
        });
    }

    /** Close an app by name, return to explorer */
    closeApp(name) {
        const app = this.apps.get(name);
        if (!app) return;
        log.info('DESKTOP', 'Closing:', name);
        app.onClose();
        this.windowManager.close(name).then(() => this.windowManager.open('explorer'));
    }

    /** Show a toast notification */
    showToast(text) {
        this.toastEl.textContent = text;
        this.toastEl.classList.add('show');
        setTimeout(() => this.toastEl.classList.remove('show'), 2000);
    }

    /** Show a Windows-style error dialog */
    showErrorDialog(message) {
        log.warn('DESKTOP', 'Error dialog:', message);
        this.sound.play('window');
        const overlay = document.createElement('div');
        overlay.className = 'error-overlay';
        overlay.innerHTML =
            '<div class="error-dialog">' +
                '<div class="error-dialog-titlebar"><span>JS OS - Error</span></div>' +
                '<div class="error-dialog-body">' +
                    '<div class="error-dialog-icon">&#9888;</div>' +
                    '<div class="error-dialog-text">' + message + '</div>' +
                '</div>' +
                '<div class="error-dialog-buttons"><button class="error-dialog-btn">OK</button></div>' +
            '</div>';
        document.body.appendChild(overlay);
        const dismiss = () => { overlay.classList.add('closing'); setTimeout(() => overlay.remove(), 150); };
        const btn = overlay.querySelector('.error-dialog-btn');
        btn.focus();
        btn.addEventListener('click', dismiss);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    }

    _bindSplash() {
        document.getElementById('splash').addEventListener('click', () => {
            log.info('DESKTOP', 'Splash clicked — booting JS OS');
            this.sound.play('startup');
            document.getElementById('splash').classList.add('hidden');
            setTimeout(() => {
                this.explorerEl.style.display = 'block';
                this.explorerEl.classList.add('opening-slow');
                this.explorerEl.addEventListener('animationend', () => {
                    this.explorerEl.classList.remove('opening-slow');
                }, { once: true });
            }, 1200);
        }, { once: true });
    }
}

// ═══════════════════════════════════════════════════════════
//  Boot
// ═══════════════════════════════════════════════════════════
const desktop = new Desktop();
log.info('DESKTOP', 'JS OS booted —', desktop.apps.size, 'apps registered');
