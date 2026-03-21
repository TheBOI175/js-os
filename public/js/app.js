// ═══════════════════════════════════════════════════════════
//  JS OS — Full OOP Architecture
//  Logger → Utility classes → Client classes → BaseApp → App subclasses → Desktop
// ═══════════════════════════════════════════════════════════

// ─── Logger: single class for all client-side debug logging ───
class Logger {
    static LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, OFF: 4 };
    static COLORS = {
        DESKTOP: '#F7DF1E', WINDOW: '#c9b518', SOUND: '#c678dd', NOTIFY: '#61afef',
        CHAT: '#98c379', CALL: '#56b6c2', MUSIC: '#e06c75', JSTUBE: '#c97a7a',
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
    chatMessage(username, text) { this.notify(window.JSOS_CONFIG?.chat || 'JS Chat', username + ': ' + text, 'chat'); }
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

// ─── MusicSynthesizer (realistic Web Audio synthesis) ───
class MusicSynthesizer {
    constructor() {
        this.ctx = null;
        this._activeNodes = [];
    }

    _ensureCtx() {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    playNote(frequency, durationSec, instrumentName, startTime, volume) {
        this._ensureCtx();
        const t = startTime || this.ctx.currentTime;
        const vol = volume !== undefined ? volume : 0.4;
        const method = '_play_' + (instrumentName || 'piano');
        if (this[method]) this[method](frequency, durationSec, t, vol);
        else this._play_piano(frequency, durationSec, t, vol);
    }

    // Piano: layered harmonics with percussive hammer feel
    _play_piano(freq, dur, t, vol) {
        const master = this.ctx.createGain();
        master.connect(this.ctx.destination);
        const harmonics = [{ r: 1, a: 1 }, { r: 2, a: 0.4 }, { r: 3, a: 0.15 }, { r: 4, a: 0.07 }];
        for (const h of harmonics) {
            const osc = this.ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = freq * h.r;
            osc.detune.value = (Math.random() - 0.5) * 4; // slight detuning for richness
            const g = this.ctx.createGain();
            const hVol = vol * h.a;
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(hVol, t + 0.005);
            g.gain.exponentialRampToValueAtTime(hVol * 0.3, t + 0.15);
            g.gain.exponentialRampToValueAtTime(0.001, t + dur);
            osc.connect(g); g.connect(master);
            osc.start(t); osc.stop(t + dur + 0.05);
            this._track(osc);
        }
    }

    // Guitar: Karplus-Strong plucked string synthesis
    _play_guitar(freq, dur, t, vol) {
        const ctx = this.ctx;
        const sampleRate = ctx.sampleRate;
        const period = Math.round(sampleRate / freq);
        const bufLen = Math.max(Math.round(sampleRate * dur * 1.2), period * 2);
        const buf = ctx.createBuffer(1, bufLen, sampleRate);
        const data = buf.getChannelData(0);
        // Fill first period with noise burst
        for (let i = 0; i < period; i++) data[i] = (Math.random() * 2 - 1) * 0.8;
        // Karplus-Strong: average adjacent samples with slight damping
        const decay = 0.996;
        for (let i = period; i < bufLen; i++) {
            data[i] = (data[i - period] + data[i - period + 1]) * 0.5 * decay;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.linearRampToValueAtTime(0.001, t + dur);
        src.connect(g); g.connect(ctx.destination);
        src.start(t); src.stop(t + dur + 0.1);
        this._track(src);
    }

    // Violin: rich sawtooth harmonics with slow attack and vibrato
    _play_violin(freq, dur, t, vol) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;
        // Vibrato
        const lfo = this.ctx.createOscillator();
        const lfoG = this.ctx.createGain();
        lfo.frequency.value = 5.5;
        lfoG.gain.value = 4;
        lfo.connect(lfoG); lfoG.connect(osc.frequency);
        lfo.start(t); lfo.stop(t + dur + 0.2);
        // Gentle lowpass for warmth
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = freq * 4;
        filter.Q.value = 1;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol * 0.6, t + 0.12);
        g.gain.setValueAtTime(vol * 0.6, t + dur - 0.1);
        g.gain.linearRampToValueAtTime(0, t + dur);
        osc.connect(filter); filter.connect(g); g.connect(this.ctx.destination);
        osc.start(t); osc.stop(t + dur + 0.1);
        this._track(osc);
    }

    // Flute: sine + breath noise
    _play_flute(freq, dur, t, vol) {
        const ctx = this.ctx;
        // Pure tone
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol * 0.5, t + 0.06);
        g.gain.setValueAtTime(vol * 0.5, t + dur - 0.08);
        g.gain.linearRampToValueAtTime(0, t + dur);
        osc.connect(g); g.connect(ctx.destination);
        osc.start(t); osc.stop(t + dur + 0.1);
        // Breath noise
        const noiseLen = Math.round(ctx.sampleRate * dur);
        const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
        const nd = noiseBuf.getChannelData(0);
        for (let i = 0; i < noiseLen; i++) nd[i] = (Math.random() * 2 - 1);
        const nSrc = ctx.createBufferSource();
        nSrc.buffer = noiseBuf;
        const nFilter = ctx.createBiquadFilter();
        nFilter.type = 'bandpass';
        nFilter.frequency.value = freq;
        nFilter.Q.value = 8;
        const nGain = ctx.createGain();
        nGain.gain.setValueAtTime(0, t);
        nGain.gain.linearRampToValueAtTime(vol * 0.06, t + 0.03);
        nGain.gain.setValueAtTime(vol * 0.06, t + dur - 0.05);
        nGain.gain.linearRampToValueAtTime(0, t + dur);
        nSrc.connect(nFilter); nFilter.connect(nGain); nGain.connect(ctx.destination);
        nSrc.start(t); nSrc.stop(t + dur + 0.1);
        this._track(osc);
    }

    // Trumpet: bright brass with multiple harmonics
    _play_trumpet(freq, dur, t, vol) {
        const master = this.ctx.createGain();
        master.connect(this.ctx.destination);
        const harmonics = [{ r: 1, a: 1 }, { r: 2, a: 0.7 }, { r: 3, a: 0.5 }, { r: 4, a: 0.3 }, { r: 5, a: 0.15 }];
        for (const h of harmonics) {
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = freq * h.r;
            const g = this.ctx.createGain();
            const hVol = vol * h.a * 0.15;
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(hVol, t + 0.04);
            g.gain.setValueAtTime(hVol * 0.8, t + dur - 0.06);
            g.gain.linearRampToValueAtTime(0, t + dur);
            osc.connect(g); g.connect(master);
            osc.start(t); osc.stop(t + dur + 0.1);
            this._track(osc);
        }
    }

    // Music Box: pure shimmer with detuned copy
    _play_musicbox(freq, dur, t, vol) {
        for (const detune of [0, 6]) {
            const osc = this.ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = freq;
            osc.detune.value = detune;
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(vol * 0.4, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + Math.min(dur, 1.5));
            osc.connect(g); g.connect(this.ctx.destination);
            osc.start(t); osc.stop(t + dur + 0.1);
            this._track(osc);
        }
    }

    // Metronome click
    playClick(downbeat) {
        this._ensureCtx();
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = downbeat ? 1000 : 800;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(downbeat ? 0.3 : 0.15, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        osc.connect(g); g.connect(this.ctx.destination);
        osc.start(t); osc.stop(t + 0.06);
    }

    _track(node) {
        this._activeNodes.push(node);
        node.onended = () => { this._activeNodes = this._activeNodes.filter(n => n !== node); };
    }

    stopAll() {
        for (const n of this._activeNodes) { try { n.stop(); } catch {} }
        this._activeNodes = [];
    }
}

// ─── StaffManager (canvas staff notation, infinite scroll, multi-track) ───
class StaffManager {
    static PITCHES = [
        { name: 'A5', freq: 880.00 }, { name: 'G5', freq: 783.99 },
        { name: 'F5', freq: 698.46 }, { name: 'E5', freq: 659.25 },
        { name: 'D5', freq: 587.33 }, { name: 'C5', freq: 523.25 },
        { name: 'B4', freq: 493.88 }, { name: 'A4', freq: 440.00 },
        { name: 'G4', freq: 392.00 }, { name: 'F4', freq: 349.23 },
        { name: 'E4', freq: 329.63 }, { name: 'D4', freq: 293.66 },
        { name: 'C4', freq: 261.63 },
    ];
    static DURATIONS = { whole: 4, half: 2, quarter: 1, eighth: 0.5 };
    static NUM_TRACKS = 4;

    constructor(canvas, scrollEl, synth, opts) {
        this.canvas = canvas;
        this.c = canvas.getContext('2d');
        this.scrollEl = scrollEl;
        this.synth = synth;

        // Layout
        this.STAFF_TOP = 50;
        this.LINE_GAP = 20;
        this.LEFT_MARGIN = 55;
        this.BEAT_WIDTH = 45;
        this.NOTE_R = 7;
        this.totalBeats = 64; // starts with 16 measures — grows automatically

        // Tracks
        this.tracks = [];
        for (let i = 0; i < StaffManager.NUM_TRACKS; i++) {
            this.tracks.push({
                instrument: ['piano', 'guitar', 'violin', 'flute'][i],
                volume: 0.8, muted: false, notes: [],
            });
        }
        this.activeTrack = 0;
        this.tempo = 120;
        this.masterVolume = 0.8;
        this.loop = false;
        this.metronome = false;
        this.currentDuration = 'quarter';
        this.eraserMode = false;
        this.selectedNote = null;
        this._dragging = null;

        // Playback
        this._playing = false;
        this._paused = false;
        this._playStartTime = 0;
        this._pauseOffset = 0;
        this._animFrame = null;
        this._playheadBeat = 0;

        // Callbacks
        this.onNoteCountChange = opts.onNoteCountChange || null;
        this.onPlayStateChange = opts.onPlayStateChange || null;
        this.onPositionChange = opts.onPositionChange || null;
        this.onSeekUpdate = opts.onSeekUpdate || null;

        this._bindEvents();
        this._resize();
        log.info('MUSIC', 'StaffManager created');
    }

    // ─── Coordinate mapping ───
    _pitchY(i) { return this.STAFF_TOP + i * this.LINE_GAP; }
    _yPitch(y) { return Math.max(0, Math.min(12, Math.round((y - this.STAFF_TOP) / this.LINE_GAP))); }
    _beatX(b) { return this.LEFT_MARGIN + b * this.BEAT_WIDTH; }
    _xBeat(x) { return Math.max(0, Math.round((x - this.LEFT_MARGIN) / this.BEAT_WIDTH * 2) / 2); }

    _resize() {
        const w = Math.max(this.scrollEl.clientWidth, this._beatX(this.totalBeats) + 40);
        this.canvas.width = w;
        this.canvas.height = this.scrollEl.clientHeight;
        this.render();
    }

    _ensureWidth(beat) {
        while (beat >= this.totalBeats - 2) this.totalBeats += 16;
        const needed = this._beatX(this.totalBeats) + 40;
        if (this.canvas.width < needed) {
            this.canvas.width = needed;
            this.render();
        }
    }

    // ─── Rendering ───
    render() {
        const { c, canvas } = this;
        const w = canvas.width, h = canvas.height;
        c.clearRect(0, 0, w, h);
        c.fillStyle = '#1e1e1e';
        c.fillRect(0, 0, w, h);

        // Staff lines (indices 2,4,6,8,10 = F5,D5,B4,G4,E4)
        c.strokeStyle = '#444';
        c.lineWidth = 1;
        for (const idx of [2, 4, 6, 8, 10]) {
            const y = this._pitchY(idx);
            c.beginPath(); c.moveTo(this.LEFT_MARGIN - 5, y); c.lineTo(w, y); c.stroke();
        }

        // Pitch labels
        c.fillStyle = '#666';
        c.font = '10px Courier New, monospace';
        c.textAlign = 'right';
        for (let i = 0; i < 13; i++) {
            const y = this._pitchY(i);
            const name = StaffManager.PITCHES[i].name;
            c.fillStyle = name.startsWith('C') ? '#F7DF1E' : '#666';
            c.fillText(name, this.LEFT_MARGIN - 10, y + 4);
        }
        c.textAlign = 'left';

        // Measure bars + beat numbers
        c.font = '10px Tahoma, sans-serif';
        for (let b = 0; b <= this.totalBeats; b++) {
            const x = this._beatX(b);
            if (x > w) break;
            if (b % 4 === 0) {
                c.strokeStyle = '#555';
                c.lineWidth = b % 16 === 0 ? 2 : 1;
                c.beginPath(); c.moveTo(x, this._pitchY(2) - 10); c.lineTo(x, this._pitchY(10) + 10); c.stroke();
                c.fillStyle = '#F7DF1E';
                c.fillText(String(b / 4 + 1), x + 2, this._pitchY(0) - 2);
            } else {
                // Subtle beat tick
                c.strokeStyle = '#2a2a28';
                c.lineWidth = 1;
                c.beginPath(); c.moveTo(x, this._pitchY(2)); c.lineTo(x, this._pitchY(10)); c.stroke();
            }
        }

        // Draw notes for active track
        const track = this.tracks[this.activeTrack];
        for (const note of track.notes) {
            this._drawNote(note, note === this.selectedNote);
        }

        // Playhead
        if (this._playing || this._paused) {
            const px = this._beatX(this._playheadBeat);
            c.strokeStyle = '#c97a7a';
            c.lineWidth = 2;
            c.beginPath(); c.moveTo(px, this._pitchY(0) - 15); c.lineTo(px, this._pitchY(12) + 15); c.stroke();
            // Triangle head
            c.fillStyle = '#c97a7a';
            c.beginPath(); c.moveTo(px - 5, this._pitchY(0) - 15); c.lineTo(px + 5, this._pitchY(0) - 15); c.lineTo(px, this._pitchY(0) - 8); c.fill();
        }
    }

    _drawNote(note, selected) {
        const { c } = this;
        const x = this._beatX(note.beat);
        const y = this._pitchY(note.pitchIndex);
        const r = this.NOTE_R;
        const dur = note.duration;
        const color = selected ? '#F7DF1E' : '#e0e0e0';

        // Ledger lines
        if (note.pitchIndex <= 0) { c.strokeStyle = '#555'; c.lineWidth = 1; c.beginPath(); c.moveTo(x - r - 4, this._pitchY(0)); c.lineTo(x + r + 4, this._pitchY(0)); c.stroke(); }
        if (note.pitchIndex >= 12) { c.strokeStyle = '#555'; c.lineWidth = 1; c.beginPath(); c.moveTo(x - r - 4, this._pitchY(12)); c.lineTo(x + r + 4, this._pitchY(12)); c.stroke(); }

        // Note head
        c.beginPath();
        c.ellipse(x, y, r, r * 0.7, -0.2, 0, Math.PI * 2);
        if (dur === 'whole' || dur === 'half') {
            c.strokeStyle = color; c.lineWidth = 2; c.stroke();
            if (selected) { c.fillStyle = 'rgba(247,223,30,0.15)'; c.fill(); }
        } else {
            c.fillStyle = color; c.fill();
        }

        // Stem
        if (dur !== 'whole') {
            c.strokeStyle = color; c.lineWidth = 1.5;
            const up = note.pitchIndex >= 6;
            c.beginPath();
            if (up) { c.moveTo(x + r - 1, y); c.lineTo(x + r - 1, y - 32); }
            else { c.moveTo(x - r + 1, y); c.lineTo(x - r + 1, y + 32); }
            c.stroke();

            // Flag for eighth
            if (dur === 'eighth') {
                c.beginPath();
                if (up) { c.moveTo(x + r - 1, y - 32); c.quadraticCurveTo(x + r + 10, y - 22, x + r + 3, y - 14); }
                else { c.moveTo(x - r + 1, y + 32); c.quadraticCurveTo(x - r - 10, y + 22, x - r - 3, y + 14); }
                c.stroke();
            }
        }
    }

    // ─── Interaction ───
    _bindEvents() {
        this.canvas.addEventListener('mousedown', (e) => this._onDown(e));
        this.canvas.addEventListener('mousemove', (e) => this._onMove(e));
        this.canvas.addEventListener('mouseup', () => { this._dragging = null; });
        this.canvas.addEventListener('mouseleave', () => { this._dragging = null; });
        document.addEventListener('keydown', (e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedNote) {
                this._removeNote(this.selectedNote);
            }
        });
    }

    _pos(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    _hitTest(x, y) {
        const track = this.tracks[this.activeTrack];
        for (const n of track.notes) {
            const nx = this._beatX(n.beat), ny = this._pitchY(n.pitchIndex);
            if (Math.abs(x - nx) < 12 && Math.abs(y - ny) < 10) return n;
        }
        return null;
    }

    _onDown(e) {
        const p = this._pos(e);
        const hit = this._hitTest(p.x, p.y);

        if (this.eraserMode) { if (hit) this._removeNote(hit); return; }

        if (hit) {
            this.selectedNote = hit;
            this._dragging = hit;
            const pitch = StaffManager.PITCHES[hit.pitchIndex];
            this.synth.playNote(pitch.freq, 0.25, this.tracks[this.activeTrack].instrument, undefined, this.tracks[this.activeTrack].volume * this.masterVolume);
            this.render();
            return;
        }

        if (p.x >= this.LEFT_MARGIN) {
            const pitchIndex = this._yPitch(p.y);
            const beat = this._xBeat(p.x);
            this._ensureWidth(beat + 4);
            const note = { pitchIndex, duration: this.currentDuration, beat };
            this.tracks[this.activeTrack].notes.push(note);
            this.selectedNote = note;
            const pitch = StaffManager.PITCHES[pitchIndex];
            this.synth.playNote(pitch.freq, 0.25, this.tracks[this.activeTrack].instrument, undefined, this.tracks[this.activeTrack].volume * this.masterVolume);
            this.render();
            this._notifyNoteCount();
        }
    }

    _onMove(e) {
        if (!this._dragging) return;
        const p = this._pos(e);
        this._dragging.pitchIndex = this._yPitch(p.y);
        this._dragging.beat = this._xBeat(p.x);
        this._ensureWidth(this._dragging.beat + 4);
        this.render();
    }

    _removeNote(note) {
        const track = this.tracks[this.activeTrack];
        const idx = track.notes.indexOf(note);
        if (idx !== -1) { track.notes.splice(idx, 1); if (this.selectedNote === note) this.selectedNote = null; this.render(); this._notifyNoteCount(); }
    }

    switchTrack(i) { this.activeTrack = i; this.selectedNote = null; this.render(); }

    clear() {
        this.tracks[this.activeTrack].notes = [];
        this.selectedNote = null;
        this.render();
        this._notifyNoteCount();
    }

    // ─── Playback ───
    play() {
        if (this._playing && !this._paused) return;
        this.synth._ensureCtx();
        const ctx = this.synth.ctx;

        this._playing = true;
        this._paused = false;

        // Find the last beat across all tracks
        let lastBeat = 0;
        for (const t of this.tracks) for (const n of t.notes) {
            const end = n.beat + StaffManager.DURATIONS[n.duration];
            if (end > lastBeat) lastBeat = end;
        }
        if (lastBeat === 0) lastBeat = this.totalBeats;
        this._lastBeat = lastBeat;

        // Schedule all notes across all tracks
        const beatDur = 60 / this.tempo;
        const startTime = ctx.currentTime - this._pauseOffset;
        this._playStartTime = startTime;

        for (const track of this.tracks) {
            if (track.muted) continue;
            for (const note of track.notes) {
                const t = startTime + note.beat * beatDur;
                const dur = StaffManager.DURATIONS[note.duration] * beatDur;
                if (t >= ctx.currentTime - 0.01) {
                    const p = StaffManager.PITCHES[note.pitchIndex];
                    this.synth.playNote(p.freq, dur, track.instrument, t, track.volume * this.masterVolume);
                }
            }
        }

        // Animate
        const animate = () => {
            if (!this._playing || this._paused) return;
            const elapsed = ctx.currentTime - this._playStartTime;
            this._playheadBeat = elapsed / beatDur;
            if (this.onSeekUpdate) this.onSeekUpdate(this._playheadBeat, this._lastBeat);

            // Metronome
            if (this.metronome) {
                const currentBeat = Math.floor(this._playheadBeat);
                if (this._lastMetroBeat !== currentBeat && currentBeat < this._lastBeat) {
                    this._lastMetroBeat = currentBeat;
                    this.synth.playClick(currentBeat % 4 === 0);
                }
            }

            // Auto-scroll
            const headPx = this._beatX(this._playheadBeat);
            const scrollW = this.scrollEl.clientWidth;
            if (headPx > this.scrollEl.scrollLeft + scrollW - 80) {
                this.scrollEl.scrollLeft = headPx - 80;
            }

            if (this._playheadBeat >= this._lastBeat) {
                if (this.loop) {
                    this._pauseOffset = 0;
                    this._playStartTime = ctx.currentTime;
                    this._lastMetroBeat = -1;
                    // Reschedule
                    for (const track of this.tracks) {
                        if (track.muted) continue;
                        for (const note of track.notes) {
                            const t2 = ctx.currentTime + note.beat * beatDur;
                            const dur2 = StaffManager.DURATIONS[note.duration] * beatDur;
                            const p = StaffManager.PITCHES[note.pitchIndex];
                            this.synth.playNote(p.freq, dur2, track.instrument, t2, track.volume * this.masterVolume);
                        }
                    }
                } else { this.stop(); return; }
            }

            this.render();
            this._animFrame = requestAnimationFrame(animate);
        };

        this._lastMetroBeat = -1;
        if (this.onPlayStateChange) this.onPlayStateChange('playing');
        this._animFrame = requestAnimationFrame(animate);
    }

    pause() {
        if (!this._playing || this._paused) return;
        this._paused = true;
        this._pauseOffset = this.synth.ctx.currentTime - this._playStartTime;
        this.synth.stopAll();
        if (this._animFrame) cancelAnimationFrame(this._animFrame);
        if (this.onPlayStateChange) this.onPlayStateChange('paused');
    }

    stop() {
        this._playing = false; this._paused = false;
        this._playheadBeat = 0; this._pauseOffset = 0;
        this.synth.stopAll();
        if (this._animFrame) cancelAnimationFrame(this._animFrame);
        if (this.onPlayStateChange) this.onPlayStateChange('stopped');
        if (this.onPositionChange) this.onPositionChange('Ready');
        this.render();
    }

    rewind() {
        this.stop();
        this.scrollEl.scrollLeft = 0;
        if (this.onSeekUpdate) this.onSeekUpdate(0, this.totalBeats);
    }

    skipForward() {
        const beatDur = 60 / this.tempo;
        const current = this._paused ? this._pauseOffset / beatDur : 0;
        const nextMeasure = (Math.floor(current / 4) + 1) * 4;
        this.scrollEl.scrollLeft = this._beatX(nextMeasure) - 40;
    }

    skipBack() {
        const beatDur = 60 / this.tempo;
        const current = this._paused ? this._pauseOffset / beatDur : 0;
        const prevMeasure = Math.max(0, (Math.floor(current / 4) - 1) * 4);
        this.scrollEl.scrollLeft = this._beatX(prevMeasure) - 40;
    }

    addTrack() {
        const idx = this.tracks.length;
        const instruments = ['piano', 'guitar', 'violin', 'flute', 'trumpet', 'musicbox'];
        this.tracks.push({
            instrument: instruments[idx % instruments.length],
            volume: 0.8, muted: false, notes: [],
        });
        return idx;
    }

    removeTrack(idx) {
        if (this.tracks.length <= 1) return false;
        this.tracks.splice(idx, 1);
        if (this.activeTrack >= this.tracks.length) this.activeTrack = this.tracks.length - 1;
        this.render();
        this._notifyNoteCount();
        return true;
    }

    seek(beat) {
        const beatDur = 60 / this.tempo;
        this._pauseOffset = beat * beatDur;
        this._playheadBeat = beat;
        this.scrollEl.scrollLeft = Math.max(0, this._beatX(beat) - 100);
        if (this._playing && !this._paused) {
            this.synth.stopAll();
            if (this._animFrame) cancelAnimationFrame(this._animFrame);
            this._playing = false;
            this._paused = false;
            this.play();
        } else {
            this.render();
        }
        const measure = Math.floor(beat / 4) + 1;
        const beatInMeasure = (Math.floor(beat) % 4) + 1;
        if (this.onPositionChange) this.onPositionChange('Measure ' + measure + ', Beat ' + beatInMeasure);
    }

    setInstrument(name) { this.tracks[this.activeTrack].instrument = name; }
    setTrackVolume(val) { this.tracks[this.activeTrack].volume = val; }
    toggleMute() { const t = this.tracks[this.activeTrack]; t.muted = !t.muted; return t.muted; }
    setTempo(bpm) { this.tempo = bpm; }
    setMasterVolume(val) { this.masterVolume = val; }
    setLoop(on) { this.loop = on; }
    setMetronome(on) { this.metronome = on; }

    // ─── Export to WAV ───
    async exportWav(filename) {
        let lastBeat = 0;
        for (const t of this.tracks) for (const n of t.notes) {
            const end = n.beat + StaffManager.DURATIONS[n.duration];
            if (end > lastBeat) lastBeat = end;
        }
        if (lastBeat === 0) return;

        const beatDur = 60 / this.tempo;
        const totalSec = lastBeat * beatDur + 0.5;
        const sampleRate = 44100;
        const offCtx = new OfflineAudioContext(1, Math.ceil(sampleRate * totalSec), sampleRate);

        // Schedule all notes into offline context
        const origCtx = this.synth.ctx;
        this.synth.ctx = offCtx;
        for (const track of this.tracks) {
            if (track.muted) continue;
            for (const note of track.notes) {
                const t = note.beat * beatDur;
                const dur = StaffManager.DURATIONS[note.duration] * beatDur;
                const p = StaffManager.PITCHES[note.pitchIndex];
                this.synth.playNote(p.freq, dur, track.instrument, t, track.volume * this.masterVolume);
            }
        }
        this.synth.ctx = origCtx;

        const buffer = await offCtx.startRendering();

        // Encode WAV
        const data = buffer.getChannelData(0);
        const wavLen = 44 + data.length * 2;
        const wav = new ArrayBuffer(wavLen);
        const v = new DataView(wav);
        const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        writeStr(0, 'RIFF'); v.setUint32(4, wavLen - 8, true); writeStr(8, 'WAVE');
        writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
        v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
        v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        writeStr(36, 'data'); v.setUint32(40, data.length * 2, true);
        for (let i = 0; i < data.length; i++) {
            const s = Math.max(-1, Math.min(1, data[i]));
            v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }

        const blob = new Blob([wav], { type: 'audio/wav' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (filename || 'composition') + '.wav';
        a.click();
        URL.revokeObjectURL(a.href);
        log.info('MUSIC', 'Exported:', a.download);
    }

    _notifyNoteCount() {
        let total = 0;
        for (const t of this.tracks) total += t.notes.length;
        if (this.onNoteCountChange) this.onNoteCountChange(total);
        this._autoSave();
    }

    // ─── LocalStorage auto-save ───
    _autoSave() {
        if (!this._saveName) return;
        try {
            const data = {
                name: this._saveName,
                tempo: this.tempo,
                masterVolume: this.masterVolume,
                totalBeats: this.totalBeats,
                tracks: this.tracks.map(t => ({
                    instrument: t.instrument,
                    volume: t.volume,
                    muted: t.muted,
                    notes: t.notes,
                })),
            };
            localStorage.setItem('jsos:note:' + this._saveName, JSON.stringify(data));
        } catch {}
    }

    static loadSaved(name) {
        try {
            const raw = localStorage.getItem('jsos:note:' + name);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }

    static listSaved() {
        const list = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('jsos:note:')) list.push(key.slice('jsos:note:'.length));
        }
        return list;
    }

    static deleteSaved(name) {
        try { localStorage.removeItem('jsos:note:' + name); } catch {}
    }

    loadFromData(data) {
        this.tempo = data.tempo || 120;
        this.masterVolume = data.masterVolume || 0.8;
        if (data.totalBeats > this.totalBeats) this.totalBeats = data.totalBeats;
        this.tracks = data.tracks.map(t => ({
            instrument: t.instrument || 'piano',
            volume: t.volume ?? 0.8,
            muted: t.muted || false,
            notes: t.notes || [],
        }));
        this.activeTrack = 0;
        this._resize();
        this._notifyNoteCount();
    }

    setSaveName(name) { this._saveName = name; }

    destroy() { this.stop(); }
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
        this.els.windowTitle.textContent = '{ } ' + (window.JSOS_CONFIG?.chat || 'JS Chat');
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
            this.els.windowTitle.textContent = '{ } ' + (window.JSOS_CONFIG?.chat || 'JS Chat');
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

// ─── JS Note App (Staff Notation) ───
class MusicMakerApp extends BaseApp {
    constructor(desktop) {
        super(desktop, 'music-window', 'music-icon');
        this.synth = new MusicSynthesizer();
        this.compositionName = '';
        this.manager = null;

        // Lobby: name composition
        document.getElementById('music-start-btn').addEventListener('click', () => this._startEditor());
        document.getElementById('music-name-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._startEditor();
        });

        // Per-track controls (bound once, manager swapped per session)
        document.getElementById('music-instrument').addEventListener('change', (e) => {
            if (this.manager) { this.manager.setInstrument(e.target.value); this._updateStatusBar(); }
        });
        document.getElementById('music-track-vol').addEventListener('input', (e) => {
            if (this.manager) this.manager.setTrackVolume(parseInt(e.target.value) / 100);
        });
        document.getElementById('music-mute-btn').addEventListener('click', () => {
            if (!this.manager) return;
            const muted = this.manager.toggleMute();
            const btn = document.getElementById('music-mute-btn');
            btn.classList.toggle('active', muted); btn.textContent = muted ? 'Unmute' : 'Mute';
        });
        document.getElementById('music-note-type').addEventListener('change', (e) => {
            if (this.manager) { this.manager.currentDuration = e.target.value; this.manager.eraserMode = false; }
            document.getElementById('music-eraser-btn').classList.remove('active');
        });
        document.getElementById('music-eraser-btn').addEventListener('click', () => {
            if (this.manager) this.manager.eraserMode = !this.manager.eraserMode;
            document.getElementById('music-eraser-btn').classList.toggle('active', this.manager?.eraserMode);
        });

        // Tempo
        const tempoSlider = document.getElementById('music-tempo');
        const tempoLabel = document.getElementById('music-tempo-label');
        tempoSlider.addEventListener('input', () => {
            tempoLabel.textContent = tempoSlider.value;
            if (this.manager) this.manager.setTempo(parseInt(tempoSlider.value));
        });

        // Master volume + Loop + Metronome + Export
        document.getElementById('music-master-vol').addEventListener('input', (e) => {
            if (this.manager) this.manager.setMasterVolume(parseInt(e.target.value) / 100);
        });
        document.getElementById('music-loop-btn').addEventListener('click', () => {
            if (this.manager) { this.manager.setLoop(!this.manager.loop); document.getElementById('music-loop-btn').classList.toggle('active', this.manager.loop); }
        });
        document.getElementById('music-metro-btn').addEventListener('click', () => {
            if (this.manager) { this.manager.setMetronome(!this.manager.metronome); document.getElementById('music-metro-btn').classList.toggle('active', this.manager.metronome); }
        });
        document.getElementById('music-export-btn').addEventListener('click', () => {
            if (this.manager) this.manager.exportWav(this.compositionName);
        });

        // Playback
        document.getElementById('music-clear-btn').addEventListener('click', () => { if (this.manager) this.manager.clear(); });
        document.getElementById('music-rewind').addEventListener('click', () => { if (this.manager) this.manager.rewind(); });
        document.getElementById('music-skip-back').addEventListener('click', () => { if (this.manager) this.manager.skipBack(); });
        document.getElementById('music-play').addEventListener('click', () => { if (this.manager) this.manager.play(); });
        document.getElementById('music-pause').addEventListener('click', () => { if (this.manager) this.manager.pause(); });
        document.getElementById('music-stop').addEventListener('click', () => { if (this.manager) this.manager.stop(); });
        document.getElementById('music-skip-fwd').addEventListener('click', () => { if (this.manager) this.manager.skipForward(); });

        // Seek bar
        document.getElementById('music-seek').addEventListener('input', (e) => {
            if (this.manager) this.manager.seek(parseFloat(e.target.value));
        });

        // Add track
        document.getElementById('music-add-track').addEventListener('click', () => this._addTrack());
    }

    _startEditor() {
        this.compositionName = document.getElementById('music-name-input').value.trim() || 'Untitled';
        document.getElementById('music-lobby').style.display = 'none';
        document.getElementById('music-editor').style.display = '';
        document.getElementById('music-title').textContent = '\u266A ' + this.compositionName;

        this.manager = new StaffManager(
            document.getElementById('music-canvas'),
            document.getElementById('music-canvas-scroll'),
            this.synth,
            {
                onNoteCountChange: (count) => {
                    document.getElementById('music-note-count').textContent = count + ' note' + (count !== 1 ? 's' : '');
                },
                onPlayStateChange: (state) => {
                    document.getElementById('music-play').disabled = (state === 'playing');
                    document.getElementById('music-pause').disabled = (state !== 'playing');
                    document.getElementById('music-stop').disabled = (state === 'stopped');
                },
                onPositionChange: (text) => {
                    document.getElementById('music-position').textContent = text;
                },
                onSeekUpdate: (beat, total) => {
                    const seek = document.getElementById('music-seek');
                    seek.max = total;
                    seek.value = beat;
                },
            }
        );
        this.manager.setSaveName(this.compositionName);
        this._rebuildTabs();
        this._updateTrackControls();
        setTimeout(() => this.manager._resize(), 50);
    }

    _rebuildTabs() {
        const tabsEl = document.getElementById('music-track-tabs');
        const addBtn = document.getElementById('music-add-track');
        // Remove old tabs (keep add button)
        tabsEl.querySelectorAll('.music-track-tab').forEach(t => t.remove());
        this.manager.tracks.forEach((track, i) => {
            const tab = document.createElement('button');
            tab.className = 'music-track-tab' + (i === this.manager.activeTrack ? ' active' : '');
            tab.dataset.track = i;
            const label = 'Track ' + (i + 1);
            tab.innerHTML = label + ' <span class="music-track-x" data-track="' + i + '">&times;</span>';
            tab.addEventListener('click', (e) => {
                if (e.target.classList.contains('music-track-x')) {
                    this._removeTrack(parseInt(e.target.dataset.track));
                    return;
                }
                this.manager.switchTrack(i);
                tabsEl.querySelectorAll('.music-track-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this._updateTrackControls();
            });
            tabsEl.insertBefore(tab, addBtn);
        });
    }

    _addTrack() {
        if (!this.manager) return;
        this.manager.addTrack();
        this.manager.switchTrack(this.manager.tracks.length - 1);
        this._rebuildTabs();
        this._updateTrackControls();
    }

    _removeTrack(idx) {
        if (!this.manager || this.manager.tracks.length <= 1) return;
        this.manager.removeTrack(idx);
        this._rebuildTabs();
        this._updateTrackControls();
    }

    _updateTrackControls() {
        if (!this.manager) return;
        const track = this.manager.tracks[this.manager.activeTrack];
        document.getElementById('music-instrument').value = track.instrument;
        document.getElementById('music-track-vol').value = Math.round(track.volume * 100);
        const muteBtn = document.getElementById('music-mute-btn');
        muteBtn.classList.toggle('active', track.muted);
        muteBtn.textContent = track.muted ? 'Unmute' : 'Mute';
        this._updateStatusBar();
    }

    _updateStatusBar() {
        if (!this.manager) return;
        const sel = document.getElementById('music-instrument');
        const instName = sel.options[sel.selectedIndex].text;
        document.getElementById('music-status-instrument').textContent =
            'Track ' + (this.manager.activeTrack + 1) + ': ' + instName;
    }

    onLaunch() {
        document.getElementById('music-name-input').focus();
        this._showSavedList();
    }

    _showSavedList() {
        const el = document.getElementById('music-saved-list');
        const saved = StaffManager.listSaved();
        if (!saved.length) { el.innerHTML = ''; return; }
        el.innerHTML = '<div class="lobby-divider">&mdash; or resume a saved composition &mdash;</div>';
        saved.forEach(name => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; justify-content:center; gap:8px; margin:6px 0;';
            const btn = document.createElement('button');
            btn.className = 'lobby-btn';
            btn.style.cssText = 'padding:6px 20px; font-size:12px; margin:0;';
            btn.textContent = name;
            btn.addEventListener('click', () => this._loadComposition(name));
            const del = document.createElement('button');
            del.className = 'music-toolbar-btn';
            del.style.cssText = 'padding:4px 8px; font-size:10px; margin:0;';
            del.textContent = '\u00D7';
            del.title = 'Delete';
            del.addEventListener('click', () => { StaffManager.deleteSaved(name); this._showSavedList(); });
            row.appendChild(btn);
            row.appendChild(del);
            el.appendChild(row);
        });
    }

    _loadComposition(name) {
        const data = StaffManager.loadSaved(name);
        if (!data) return;
        this.compositionName = name;
        document.getElementById('music-lobby').style.display = 'none';
        document.getElementById('music-editor').style.display = '';
        document.getElementById('music-title').textContent = '\u266A ' + name;

        this.manager = new StaffManager(
            document.getElementById('music-canvas'),
            document.getElementById('music-canvas-scroll'),
            this.synth,
            {
                onNoteCountChange: (count) => {
                    document.getElementById('music-note-count').textContent = count + ' note' + (count !== 1 ? 's' : '');
                },
                onPlayStateChange: (state) => {
                    document.getElementById('music-play').disabled = (state === 'playing');
                    document.getElementById('music-pause').disabled = (state !== 'playing');
                    document.getElementById('music-stop').disabled = (state === 'stopped');
                },
                onPositionChange: (text) => {
                    document.getElementById('music-position').textContent = text;
                },
                onSeekUpdate: (beat, total) => {
                    const seek = document.getElementById('music-seek');
                    seek.max = total;
                    seek.value = beat;
                },
            }
        );
        this.manager.setSaveName(name);
        this.manager.loadFromData(data);
        document.getElementById('music-tempo').value = this.manager.tempo;
        document.getElementById('music-tempo-label').textContent = this.manager.tempo;
        document.getElementById('music-master-vol').value = Math.round(this.manager.masterVolume * 100);
        this._rebuildTabs();
        this._updateTrackControls();
        setTimeout(() => this.manager._resize(), 50);
    }

    onClose() {
        if (this.manager) { this.manager.destroy(); this.manager = null; }
        document.getElementById('music-lobby').style.display = '';
        document.getElementById('music-editor').style.display = 'none';
        document.getElementById('music-name-input').value = '';
        document.getElementById('music-title').textContent = '\u266A ' + (window.JSOS_CONFIG?.note || 'JS Note');
    }
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
        this.registerApp(new MusicMakerApp(this));
        this.registerApp(new JSTubeApp(this));
        this.registerApp(new JSCallApp(this));

        // Apply config names
        this._applyConfig();

        // Splash screen
        this._bindSplash();
    }

    _applyConfig() {
        const cfg = window.JSOS_CONFIG;
        if (!cfg) return;
        if (cfg.os) document.title = cfg.os;
        document.querySelectorAll('[data-name]').forEach(el => {
            const key = el.dataset.name;
            if (!cfg[key]) return;
            const prefix = el.dataset.namePrefix || '';
            el.textContent = prefix + cfg[key];
        });
        log.info('DESKTOP', 'Config applied');
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
                '<div class="error-dialog-titlebar"><span>' + (window.JSOS_CONFIG?.os || 'JS OS') + ' - Error</span></div>' +
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
