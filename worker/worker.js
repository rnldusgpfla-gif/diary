/*
  하루 한 장 → 중계 서버 (Cloudflare Worker)

  Settings → Variables and Secrets:
    NOTION_TOKEN  (Secret)  노션 통합 키 (ntn_…)
    DIARY_KEY     (Secret)  앱의 "연결 키"와 같은 값
    DATABASE_ID   (Text)    a4ae47a9d4b24d8da934b9aeba406de8  (💻 다이어리 표)
    ALLOW_ORIGIN  (Text)    https://rnldusgpfla-gif.github.io
    NOTES_DB_ID   (Text, 선택) 끄적 표. 비워 두면 아래 기본값
  Settings → Bindings:
    DIARY_KV      KV namespace (온라인 동기화와 밤 알림에 필요)
  Settings → Triggers → Cron:
    5분마다 실행 (Every 5 minutes) — 밤 알림 보내기, 노션에 못 간 것 다시 보내기

  앱 ↔ 서버
    POST /kv/list            서버에 있는 일기·끄적 목록과 고친 시각
    POST /kv/get  {keys}     내용 가져오기
    POST /kv/put  {items}    내용 올리기 (올라온 일기·끄적은 서버가 노션에도 써요)
    GET  /push/key           알림용 공개 키
    POST /push/subscribe     알림 켜기/끄기, 시간·문구 바꾸기
    POST /push/test          알림 시험
    POST /sync, /note        (예전 방식) 노션에 바로 쓰기
*/
const NOTION_VERSION = '2022-06-28';
const DEFAULT_NOTES_DB = '41dcadd403048169a965e51df02653d4';
const PUSH_SUBJECT = 'https://rnldusgpfla-gif.github.io/diary/';

/* ---------- small helpers ---------- */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const concat = (...arrs) => { const n = arrs.reduce((a, b) => a + b.length, 0); const o = new Uint8Array(n); let i = 0; for (const a of arrs) { o.set(a, i); i += a.length; } return o; };
const textParts = s => { const parts = []; for (let i = 0; i < s.length && parts.length < 100; i += 2000) parts.push({ type: 'text', text: { content: s.slice(i, i + 2000) } }); return parts; };

function makeNotion(env) {
  const call = async (path, method = 'GET', body) => {
    const r = await fetch('https://api.notion.com' + path, {
      method,
      headers: { 'Authorization': 'Bearer ' + env.NOTION_TOKEN, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.message) || ('notion ' + r.status));
    return j;
  };
  const listBlocks = async pageId => {
    const blocks = []; let cursor;
    do {
      const r = await call(`/v1/blocks/${pageId}/children?page_size=100` + (cursor ? '&start_cursor=' + cursor : ''));
      blocks.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return blocks;
  };
  const replaceBody = async (pageId, blocks, body) => {
    for (const b of blocks) await call(`/v1/blocks/${b.id}`, 'DELETE');
    const paras = String(body || '').replace(/\r/g, '').split(/\n{2,}/).map(s => s.replace(/^\n+|\n+$/g, '')).filter(s => s.trim());
    const children = paras.map(s => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: textParts(s) } }));
    for (let i = 0; i < children.length; i += 100) await call(`/v1/blocks/${pageId}/children`, 'PATCH', { children: children.slice(i, i + 100) });
  };
  /* one diary day → the 💻 다이어리 row with that date */
  const writeDay = async (p) => {
    const date = String(p.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date');
    const q = await call(`/v1/databases/${env.DATABASE_ID}/query`, 'POST', { filter: { property: 'Date', date: { equals: date } }, page_size: 1 });
    let pageId = q.results && q.results[0] && q.results[0].id, created = false;
    if (!pageId) {
      pageId = (await call('/v1/pages', 'POST', { parent: { database_id: env.DATABASE_ID }, properties: { Title: { title: textParts(date) }, Date: { date: { start: date } } } })).id;
      created = true;
    }
    const blocks = await listBlocks(pageId);
    if (!created && !p.owned && blocks.length) return { skipped: true, pageId };
    await replaceBody(pageId, blocks, p.body);
    await call(`/v1/pages/${pageId}`, 'PATCH', { properties: {
      summary: { rich_text: textParts(String(p.summary || '').slice(0, 2000)) },
      '태그': { rich_text: textParts(String(p.tags || '').slice(0, 2000)) },
      ...('rating' in p ? { '별점': { number: Number(p.rating) > 0 ? Math.min(5, Number(p.rating)) : null } } : {})
    } });
    return { pageId };
  };
  /* one note → the 끄적 row with the same 앱 ID */
  const writeNote = async (p) => {
    const id = String(p.id || '');
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('bad id');
    const db = env.NOTES_DB_ID || DEFAULT_NOTES_DB;
    const q = await call(`/v1/databases/${db}/query`, 'POST', { filter: { property: '앱 ID', rich_text: { equals: id } }, page_size: 1 });
    let pageId = q.results && q.results[0] && q.results[0].id;
    if (p.deleted) { if (pageId) await call(`/v1/pages/${pageId}`, 'PATCH', { archived: true }); return { deleted: true }; }
    const body = String(p.text || '');
    const first = (body.split('\n').map(s => s.trim()).filter(Boolean)[0] || '(빈 조각)').slice(0, 100);
    const props = { '내용': { title: textParts(first) }, '앱 ID': { rich_text: textParts(id) } };
    if (p.createdAt) props['작성'] = { date: { start: String(p.createdAt) } };
    let blocks = [];
    if (!pageId) pageId = (await call('/v1/pages', 'POST', { parent: { database_id: db }, properties: props })).id;
    else { await call(`/v1/pages/${pageId}`, 'PATCH', { properties: props }); blocks = await listBlocks(pageId); }
    await replaceBody(pageId, blocks, body);
    return { pageId };
  };
  return { writeDay, writeNote };
}

/* entry/note as stored by the app → what the Notion writers need */
function dayPayload(date, v, owned) {
  const body = String(v.body || '');
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean);
  return { date, body: v.title ? v.title + '\n\n' + body : body, summary: (v.title || lines[0] || '').slice(0, 100), tags: (v.tags || []).join(', '), rating: v.rating ? +v.rating : 0, owned };
}
function localIso(ms, tz) {
  const d = new Date(ms);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const off = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000), sg = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sg}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/* write one stored item to Notion; returns 'ok' | 'skipped' and the new "own" flag */
async function notionFor(env, k, v, meta, force, ownedHint) {
  const n = makeNotion(env);
  if (k.startsWith('e:')) {
    if (v.deleted) return { r: 'ok', own: meta.own };            // a deleted day stays in Notion as it was
    const res = await n.writeDay(dayPayload(k.slice(2), v, !!(meta.own || force || ownedHint)));
    return res.skipped ? { r: 'skipped', own: 0 } : { r: 'ok', own: 1 };
  }
  if (k.startsWith('n:')) {
    const tz = (meta && meta.tz) || 'Asia/Seoul';
    await n.writeNote(v.deleted ? { id: k.slice(2), deleted: true } : { id: k.slice(2), text: v.text, createdAt: v.createdAt ? localIso(v.createdAt, v.tz || tz) : undefined });
    return { r: 'ok', own: 1 };
  }
  return { r: 'ok', own: 0 };
}

/* ---------- Web Push (VAPID + aes128gcm), plain WebCrypto ---------- */
async function vapidKeys(env) {
  let saved = await env.DIARY_KV.get('push:vapid', 'json');
  if (!saved) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    saved = { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
    await env.DIARY_KV.put('push:vapid', JSON.stringify(saved));
  }
  return saved;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}
async function encryptPush(sub, payload) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPub.length;
  return concat(head, asPub, ct);
}
async function sendPush(env, sub, data) {
  const v = await vapidKeys(env);
  const aud = new URL(sub.endpoint).origin;
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const c = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT })));
  const pk = await crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pk, enc.encode(h + '.' + c));
  const body = await encryptPush(sub, JSON.stringify(data));
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Authorization': `vapid t=${h}.${c}.${b64u(sig)}, k=${v.pub}`, 'TTL': '43200', 'Urgency': 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' },
    body
  });
  return r.status;
}
async function pushAll(env, cfg, data) {
  const subs = cfg.subs || {};
  let sent = 0, changed = false;
  for (const ep of Object.keys(subs)) {
    const st = await sendPush(env, subs[ep], data).catch(() => 0);
    if (st === 404 || st === 410) { delete subs[ep]; changed = true; }
    else if (st >= 200 && st < 300) sent++;
  }
  if (changed) { cfg.subs = subs; await env.DIARY_KV.put('push:cfg', JSON.stringify(cfg)); }
  return sent;
}

/* ---------- the cron job: evening reminder + retrying Notion ---------- */
async function cron(env) {
  if (!env.DIARY_KV) return;
  const cfg = await env.DIARY_KV.get('push:cfg', 'json');
  if (cfg && cfg.enabled && cfg.subs && Object.keys(cfg.subs).length) {
    const tz = cfg.tz || 'Asia/Seoul';
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
    const today = `${p.year}-${p.month}-${p.day}`, nowMin = +p.hour * 60 + +p.minute;
    const [th, tm] = String(cfg.time || '22:00').split(':').map(Number), at = th * 60 + tm;
    if (nowMin >= at && nowMin - at < 60 && cfg.last !== today) {
      cfg.last = today;
      await env.DIARY_KV.put('push:cfg', JSON.stringify(cfg));
      let written = false;
      if (cfg.skipIfWritten) {
        const e = await env.DIARY_KV.get('e:' + today, 'json');
        written = !!(e && !e.deleted && (String(e.body || '').trim() || (e.photos || []).length));
      }
      if (!written) await pushAll(env, cfg, { title: cfg.title || '하루 한 장', body: cfg.body || '오늘 하루, 어땠어요?' });
    }
  }
  const pending = await env.DIARY_KV.get('notion:pending', 'json');
  if (pending && pending.length && env.NOTION_TOKEN) {
    const left = [];
    for (const k of pending.slice(0, 6)) {
      const got = await env.DIARY_KV.getWithMetadata(k, 'json');
      if (!got.value) continue;
      try {
        const meta = got.metadata || {};
        const res = await notionFor(env, k, got.value, meta, false, false);
        await env.DIARY_KV.put(k, JSON.stringify(got.value), { metadata: { ...meta, own: res.own, np: 0 } });
      } catch (e) { left.push(k); }
    }
    left.push(...pending.slice(6));
    await env.DIARY_KV.put('notion:pending', JSON.stringify(left));
  }
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(cron(env)); },

  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Diary-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url), path = url.pathname;
    if (req.method === 'GET' && path === '/') return out({ ok: true, hello: '하루 한 장 중계 서버', notes: true, sync: !!env.DIARY_KV, push: !!env.DIARY_KV });
    if (!env.DIARY_KEY || req.headers.get('X-Diary-Key') !== env.DIARY_KEY) return out({ ok: false, error: 'wrong key' }, 401);

    let p = {};
    if (req.method === 'POST') { try { p = await req.json(); } catch { return out({ ok: false, error: 'bad json' }, 400); } }
    const kv = env.DIARY_KV;
    const needKv = () => out({ ok: false, error: 'kv not set' }, 501);

    try {
      /* ----- sync store ----- */
      if (path === '/kv/list') {
        if (!kv) return needKv();
        const items = [];
        for (const prefix of ['e:', 'n:']) {
          let cursor;
          do {
            const r = await kv.list({ prefix, cursor });
            for (const k of r.keys) items.push({ k: k.name, u: (k.metadata && k.metadata.u) || 0, d: (k.metadata && k.metadata.d) || 0 });
            cursor = r.list_complete ? null : r.cursor;
          } while (cursor);
        }
        return out({ ok: true, items });
      }
      if (path === '/kv/get') {
        if (!kv) return needKv();
        const keys = (p.keys || []).filter(k => /^(e:\d{4}-\d{2}-\d{2}|n:[A-Za-z0-9_-]{6,64})$/.test(k)).slice(0, 50);
        const items = {};
        for (const k of keys) items[k] = await kv.get(k, 'json');
        return out({ ok: true, items });
      }
      if (path === '/kv/put') {
        if (!kv) return needKv();
        const results = {};
        let pending = null;
        for (const it of (p.items || []).slice(0, 4)) {
          const k = String(it.k || '');
          if (!/^(e:\d{4}-\d{2}-\d{2}|n:[A-Za-z0-9_-]{6,64})$/.test(k) || !it.v || typeof it.v !== 'object') { results[k] = 'bad'; continue; }
          const u = Number(it.u) || 0;
          const old = await kv.getWithMetadata(k, 'json');
          const meta = old.metadata || {};
          if (old.value && (meta.u || 0) >= u && !it.force) { results[k] = 'stale'; continue; }
          let own = meta.own || 0, np = 0, r = 'ok';
          if (env.NOTION_TOKEN && env.DATABASE_ID) {
            try { const res = await notionFor(env, k, it.v, meta, !!it.force, !!it.owned); own = res.own; r = res.r; }
            catch (e) { np = 1; r = 'notion_error'; }
          }
          await kv.put(k, JSON.stringify(it.v), { metadata: { u, d: it.v.deleted ? 1 : 0, own, np } });
          if (np) { pending = pending || (await kv.get('notion:pending', 'json')) || []; if (!pending.includes(k)) pending.push(k); }
          results[k] = r;
        }
        if (pending) await kv.put('notion:pending', JSON.stringify(pending));
        return out({ ok: true, results });
      }

      /* ----- evening reminder ----- */
      if (path === '/push/key') {
        if (!kv) return needKv();
        return out({ ok: true, key: (await vapidKeys(env)).pub });
      }
      if (path === '/push/subscribe') {
        if (!kv) return needKv();
        const cfg = (await kv.get('push:cfg', 'json')) || { subs: {} };
        cfg.subs = cfg.subs || {};
        if (p.subscription && p.subscription.endpoint && p.subscription.keys) {
          if (p.remove) delete cfg.subs[p.subscription.endpoint];
          else cfg.subs[p.subscription.endpoint] = { endpoint: p.subscription.endpoint, keys: p.subscription.keys };
        }
        for (const f of ['time', 'tz', 'body', 'title']) if (typeof p[f] === 'string') cfg[f] = p[f].slice(0, 200);
        if (typeof p.skipIfWritten === 'boolean') cfg.skipIfWritten = p.skipIfWritten;
        cfg.enabled = Object.keys(cfg.subs).length > 0;
        if (p.time && cfg.lastTime !== p.time) { cfg.last = ''; cfg.lastTime = p.time; }
        await kv.put('push:cfg', JSON.stringify(cfg));
        return out({ ok: true, enabled: cfg.enabled, devices: Object.keys(cfg.subs).length });
      }
      if (path === '/push/test') {
        if (!kv) return needKv();
        const cfg = (await kv.get('push:cfg', 'json')) || {};
        const sent = await pushAll(env, cfg, { title: cfg.title || '하루 한 장', body: (cfg.body || '오늘 하루, 어땠어요?') });
        return out({ ok: sent > 0, sent, error: sent ? undefined : 'no device' });
      }

      /* ----- older direct Notion calls ----- */
      if (!env.NOTION_TOKEN || !env.DATABASE_ID) return out({ ok: false, error: 'server not set up' }, 500);
      if (path === '/note') {
        const r = await makeNotion(env).writeNote(p);
        return out({ ok: true, ...r });
      }
      if (path === '/sync') {
        const r = await makeNotion(env).writeDay(p);
        return out({ ok: true, ...r });
      }
      return out({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return out({ ok: false, error: String(e && e.message || e) }, 502);
    }
  }
};
