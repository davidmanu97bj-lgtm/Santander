/* Compatibilidad validada: v4014-role-guard */
/* EXPLORA PWA service worker · v2.5.2 */
const CACHE_PREFIX = 'explora-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v4014-role-guard`;

const LEGACY_MILEAGE_STUB = `
const noop=()=>{};const asyncTrue=async()=>true;
function kill(){try{document.querySelectorAll('#mileageOverlay,.mileage-overlay,#mileageDashboardCard,#mileageClosureCard,#mileageAdminAlertsCard').forEach(n=>n.remove());document.body&&document.body.classList.add('explora-legacy-mileage-off');document.documentElement.classList.add('explora-legacy-mileage-off');if(document.body&&document.body.style&&document.body.style.overflow==='hidden')document.body.style.overflow='';}catch(e){}}
window.EXPLORA_DISABLE_LEGACY_MILEAGE=true;
window.__EXPLORA_KILL_LEGACY_MILEAGE__=kill;
window.ExploraMileageControl=Object.freeze({disabled:true,refresh:async()=>null,open:()=>false,ensureBeforeBilling:asyncTrue,startReminder:noop,stopReminder:noop,scheduleReminder:noop,getStartGraceState:()=>({disabled:true}),getState:()=>({disabled:true,firebaseReady:false,storageReady:false}),parseNumber:v=>Number(v)||0,classify:()=>({disabled:true}),ensureFirebase:async()=>null,stableHash:v=>String(v||''),idempotentAlertId:()=>'',vehicleIsOperational:()=>true,canonicalAssignmentMatches:()=>true});
kill();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',kill,{once:true});try{new MutationObserver(kill).observe(document.documentElement,{childList:true,subtree:true});}catch(e){};setTimeout(kill,50);setTimeout(kill,300);setTimeout(kill,1200);console.info('EXPLORA_LEGACY_MILEAGE_SW_STUB_v4013');export {};
`;

const APP_SHELL = [
  './',
  './index.html',
  './css/segments/46-style.css',
  './css/segments/47-style.css?v=2411-logo',
  './css/segments/07-style.css?v=3921-billing-visual-fix',
  './js/segments/09-script.js',
  './js/segments/07-script.js?v=3921-billing-visual-fix',
  './js/segments/13-script.mjs?v=248-payment-receipts-facturaste-gastaste-finance-nav-fix',
  './css/segments/32-style.css?v=2445-finance-nav-fix',
  './css/segments/38-style.css?v=2445-finance-nav-fix',
  './js/segments/01-script.js?v2442-weekly-payment-production',
  './js/segments/19-script.mjs?v2442-weekly-payment-production',
  './js/segments/11-script.mjs?v4014-role-guard',
  './js/core/weekly-core.mjs?v2442-weekly-payment-production',
  './css/segments/45-style.css?v=2440-weekly-closure-cash-record-recovery',
  './css/segments/44-style.css?v=2503-more-white-exit',
  './css/segments/50-style.css?v=2458-admin-driver-production-safe',
  './css/segments/02-style.css?v=3911-logo-real-header',
  './css/segments/51-style.css?v=4013-hard-disable-km',
  './css/segments/52-style.css?v=4013-hard-disable-km',
  './js/segments/52-script.mjs?v=4013-hard-disable-km',
  './assets/icono_eficiencia_km.png',
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

function noStoreResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: false }) || await cache.match(new URL(request.url).pathname.replace(/^\//,''));
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

  if (/\/js\/segments\/49-script\.mjs$/i.test(url.pathname)) {
    event.respondWith(new Response(LEGACY_MILEAGE_STUB, {
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
      }
    }));
    return;
  }

  // Keep Firebase/Auth and API-like calls outside the offline cache.
  if (url.pathname.includes('/__/auth/') || url.pathname.includes('/api/')) return;

  event.respondWith(networkFirst(request));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* cache bump: v4014 role guard */
