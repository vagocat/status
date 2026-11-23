// Vagocat status: checks every 5 minutes (cron), up/down only, and serves the result at /status.json.
import { connect } from 'cloudflare:sockets';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const limit = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout'); })]);

async function http(url, want) {
  const r = await fetch(url, { headers: { 'User-Agent': 'vagocat-status' }, signal: AbortSignal.timeout(20000), cf: { cacheTtl: 0 } });
  const body = await r.text();
  if (r.status !== 200) throw new Error('http ' + r.status);
  if (want && !body.includes(want)) throw new Error('unexpected content');
}
async function tls(hostname, port) {
  const s = connect({ hostname, port }, { secureTransport: 'on', allowHalfOpen: false });
  s.closed.catch(() => {});
  try {
    await limit(s.opened, 15000);
    const { value } = await limit(s.readable.getReader().read(), 15000);
    if (!value || !value.length) throw new Error('no greeting');
  } finally { s.close().catch(() => {}); }
}
async function dns(hostname, name) {
  const id = [Math.random() * 256 | 0, Math.random() * 256 | 0];
  const q = [...id, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const p of name.split('.')) q.push(p.length, ...new TextEncoder().encode(p));
  q.push(0, 0, 6, 0, 1);
  const s = connect({ hostname, port: 53 }, { allowHalfOpen: false });
  s.closed.catch(() => {});
  try {
    const w = s.writable.getWriter();
    await limit(w.write(new Uint8Array([q.length >> 8, q.length & 255, ...q])), 15000);
    const rd = s.readable.getReader();
    let a = [];
    while (a.length < 14) {
      const { value, done } = await limit(rd.read(), 15000);
      if (done) break;
      a.push(...value);
    }
    a = a.slice(2);
    if (a.length < 12 || a[0] !== id[0] || a[1] !== id[1] || (a[3] & 15) || !((a[6] << 8) | a[7])) throw new Error('bad dns answer');
  } finally { s.close().catch(() => {}); }
}

const SERVICES = [
  ['DNS / Domains', [() => dns('erebus.vagocat.com', 'gracivo.org')]],
  ['Email', [() => http('https://webmail.vagocat.com/'), () => tls('mail.vagocat.com', 993), () => tls('mail.vagocat.com', 465)]],
  ['Hosting', [() => http('https://gracivo.org/vc-check', 'vc-42')]],
  ['Control Panel', [() => http('https://panel.vagocat.com:8083/login/')]],
  ['Account Manager', [() => http('https://my.vagocat.com/login')]],
  ['Website', [() => http('https://vagocat.com/api/health/', 'ok')]],
];

async function ok(fn, errors, label) {
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(10000);
    try { await fn(); return true; } catch (e) { if (i === 2) errors.push(label + ': ' + e.message); }
  }
  return false;
}

async function run(env) {
  const errors = [];
  // One service after another: a Worker may only hold a few connections open at once.
  const services = [];
  for (const [name, checks] of SERVICES) {
    const r = [];
    for (let i = 0; i < checks.length; i++) r.push(await ok(checks[i], errors, name + ' #' + (i + 1)));
    services.push({ name, state: r.every(Boolean) ? 'operational' : r.some(Boolean) ? 'partial' : 'major' });
  }
  const now = new Date().toISOString();
  const prev = (await env.STATUS.get('status', 'json')) || { notices: [] };
  const notices = prev.notices || [];
  for (const s of services) {
    const open = notices.find(n => n.service === s.name && !n.closed);
    if (s.state !== 'operational' && !open)
      notices.unshift({ kind: 'incident', service: s.name, title: s.name + ' - service disruption',
        body: 'We are investigating a problem affecting ' + s.name + '.', opened: now, closed: null });
    else if (s.state === 'operational' && open) open.closed = now;
  }
  await env.STATUS.put('status', JSON.stringify({ checked: now, services, notices: notices.slice(0, 100), errors }));
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); },
  async fetch(req, env) {
    if (new URL(req.url).pathname !== '/status.json') return new Response('Not found', { status: 404 });
    const d = await env.STATUS.get('status', 'json');
    if (!d) return new Response('{}', { status: 503, headers: { 'Access-Control-Allow-Origin': '*' } });
    delete d.errors;
    return new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' } });
  },
};
