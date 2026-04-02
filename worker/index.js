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

// ── Migrations ──
async function runMigrations(env) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
      priority TEXT DEFAULT 'NORMAL', completed INTEGER DEFAULT 0,
      due_date TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
      start_time TEXT NOT NULL, end_time TEXT, color TEXT DEFAULT '#6366F1',
      is_important INTEGER DEFAULT 0, location TEXT DEFAULT '',
      recurrence_type TEXT DEFAULT 'NONE', recurrence_end TEXT,
      parent_event_id TEXT, exception_date TEXT, is_deleted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT DEFAULT '',
      event_id TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`,
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).run(); } catch (e) {}
  }
  // Column additions (safe to retry — D1 throws if column already exists)
  try { await env.DB.prepare(`ALTER TABLE notes ADD COLUMN tags TEXT DEFAULT ''`).run(); } catch(e) {}
}

// ── Recurring event generation ──
function advanceDate(date, recurrenceType) {
  const d = new Date(date);
  switch (recurrenceType) {
    case 'DAILY':    d.setDate(d.getDate() + 1); break;
    case 'WEEKLY':   d.setDate(d.getDate() + 7); break;
    case 'BIWEEKLY': d.setDate(d.getDate() + 14); break;
    case 'MONTHLY':  d.setMonth(d.getMonth() + 1); break;
  }
  return d;
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function generateRecurringInstances(event, rangeStart, rangeEnd, exceptionMap) {
  const instances = [];
  if (event.recurrence_type === 'NONE') return instances;

  const start = new Date(event.start_time);
  const duration = event.end_time ? (new Date(event.end_time) - start) : 0;
  const recEnd = event.recurrence_end ? new Date(event.recurrence_end + 'T23:59:59') : new Date(rangeEnd + 'T23:59:59');
  const rEnd = recEnd < new Date(rangeEnd + 'T23:59:59') ? recEnd : new Date(rangeEnd + 'T23:59:59');
  const rStart = new Date(rangeStart + 'T00:00:00');

  let cur = new Date(start);
  let safety = 0;

  while (cur <= rEnd && safety++ < 500) {
    const key = `${event.id}_${dateStr(cur)}`;
    const exc = exceptionMap[key];

    if (cur >= rStart) {
      if (exc) {
        if (!exc.is_deleted) {
          instances.push({ ...exc, _isInstance: true });
        }
      } else {
        const endTime = duration ? new Date(cur.getTime() + duration).toISOString() : null;
        instances.push({
          ...event,
          id: event.id,
          start_time: cur.toISOString(),
          end_time: endTime,
          _instanceDate: dateStr(cur),
          _isInstance: true,
        });
      }
    }

    cur = advanceDate(cur, event.recurrence_type);
  }

  return instances;
}

// ── Router ──
export default {
  async fetch(request, env) {
    await runMigrations(env);

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (path.startsWith('/api/') && !checkAuth(request, env)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Cerebro"', ...CORS },
      });
    }

    const seg = path.split('/').filter(Boolean); // ['api', 'tasks', id, ...]

    try {

      // ──────────────────────────────
      // TASKS
      // ──────────────────────────────
      if (seg[1] === 'tasks' && !seg[2]) {
        if (method === 'GET') {
          const priority  = url.searchParams.get('priority');
          const completed = url.searchParams.get('completed');
          const sort      = url.searchParams.get('sort') || 'priority';

          let q = 'SELECT * FROM tasks WHERE 1=1';
          const p = [];
          if (priority)  { q += ' AND priority = ?';  p.push(priority); }
          if (completed !== null && completed !== '') { q += ' AND completed = ?'; p.push(completed === 'true' ? 1 : 0); }

          const priorityOrder = "CASE priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 WHEN 'BACKLOG' THEN 3 ELSE 4 END";
          if (sort === 'priority')  q += ` ORDER BY ${priorityOrder}, due_date ASC NULLS LAST`;
          else if (sort === 'due')  q += ' ORDER BY due_date ASC NULLS LAST, created_at DESC';
          else                      q += ' ORDER BY created_at DESC';

          const { results } = await env.DB.prepare(q).bind(...p).all();
          return json({ tasks: results });
        }

        if (method === 'POST') {
          const body = await request.json();
          const id = crypto.randomUUID();
          const task = await env.DB.prepare(
            `INSERT INTO tasks (id, title, description, priority, due_date) VALUES (?,?,?,?,?) RETURNING *`
          ).bind(id, body.title, body.description || '', body.priority || 'NORMAL', body.dueDate || null).first();
          return json({ task }, 201);
        }
      }

      if (seg[1] === 'tasks' && seg[2]) {
        const id = seg[2];

        if (method === 'PATCH') {
          const body = await request.json();
          const allowed = { title: body.title, description: body.description, priority: body.priority, completed: body.completed !== undefined ? (body.completed ? 1 : 0) : undefined, due_date: body.dueDate };
          const sets = []; const p = [];
          for (const [k, v] of Object.entries(allowed)) {
            if (v !== undefined) { sets.push(`${k} = ?`); p.push(v === '' ? null : v); }
          }
          if (!sets.length) return json({ error: 'Nothing to update' }, 400);
          sets.push("updated_at = datetime('now')");
          p.push(id);
          const task = await env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? RETURNING *`).bind(...p).first();
          return task ? json({ task }) : json({ error: 'Not found' }, 404);
        }

        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
          return json({ ok: true });
        }
      }

      // ──────────────────────────────
      // CALENDAR EVENTS
      // ──────────────────────────────
      if (seg[1] === 'events' && !seg[2]) {
        if (method === 'GET') {
          const start = url.searchParams.get('start') || dateStr(new Date());
          const end   = url.searchParams.get('end')   || dateStr(new Date(Date.now() + 86400000 * 30));

          // Fetch base events (not exceptions) that could overlap range
          const { results: baseEvents } = await env.DB.prepare(
            `SELECT * FROM calendar_events
             WHERE parent_event_id IS NULL AND is_deleted = 0
             AND (
               (recurrence_type = 'NONE' AND date(start_time) >= ? AND date(start_time) <= ?)
               OR recurrence_type != 'NONE'
             )
             ORDER BY start_time ASC`
          ).bind(start, end).all();

          // Fetch exceptions in range
          const { results: exceptions } = await env.DB.prepare(
            `SELECT * FROM calendar_events WHERE parent_event_id IS NOT NULL AND exception_date >= ? AND exception_date <= ?`
          ).bind(start, end).all();

          const exceptionMap = {};
          for (const ex of exceptions) {
            exceptionMap[`${ex.parent_event_id}_${ex.exception_date}`] = ex;
          }

          const allEvents = [];
          for (const ev of baseEvents) {
            if (ev.recurrence_type === 'NONE') {
              allEvents.push(ev);
            } else {
              allEvents.push(...generateRecurringInstances(ev, start, end, exceptionMap));
            }
          }

          allEvents.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
          return json({ events: allEvents });
        }

        if (method === 'POST') {
          const body = await request.json();
          const id = crypto.randomUUID();
          const event = await env.DB.prepare(
            `INSERT INTO calendar_events (id,title,description,start_time,end_time,color,is_important,location,recurrence_type,recurrence_end)
             VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`
          ).bind(
            id, body.title, body.description || '', body.startTime, body.endTime || null,
            body.color || '#6366F1', body.isImportant ? 1 : 0, body.location || '',
            body.recurrenceType || 'NONE', body.recurrenceEnd || null
          ).first();
          return json({ event }, 201);
        }
      }

      if (seg[1] === 'events' && seg[2] && seg[3] === 'notes') {
        const eventId = seg[2];

        if (method === 'GET') {
          const { results } = await env.DB.prepare(
            `SELECT * FROM notes WHERE event_id = ? ORDER BY created_at ASC`
          ).bind(eventId).all();
          return json({ notes: results });
        }

        if (method === 'POST') {
          const body = await request.json();
          const id = crypto.randomUUID();
          const note = await env.DB.prepare(
            `INSERT INTO notes (id, title, content, event_id) VALUES (?,?,?,?) RETURNING *`
          ).bind(id, body.title || 'Meeting Notes', body.content || '', eventId).first();
          return json({ note }, 201);
        }
      }

      if (seg[1] === 'events' && seg[2] && !seg[3]) {
        const id = seg[2];

        if (method === 'GET') {
          const event = await env.DB.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(id).first();
          return event ? json({ event }) : json({ error: 'Not found' }, 404);
        }

        if (method === 'PATCH') {
          const body = await request.json();
          const deleteAll = url.searchParams.get('all') === 'true';

          // If editing a generated recurring instance → create exception record
          if (body._instanceDate && !deleteAll) {
            const parentId = body.parentEventId || id;
            const excId = crypto.randomUUID();
            const original = await env.DB.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(parentId).first();
            if (!original) return json({ error: 'Not found' }, 404);

            // Build new start_time preserving time but updating to instance date
            const origStart = new Date(body.startTime || original.start_time);
            const event = await env.DB.prepare(
              `INSERT INTO calendar_events
                (id, title, description, start_time, end_time, color, is_important, location, recurrence_type, parent_event_id, exception_date)
               VALUES (?,?,?,?,?,?,?,?,'NONE',?,?) RETURNING *`
            ).bind(
              excId, body.title || original.title, body.description ?? original.description,
              body.startTime || original.start_time, body.endTime ?? original.end_time,
              body.color || original.color, body.isImportant !== undefined ? (body.isImportant ? 1 : 0) : original.is_important,
              body.location ?? original.location, parentId, body._instanceDate
            ).first();
            return json({ event }, 201);
          }

          // Otherwise update base event
          const allowed = { title: body.title, description: body.description, start_time: body.startTime, end_time: body.endTime, color: body.color, is_important: body.isImportant !== undefined ? (body.isImportant ? 1 : 0) : undefined, location: body.location, recurrence_type: body.recurrenceType, recurrence_end: body.recurrenceEnd };
          const sets = []; const p = [];
          for (const [k, v] of Object.entries(allowed)) {
            if (v !== undefined) { sets.push(`${k} = ?`); p.push(v === '' ? null : v); }
          }
          if (!sets.length) return json({ error: 'Nothing to update' }, 400);
          sets.push("updated_at = datetime('now')");
          p.push(id);
          const event = await env.DB.prepare(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ? RETURNING *`).bind(...p).first();
          return event ? json({ event }) : json({ error: 'Not found' }, 404);
        }

        if (method === 'DELETE') {
          const deleteAll = url.searchParams.get('all') === 'true';
          const instanceDate = url.searchParams.get('instanceDate');

          if (instanceDate) {
            // Soft-delete this specific instance by creating a deleted exception
            const event = await env.DB.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(id).first();
            if (!event) return json({ error: 'Not found' }, 404);
            const excId = crypto.randomUUID();
            await env.DB.prepare(
              `INSERT INTO calendar_events (id, title, description, start_time, color, recurrence_type, parent_event_id, exception_date, is_deleted)
               VALUES (?,?,?,?,?,?,?,?,1)`
            ).bind(excId, event.title, '', event.start_time, event.color, 'NONE', id, instanceDate).run();
            return json({ ok: true });
          }

          if (deleteAll) {
            // Delete entire series + all exceptions
            await env.DB.prepare('DELETE FROM calendar_events WHERE id = ? OR parent_event_id = ?').bind(id, id).run();
          } else {
            await env.DB.prepare('DELETE FROM calendar_events WHERE id = ?').bind(id).run();
          }
          return json({ ok: true });
        }
      }

      // ──────────────────────────────
      // NOTES (standalone)
      // ──────────────────────────────
      if (seg[1] === 'notes' && !seg[2]) {
        if (method === 'GET') {
          const search = url.searchParams.get('search');
          const tag    = url.searchParams.get('tag');
          let q = `SELECT * FROM notes WHERE event_id IS NULL`;
          const p = [];
          if (search) { q += ` AND (title LIKE ? OR content LIKE ?)`; const s = `%${search}%`; p.push(s, s); }
          if (tag)    { q += ` AND (',' || COALESCE(tags,'') || ',') LIKE ?`; p.push(`%,${tag},%`); }
          q += ' ORDER BY updated_at DESC';
          const { results } = await env.DB.prepare(q).bind(...p).all();
          return json({ notes: results });
        }

        if (method === 'POST') {
          const body = await request.json();
          const id = crypto.randomUUID();
          const note = await env.DB.prepare(
            `INSERT INTO notes (id, title, content, tags) VALUES (?,?,?,?) RETURNING *`
          ).bind(id, body.title || 'Untitled', body.content || '', body.tags || '').first();
          return json({ note }, 201);
        }
      }

      if (seg[1] === 'notes' && seg[2]) {
        const id = seg[2];

        if (method === 'PATCH') {
          const body = await request.json();
          const sets = []; const p = [];
          if (body.title   !== undefined) { sets.push('title = ?');   p.push(body.title); }
          if (body.content !== undefined) { sets.push('content = ?'); p.push(body.content); }
          if (body.tags    !== undefined) { sets.push('tags = ?');    p.push(body.tags); }
          if (!sets.length) return json({ error: 'Nothing to update' }, 400);
          sets.push("updated_at = datetime('now')");
          p.push(id);
          const note = await env.DB.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? RETURNING *`).bind(...p).first();
          return note ? json({ note }) : json({ error: 'Not found' }, 404);
        }

        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
          return json({ ok: true });
        }
      }

      // ──────────────────────────────
      // AI CHAT
      // ──────────────────────────────
      if (seg[1] === 'chat' && method === 'POST') {
        const body = await request.json();
        const { message, mode } = body;
        const today = new Date().toISOString().split('T')[0];

        if (mode === 'transcript') {
          const prompt = `You are Cerebro, a personal assistant AI. Analyze this meeting transcript or text and extract structured information.

Text to analyze:
"${message}"

Return ONLY valid JSON (no markdown, no explanation):
{
  "type": "transcript_analysis",
  "summary": "2-3 sentence summary",
  "keyPoints": ["point1", "point2"],
  "tasks": [{"title": "...", "description": "...", "priority": "NORMAL"}],
  "events": [{"title": "...", "startTime": "...", "description": "..."}]
}
Priority options: URGENT, HIGH, NORMAL, BACKLOG. Today is ${today}.`;

          const aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1024,
          });

          let data;
          try {
            const text = aiRes.response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
            data = JSON.parse(text);
          } catch (e) {
            data = { type: 'transcript_analysis', summary: aiRes.response, keyPoints: [], tasks: [], events: [] };
          }
          return json(data);
        }

        // Default: context-aware chat
        // Fetch events from 30 days ago through 90 days ahead so the AI sees past and future events
        const pastDate   = new Date(Date.now() - 30  * 86400000).toISOString().split('T')[0];
        const futureDate = new Date(Date.now() + 90  * 86400000).toISOString().split('T')[0];

        const [{ results: tasks }, { results: calEvents }, { results: recentNotes }] = await Promise.all([
          env.DB.prepare(`SELECT id, title, priority, completed, due_date FROM tasks ORDER BY created_at DESC LIMIT 30`).all(),
          env.DB.prepare(
            `SELECT id, title, start_time, end_time, recurrence_type FROM calendar_events
             WHERE is_deleted = 0 AND parent_event_id IS NULL
             AND (date(start_time) >= ? OR recurrence_type != 'NONE')
             AND (date(start_time) <= ? OR recurrence_type != 'NONE')
             ORDER BY start_time ASC LIMIT 50`
          ).bind(pastDate, futureDate).all(),
          env.DB.prepare(`SELECT id, title, content FROM notes WHERE event_id IS NULL ORDER BY updated_at DESC LIMIT 10`).all(),
        ]);

        const context = `
Today is ${today}.

TASKS (${tasks.length}):
${tasks.map(t => `- [${t.completed ? 'done' : 'open'}] ${t.title} (${t.priority})${t.due_date ? ` due ${t.due_date}` : ''}`).join('\n') || 'No tasks'}

CALENDAR EVENTS — past 30 days through next 90 days (${calEvents.length}):
${calEvents.map(e => {
  const dt = e.start_time ? new Date(e.start_time).toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : 'no time';
  const recur = e.recurrence_type !== 'NONE' ? ` [repeats ${e.recurrence_type.toLowerCase()}]` : '';
  return `- ${e.title} on ${dt}${recur}`;
}).join('\n') || 'No events'}

RECENT NOTES (${recentNotes.length}):
${recentNotes.map(n => `- ${n.title}: ${n.content?.slice(0, 100)}`).join('\n') || 'No notes'}`;

        const systemPrompt = `You are Cerebro, a smart personal assistant. Today is ${today}.

Here is the user's current data:
${context}

You can answer questions AND perform actions. When the user asks you to add/create a task or event, you MUST return valid JSON (no markdown) in this exact shape:
{
  "message": "Friendly confirmation message to show the user",
  "action": {
    "type": "create_task",
    "data": { "title": "...", "description": "...", "priority": "NORMAL", "dueDate": "YYYY-MM-DD or null" }
  }
}
OR for events:
{
  "message": "Friendly confirmation message",
  "action": {
    "type": "create_event",
    "data": { "title": "...", "startTime": "YYYY-MM-DDTHH:MM:00", "endTime": "YYYY-MM-DDTHH:MM:00 or null", "description": "" }
  }
}

Priority options: URGENT, HIGH, NORMAL, BACKLOG.
Resolve relative dates (tomorrow, next Monday, etc.) to absolute YYYY-MM-DD based on today being ${today}.

For all other responses (questions, lookups, general chat) return plain text — no JSON.`;

        const aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          max_tokens: 512,
        });

        const raw = aiRes.response.trim();

        // Try to parse as an action response
        let parsed = null;
        try {
          const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          parsed = JSON.parse(clean);
        } catch (_) {}

        if (parsed?.action?.type === 'create_task') {
          const d = parsed.action.data;
          const id = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO tasks (id, title, description, priority, due_date) VALUES (?,?,?,?,?)`
          ).bind(id, d.title, d.description || '', d.priority || 'NORMAL', d.dueDate || null).run();
          return json({ type: 'chat', message: parsed.message || `Task "${d.title}" added.`, action: { type: 'create_task' } });
        }

        if (parsed?.action?.type === 'create_event') {
          const d = parsed.action.data;
          const id = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO calendar_events (id, title, description, start_time, end_time, color) VALUES (?,?,?,?,?,?)`
          ).bind(id, d.title, d.description || '', d.startTime, d.endTime || null, '#6366F1').run();
          return json({ type: 'chat', message: parsed.message || `Event "${d.title}" added.`, action: { type: 'create_event' } });
        }

        return json({ type: 'chat', message: raw });
      }

      return json({ error: 'Not found' }, 404);

    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
