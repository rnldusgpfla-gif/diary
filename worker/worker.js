/*
  하루 한 장 → 노션 중계 서버 (Cloudflare Worker)

  필요한 설정 (Cloudflare 대시보드 → 이 Worker → Settings → Variables and Secrets):
    NOTION_TOKEN  (Secret)  노션 통합(Integration)의 키. ntn_ 으로 시작
    DIARY_KEY     (Secret)  앱과 이 서버만 아는 비밀 문자열. 앱 설정의 "연결 키"에 같은 값을 넣어요
    DATABASE_ID   (Text)    a4ae47a9d4b24d8da934b9aeba406de8  (💻 다이어리 표)
    ALLOW_ORIGIN  (Text)    https://rnldusgpfla-gif.github.io  (앱 주소. 비워 두면 어디서나 허용)
    NOTES_DB_ID   (Text, 선택) 끄적 표. 비워 두면 아래 기본값을 써요

  POST /sync  {date, body, summary, tags, rating, owned}
    같은 날짜 줄을 찾아(없으면 만들고) 본문·summary·태그·별점을 채워요.
    노션에서 직접 글을 써 둔 날(owned=false 이고 페이지가 비어 있지 않음)은 건드리지 않고 skipped 로 답해요.
  POST /note  {id, text, createdAt, deleted}
    끄적 표에서 같은 "앱 ID" 줄을 찾아(없으면 만들고) 내용을 채워요. deleted 면 그 줄을 휴지통으로 보내요.
*/
const NOTION_VERSION = '2022-06-28';
const DEFAULT_NOTES_DB = '41dcadd403048169a965e51df02653d4';

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Diary-Key',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') return out({ ok: true, hello: '하루 한 장 중계 서버', notes: true });
    if (req.method !== 'POST' || (url.pathname !== '/sync' && url.pathname !== '/note')) return out({ ok: false, error: 'not found' }, 404);
    if (!env.DIARY_KEY || req.headers.get('X-Diary-Key') !== env.DIARY_KEY) return out({ ok: false, error: 'wrong key' }, 401);
    if (!env.NOTION_TOKEN || !env.DATABASE_ID) return out({ ok: false, error: 'server not set up' }, 500);

    let p;
    try { p = await req.json(); } catch { return out({ ok: false, error: 'bad json' }, 400); }

    const notion = async (path, method = 'GET', body) => {
      const r = await fetch('https://api.notion.com' + path, {
        method,
        headers: { 'Authorization': 'Bearer ' + env.NOTION_TOKEN, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j && j.message) || ('notion ' + r.status));
      return j;
    };
    const text = s => {
      const parts = [];
      for (let i = 0; i < s.length && parts.length < 100; i += 2000) parts.push({ type: 'text', text: { content: s.slice(i, i + 2000) } });
      return parts;
    };
    const listBlocks = async pageId => {
      const blocks = [];
      let cursor;
      do {
        const r = await notion(`/v1/blocks/${pageId}/children?page_size=100` + (cursor ? '&start_cursor=' + cursor : ''));
        blocks.push(...r.results);
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      return blocks;
    };
    const replaceBody = async (pageId, blocks, body) => {
      for (const b of blocks) await notion(`/v1/blocks/${b.id}`, 'DELETE');
      const paras = String(body || '').replace(/\r/g, '').split(/\n{2,}/).map(s => s.replace(/^\n+|\n+$/g, '')).filter(s => s.trim());
      const children = paras.map(s => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: text(s) } }));
      for (let i = 0; i < children.length; i += 100) await notion(`/v1/blocks/${pageId}/children`, 'PATCH', { children: children.slice(i, i + 100) });
    };

    try {
      if (url.pathname === '/note') {
        const id = String(p.id || '');
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return out({ ok: false, error: 'bad id' }, 400);
        const db = env.NOTES_DB_ID || DEFAULT_NOTES_DB;
        const q = await notion(`/v1/databases/${db}/query`, 'POST', { filter: { property: '앱 ID', rich_text: { equals: id } }, page_size: 1 });
        let pageId = q.results && q.results[0] && q.results[0].id;
        if (p.deleted) {
          if (pageId) await notion(`/v1/pages/${pageId}`, 'PATCH', { archived: true });
          return out({ ok: true, deleted: true });
        }
        const body = String(p.text || '');
        const first = (body.split('\n').map(s => s.trim()).filter(Boolean)[0] || '(빈 조각)').slice(0, 100);
        const props = { '내용': { title: text(first) }, '앱 ID': { rich_text: text(id) } };
        if (p.createdAt) props['작성'] = { date: { start: String(p.createdAt) } };
        let blocks = [];
        if (!pageId) pageId = (await notion('/v1/pages', 'POST', { parent: { database_id: db }, properties: props })).id;
        else { await notion(`/v1/pages/${pageId}`, 'PATCH', { properties: props }); blocks = await listBlocks(pageId); }
        await replaceBody(pageId, blocks, body);
        return out({ ok: true, pageId });
      }

      const date = String(p.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return out({ ok: false, error: 'bad date' }, 400);
      // 1. the row for this date (or a new one)
      const q = await notion(`/v1/databases/${env.DATABASE_ID}/query`, 'POST', { filter: { property: 'Date', date: { equals: date } }, page_size: 1 });
      let pageId = q.results && q.results[0] && q.results[0].id;
      let created = false;
      if (!pageId) {
        const c = await notion('/v1/pages', 'POST', {
          parent: { database_id: env.DATABASE_ID },
          properties: { Title: { title: text(date) }, Date: { date: { start: date } } }
        });
        pageId = c.id; created = true;
      }
      // 2. leave pages written directly in Notion alone
      const blocks = await listBlocks(pageId);
      if (!created && !p.owned && blocks.length) return out({ ok: true, skipped: true, pageId });
      // 3. replace the body
      await replaceBody(pageId, blocks, p.body);
      // 4. summary, tags, rating
      await notion(`/v1/pages/${pageId}`, 'PATCH', {
        properties: {
          summary: { rich_text: text(String(p.summary || '').slice(0, 2000)) },
          '태그': { rich_text: text(String(p.tags || '').slice(0, 2000)) },
          ...('rating' in p ? { '별점': { number: Number(p.rating) > 0 ? Math.min(5, Number(p.rating)) : null } } : {})
        }
      });
      return out({ ok: true, pageId });
    } catch (e) {
      return out({ ok: false, error: String(e && e.message || e) }, 502);
    }
  }
};
