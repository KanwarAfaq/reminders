const KEY = 'hub.key';
export const getKey = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setKey = k => { try { k ? localStorage.setItem(KEY, k) : localStorage.removeItem(KEY); } catch { /* private mode */ } };

export async function api(op, body = {}) {
  const get = op === 'config' || op === 'tick';
  const res = await fetch(get ? `/api/hub?op=${op}` : '/api/hub', get ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-key': getKey() }, body: JSON.stringify({ op, ...body }),
  });
  let j = {}; try { j = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) { const e = new Error(j.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return j;
}
