/**
 * Served as /sw.js on retired TrustID addresses (trustid.getlifeos.app).
 *
 * A PWA service worker answers navigations from its cache, so a redirect at the
 * host never reaches users who already installed the app there. This worker
 * replaces the old one, deletes that origin's caches, unregisters itself and
 * reloads its pages, which then reach the network and its 301 to the canonical
 * address (trustedid.netlify.app).
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
      const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const page of pages) {
        try {
          await page.navigate(page.url);
        } catch {
          /* page closed or cross-origin: it reloads on its next navigation */
        }
      }
    })(),
  );
});
