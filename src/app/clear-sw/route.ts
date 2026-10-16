// Force-clear page: serves a minimal HTML that unregisters ALL service workers
// and clears ALL caches, then redirects to /.
//
// IMPORTANT: This route is NOT intercepted by the stale SW because:
//   1. SW's fetch handler has `if (url.pathname.startsWith('/api/')) return;` →
//      but we use a page route, not API. However, the SW's navigation handler
//      is `network-first`, meaning it tries the network first and only falls
//      back to cache on failure. So a fresh URL like /clear-sw will always
//      hit the network and get this fresh HTML.
//   2. Even if the SW tried to cache it, the URL has never been requested
//      before, so there's no cached entry to fall back to.
//
// Usage: Visit /clear-sw in your browser, then you'll be redirected to /.

export const dynamic = "force-static";

export function GET() {
  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Clearing cache... | MEKANIX</title>
<style>
  body { background: #050607; color: #fff; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { text-align: center; padding: 2rem; }
  .spinner { width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1); border-top-color: #F5A524; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 1rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { font-size: 0.85rem; color: rgba(255,255,255,0.6); margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>در حال پاک‌سازی cache...</h1>
    <p>لطفاً صبر کنید، چند ثانیه طول می‌کشد.</p>
  </div>
  <script>
    (async () => {
      try {
        // 1. Unregister ALL service workers
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) {
            await r.unregister();
            console.log('Unregistered SW:', r.scope);
          }
        }
        // 2. Delete ALL caches
        if (window.caches) {
          const keys = await caches.keys();
          for (const k of keys) {
            await caches.delete(k);
            console.log('Deleted cache:', k);
          }
        }
        // 3. Clear local/session storage too (in case stale state)
        try { localStorage.clear(); } catch (e) {}
        try { sessionStorage.clear(); } catch (e) {}
        // 4. Wait briefly, then redirect to /
        setTimeout(() => { window.location.href = '/'; }, 800);
      } catch (e) {
        // If anything fails, still try to redirect
        console.error('Clear failed:', e);
        setTimeout(() => { window.location.href = '/'; }, 1500);
      }
    })();
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
