// ─── JS OS Service Worker (PWA + Notifications) ───
const CACHE_NAME = 'jsos-v1';
const CACHE_ASSETS = [
    '/',
    '/index.html',
    '/css/style.css',
    '/js/config.js',
    '/js/app.js',
    '/images/logo.png',
    '/sounds/startup.mp3',
    '/sounds/message_sent.mp3',
    '/sounds/minimize_fullscreen_close.mp3',
    '/manifest.json',
];

// Install: cache core assets
self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.addAll(CACHE_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate: clean old caches, claim clients
self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(names) {
            return Promise.all(
                names.filter(function(name) { return name !== CACHE_NAME; })
                     .map(function(name) { return caches.delete(name); })
            );
        }).then(function() { return clients.claim(); })
    );
});

// Fetch: network-first for API/WS, cache-fallback for assets
self.addEventListener('fetch', function(event) {
    var url = new URL(event.request.url);

    // Skip non-GET, API calls, and WebSocket upgrades
    if (event.request.method !== 'GET') return;
    if (url.pathname.startsWith('/api/')) return;
    if (url.pathname === '/health') return;

    event.respondWith(
        fetch(event.request).then(function(response) {
            // Cache successful responses
            if (response.ok) {
                var clone = response.clone();
                caches.open(CACHE_NAME).then(function(cache) {
                    cache.put(event.request, clone);
                });
            }
            return response;
        }).catch(function() {
            // Network failed — serve from cache
            return caches.match(event.request);
        })
    );
});

// ─── Push Notifications ───
self.addEventListener('message', function(event) {
    if (!event.data || !event.data.type) return;

    if (event.data.type === 'NOTIFY') {
        self.registration.showNotification(event.data.title || 'JS OS', {
            body: event.data.body || '',
            icon: 'images/logo.png',
            badge: 'images/logo.png',
            tag: event.data.tag || 'default',
            vibrate: [200, 100, 200],
            requireInteraction: false,
        });
    }
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(function(clientList) {
            for (var i = 0; i < clientList.length; i++) {
                if ('focus' in clientList[i]) return clientList[i].focus();
            }
            if (clients.openWindow) return clients.openWindow('/');
        })
    );
});
