/* Compatibilidad validada: v4011-whatsapp-nativo */
/* EXPLORA PWA service worker · v2.5.1 */
const CACHE_PREFIX = 'explora-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v4011-whatsapp-nativo`;
const APP_SHELL = [
  './',
  './index.html',
  './css/segments/46-style.css',
  './css/segments/47-style.css?v=2411-logo',
  './css/segments/48-style.css?v=2412-ranking-mobile',
  './css/segments/07-style.css?v=3921-billing-visual-fix',
  './js/segments/09-script.js',
  './js/segments/07-script.js?v=3921-billing-visual-fix',
  './js/segments/13-script.mjs?v=248-payment-receipts-facturaste-gastaste-finance-nav-fix',
  './css/segments/32-style.css?v=2445-finance-nav-fix',
  './css/segments/38-style.css?v=2445-finance-nav-fix',
  './js/segments/01-script.js?v2442-weekly-payment-production',
  './js/segments/18-script.mjs?v2442-weekly-payment-production',
  './js/segments/19-script.mjs?v2442-weekly-payment-production',
  './js/segments/11-script.mjs?v3911-logo-real-header',
  './js/segments/35-script.mjs?v2442-weekly-payment-production',
  './js/core/weekly-core.mjs?v2442-weekly-payment-production',
  './css/segments/45-style.css?v=2440-weekly-closure-cash-record-recovery',
  './css/segments/44-style.css?v=2503-more-white-exit',
  './js/segments/43-script.mjs?v2442-weekly-payment-production',
  './css/segments/49-style.css?v=2456-personal-record-server-authoritative',
  './css/segments/50-style.css?v=2458-admin-driver-production-safe',
  './css/segments/51-style.css?v=2484-weekly-mileage-modal-ux',
  './css/segments/02-style.css?v=3911-logo-real-header',
  './css/segments/52-style.css?v=4011-whatsapp-nativo',
  './js/segments/52-script.mjs?v=4011-whatsapp-nativo',
  './assets/icono_eficiencia_km.png',
  './js/segments/49-script.mjs?v=2488-mileage-close-fast',
  './js/segments/49-mileage-model.mjs?v=2477-weekly-mileage-v15-admin-card-clickable',
  './js/segments/44-script.mjs?v=2456-personal-record-server-authoritative',
  './manifest.webmanifest?v=2411',
  './icons/favicon-v2411.svg',
  './icons/favicon-32-v2411.png',
  './icons/apple-touch-icon-v2411.png',
  './icons/icon-192-v2411.png',
  './icons/icon-512-v2411.png',
  './icons/icon-maskable-512-v2411.png',
  './icons/explora-logo-horizontal-v2411.png',
  './icons/explora-mark-transparent-v2411.png',
  './icons/explora-logo-real-mark-v3911.png',
  './icons/explora-logo-real-horizontal-v3911.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(APP_SHELL.map(async (asset) => {
      const response = await fetch(asset, { cache: 'reload' });
      if (response && response.ok) await cache.put(asset, response.clone());
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html') || await cache.match('./');
      if (fallback) return fallback;
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Keep Firebase/Auth and API-like calls outside the offline cache.
  if (url.pathname.includes('/__/auth/') || url.pathname.includes('/api/')) return;

  event.respondWith(networkFirst(request));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* cache bump: v3921 billing visual fix */

/* cache bump: v3924 billing modal solid background */
