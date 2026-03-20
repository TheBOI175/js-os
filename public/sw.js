// Force new SW to activate immediately (replaces old cached version)
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(event) { event.waitUntil(clients.claim()); });

// Service Worker for JS OS - enables background notifications
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
