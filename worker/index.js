const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function checkAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = atob(header.slice(6));
  const [, pass] = decoded.split(':');
  return pass === env.APP_PASSWORD;
}

async function runMigrations(env) {
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS entries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        url         TEXT,
        due_date    TEXT,
        tags        TEXT,
        status      TEXT DEFAULT 'open',
        ai_summary  TEXT,
        raw_input   TEXT,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      )
    `).run();
  } catch (e) {}
}

async function parseWithAI(raw, env) {
  const today = new Date().toISOString().split('T')[0];
  const prompt = `Today's date is ${today}.

Given this input from a personal memory/task app: "${raw}"

Extract and return ONLY valid JSON (no markdown, no explanation) in this exact shape:
{
  "type": "task|note|bookmark|event",
  "title": "concise title",
  "body": "additional detail if any, else null",
  "url": "URL if present, else null",
  "due_date": "YYYY-MM-DD if a date/time is mentioned, else null",
  "tags": ["tag1", "tag2"],
  "ai_summary": "one-line summary of what this is"
}

Rules:
- type=task if it describes something to do
- type=event if it describes a calendar event or meeting
- type=bookmark if it contains a URL
- type=note otherwise
- Resolve relative dates like "Tuesday", "next week", "tomorrow" to absolute YYYY-MM-DD
- Keep title short (under 60 chars)
- Extract 1-3 relevant tags`;

  const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
  });

  const text = response.response.trim();
  // Strip markdown code fences if model includes them
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

async function searchWithAI(query, entries, env) {
  const entriesText = entries
    .map(e => `[${e.id}] ${e.type.toUpperCase()} — ${e.title}${e.due_date ? ` (due ${e.due_date})` : ''}${e.ai_summary ? `: ${e.ai_summary}` : ''}`)
    .join('\n');

  const prompt = `You are a personal assistant helping the user search their memory app called Cerebro.

User's query: "${query}"

Here are their stored entries:
${entriesText}

Respond with a helpful, conversational answer to the user's query. Reference specific entry IDs in brackets like [42] when mentioning entries. Be concise — 2-4 sentences max.`;

  const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
  });

  return response.response.trim();
}

export default {
  async fetch(request, env) {
    await runMigrations(env);

    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // All API routes require auth
    if (pathname.startsWith('/api/')) {
      if (!checkAuth(request, env)) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="Cerebro"', ...CORS },
        });
      }
    }

    // POST /api/capture — parse raw input with AI and save
    if (pathname === '/api/capture' && request.method === 'POST') {
      const { raw } = await request.json();
      if (!raw?.trim()) return json({ error: 'raw is required' }, 400);

      let parsed;
      try {
        parsed = await parseWithAI(raw.trim(), env);
      } catch (e) {
        return json({ error: `AI parsing failed: ${e.message}. Raw input saved anyway.` }, 500);
      }

      const { type, title, body, url: entryUrl, due_date, tags, ai_summary } = parsed;
      const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');

      const result = await env.DB.prepare(
        `INSERT INTO entries (type, title, body, url, due_date, tags, ai_summary, raw_input)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      ).bind(type, title, body || null, entryUrl || null, due_date || null, tagsStr, ai_summary || null, raw).first();

      return json({ entry: result });
    }

    // GET /api/entries — list entries
    if (pathname === '/api/entries' && request.method === 'GET') {
      const type = url.searchParams.get('type');
      const status = url.searchParams.get('status');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');

      let query = 'SELECT * FROM entries WHERE 1=1';
      const params = [];

      if (type) { query += ' AND type = ?'; params.push(type); }
      if (status) { query += ' AND status = ?'; params.push(status); }
      if (from) { query += ' AND (due_date >= ? OR (due_date IS NULL AND created_at >= ?))'; params.push(from, from); }
      if (to) { query += ' AND (due_date <= ? OR (due_date IS NULL AND created_at <= ?))'; params.push(to, to); }

      query += ' ORDER BY COALESCE(due_date, created_at) ASC, id DESC';

      const { results } = await env.DB.prepare(query).bind(...params).all();
      return json({ entries: results });
    }

    // GET /api/calendar?year=&month= — entries with due dates in that month
    if (pathname === '/api/calendar' && request.method === 'GET') {
      const year = url.searchParams.get('year') || new Date().getFullYear();
      const month = String(url.searchParams.get('month') || new Date().getMonth() + 1).padStart(2, '0');
      const from = `${year}-${month}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const to = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

      const { results } = await env.DB.prepare(
        `SELECT * FROM entries WHERE due_date >= ? AND due_date <= ? ORDER BY due_date ASC`
      ).bind(from, to).all();

      return json({ entries: results });
    }

    // PATCH /api/entries/:id — update an entry
    if (pathname.startsWith('/api/entries/') && request.method === 'PATCH') {
      const id = pathname.split('/')[3];
      const updates = await request.json();
      const allowed = ['title', 'body', 'url', 'due_date', 'tags', 'status', 'ai_summary'];
      const sets = [];
      const params = [];

      for (const key of allowed) {
        if (key in updates) {
          sets.push(`${key} = ?`);
          params.push(updates[key] === '' ? null : updates[key]);
        }
      }

      if (!sets.length) return json({ error: 'No valid fields to update' }, 400);

      sets.push(`updated_at = datetime('now')`);
      params.push(id);

      const result = await env.DB.prepare(
        `UPDATE entries SET ${sets.join(', ')} WHERE id = ? RETURNING *`
      ).bind(...params).first();

      if (!result) return json({ error: 'Not found' }, 404);
      return json({ entry: result });
    }

    // DELETE /api/entries/:id
    if (pathname.startsWith('/api/entries/') && request.method === 'DELETE') {
      const id = pathname.split('/')[3];
      await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    // GET /api/search?q=
    if (pathname === '/api/search' && request.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      if (!q.trim()) return json({ answer: '', entries: [] });

      // Fetch all entries (keep it simple for personal scale)
      const { results } = await env.DB.prepare(
        `SELECT * FROM entries WHERE status != 'archived' ORDER BY created_at DESC LIMIT 200`
      ).all();

      let answer;
      try {
        answer = await searchWithAI(q, results, env);
      } catch (e) {
        answer = `Search failed: ${e.message}`;
      }

      // Extract referenced IDs from answer like [42]
      const refIds = new Set([...answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])));
      const referenced = results.filter(e => refIds.has(e.id));

      return json({ answer, entries: referenced });
    }

    return json({ error: 'Not found' }, 404);
  },
};
