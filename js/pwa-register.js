/* EXPLORA PWA registration · v2.3.8 · hard cache refresh */
(() => {
  'use strict';
  if (!('serviceWorker' in navigator)) return;

  const BUILD = 'v4014-role-guard';
  const reloadOnceKey = `explora-sw-reload-${BUILD}`;

  const clearLegacyCaches = async () => {
    try {
      if (!('caches' in window)) return;
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((key) => key.startsWith('explora-pwa-') && !key.includes(BUILD))
        .map((key) => caches.delete(key)));
    } catch (error) {
      console.warn('[EXPLORA_PWA_CACHE_CLEAR_WARN]', error);
    }
  };

  const register = async () => {
    try {
      await clearLegacyCaches();
      const registration = await navigator.serviceWorker.register('./service-worker.js?build=v4014-role-guard', {
        scope: './',
        updateViaCache: 'none'
      });

      const activateWaiting = () => {
        if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      };

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed') activateWaiting();
        });
      });

      activateWaiting();
      registration.update().catch(() => {});

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        try {
          if (sessionStorage.getItem(reloadOnceKey) === '1') return;
          sessionStorage.setItem(reloadOnceKey, '1');
          window.location.reload();
        } catch (_) {
          window.location.reload();
        }
      });

      window.setInterval(() => {
        registration.update().catch(() => {});
      }, 30 * 60 * 1000);
    } catch (error) {
      console.error('[EXPLORA_PWA_REGISTRATION_ERROR]', error);
    }
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
