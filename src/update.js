// Auto-update: compare the running build with the latest deployed one and reload when it changed.
const CURRENT = typeof __BUILD__ === 'undefined' ? 'dev' : __BUILD__;
window.__VER = new Date(Number(CURRENT) || Date.now()).toISOString().slice(0, 16).replace('T', ' ');
let busy = false;

export async function checkUpdate(manual = false) {
  if (busy) return 'Checking…'; busy = true;
  try {
    const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update().catch(() => {});
    const r = await fetch('/version.json?t=' + Date.now(), { cache: 'no-store' });
    const latest = (await r.json()).build;
    if (latest && CURRENT !== 'dev' && latest !== CURRENT) {
      const typing = document.querySelector('dialog[open], form input:focus, form textarea:focus');
      if (manual || !typing) { setTimeout(() => location.reload(), manual ? 600 : 0); return 'Updating to the latest version…'; }
      return 'Update ready';
    }
    return manual ? 'You are on the latest version' : '';
  } catch { return manual ? 'Could not check (offline?)' : ''; } finally { busy = false; }
}
export function startAutoUpdate() {
  setInterval(() => checkUpdate(), 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
  addEventListener('online', () => checkUpdate());
  checkUpdate();
}
