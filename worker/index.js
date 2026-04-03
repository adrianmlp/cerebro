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
    `CREATE TABLE IF NOT EXISTS outlook_events (
      uid TEXT PRIMARY KEY,
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      organizer TEXT DEFAULT '',
      location TEXT DEFAULT '',
      start_time TEXT,
      end_time TEXT,
      is_all_day INTEGER DEFAULT 0,
      recurrence_rule TEXT,
      recurrence_exceptions TEXT DEFAULT '[]',
      synced_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS hidden_outlook_events (
      uid TEXT PRIMARY KEY,
      title TEXT DEFAULT '',
      hidden_at TEXT DEFAULT (datetime('now'))
    )`,
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).run(); } catch (e) {}
  }
  // Column additions — idempotent
  try { await env.DB.prepare(`ALTER TABLE notes ADD COLUMN tags TEXT DEFAULT ''`).run(); } catch(e) {}
}

// ── ICS Parser ──
function unfoldICS(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function getICSProp(block, key) {
  const re = new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, 'm');
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

function unescapeICS(str) {
  if (!str) return '';
  return str
    .replace(/\\n/g, '\n').replace(/\\N/g, '\n')
    .replace(/\\,/g, ',').replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseICSDate(raw) {
  if (!raw) return null;
  // Strip TZID= prefix if it slipped through (e.g. "TZID=...:20260402T090000")
  const val = raw.includes(':') ? raw.split(':').pop() : raw;
  if (/^\d{8}$/.test(val)) {
    return { iso: `${val.slice(0,4)}-${val.slice(4,6)}-${val.slice(6,8)}T00:00:00Z`, allDay: true };
  }
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    return { iso: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || 'Z'}`, allDay: false };
  }
  return null;
}

function parseRRule(str) {
  if (!str) return null;
  const parts = {};
  str.split(';').forEach(p => { const [k, v] = p.split('='); if (k && v) parts[k] = v; });
  const DAY = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };
  return {
    freq:       parts.FREQ || 'WEEKLY',
    interval:   parseInt(parts.INTERVAL || '1', 10),
    byDay:      parts.BYDAY
                  ? parts.BYDAY.split(',').map(d => DAY[d.replace(/[^A-Z]/g,'')]).filter(n => n !== undefined)
                  : null,
    until:      parts.UNTIL ? parseICSDate(parts.UNTIL)?.iso : null,
    count:      parts.COUNT ? parseInt(parts.COUNT, 10) : null,
  };
}

function parseICS(text) {
  const unfolded = unfoldICS(text);
  const events   = [];
  const parts    = unfolded.split('BEGIN:VEVENT');

  for (let i = 1; i < parts.length; i++) {
    const endIdx = parts[i].indexOf('END:VEVENT');
    if (endIdx === -1) continue;
    const block = parts[i].slice(0, endIdx);

    const uid = getICSProp(block, 'UID');
    if (!uid) continue;

    // Dates — match line including optional TZID param
    const dtStartRaw = block.match(/^DTSTART(?:;[^:]*)?:(.+)$/m)?.[1]?.trim();
    const dtEndRaw   = block.match(/^DTEND(?:;[^:]*)?:(.+)$/m)?.[1]?.trim();
    const dtStart    = parseICSDate(dtStartRaw);
    const dtEnd      = parseICSDate(dtEndRaw);

    // Organizer CN
    const orgCN = block.match(/ORGANIZER[^:]*CN="([^"]+)"/m)?.[1]
               || block.match(/ORGANIZER[^:]*CN=([^;:]+)/m)?.[1]
               || '';

    // EXDATE — cancelled instances
    const exdates = [];
    for (const m of block.matchAll(/^EXDATE(?:;[^:]*)?:(.+)$/mg)) {
      const d = parseICSDate(m[1].trim());
      if (d) exdates.push(d.iso.split('T')[0]);
    }

    // Skip exception/override entries (RECURRENCE-ID present) — we handle them via EXDATE
    if (block.match(/^RECURRENCE-ID/m)) continue;

    events.push({
      uid:                   uid.trim(),
      title:                 unescapeICS(getICSProp(block, 'SUMMARY')     || ''),
      description:           unescapeICS(getICSProp(block, 'DESCRIPTION') || ''),
      organizer:             orgCN.trim(),
      location:              unescapeICS(getICSProp(block, 'LOCATION')    || ''),
      start_time:            dtStart?.iso  || null,
      end_time:              dtEnd?.iso    || null,
      is_all_day:            dtStart?.allDay ? 1 : 0,
      recurrence_rule:       getICSProp(block, 'RRULE') || null,
      recurrence_exceptions: exdates.length ? JSON.stringify(exdates) : '[]',
    });
  }
  return events;
}

// ── Outlook recurring instance generation ──
function dateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function generateOutlookInstances(event, rrule, rangeStart, rangeEnd) {
  const exceptions = new Set(JSON.parse(event.recurrence_exceptions || '[]'));
  const instances  = [];

  const rStart     = new Date(rangeStart + 'T00:00:00Z');
  const rEnd       = new Date(rangeEnd   + 'T23:59:59Z');
  const untilDate  = rrule.until ? new Date(rrule.until) : null;
  const maxDate    = untilDate && untilDate < rEnd ? untilDate : rEnd;

  const evStart    = new Date(event.start_time);
  const duration   = event.end_time ? new Date(event.end_time) - evStart : 0;
  const hh = evStart.getUTCHours(), mm = evStart.getUTCMinutes(), ss = evStart.getUTCSeconds();

  function withTime(d) {
    const r = new Date(d); r.setUTCHours(hh, mm, ss, 0); return r;
  }

  function push(d) {
    const ds = dateStr(d);
    if (!exceptions.has(ds) && d >= rStart && d >= evStart && d <= maxDate) {
      instances.push({
        ...event,
        start_time:    d.toISOString(),
        end_time:      duration ? new Date(d.getTime() + duration).toISOString() : null,
        _instanceDate: ds,
      });
    }
  }

  let safety = 0;

  if (rrule.freq === 'DAILY') {
    let cur = new Date(evStart);
    while (cur <= maxDate && safety++ < 2000) {
      if (rrule.count && instances.length >= rrule.count) break;
      push(cur);
      cur = new Date(cur); cur.setUTCDate(cur.getUTCDate() + rrule.interval);
    }
  } else if (rrule.freq === 'WEEKLY') {
    if (rrule.byDay?.length) {
      // Walk week by week, emit matching days
      let ws = new Date(evStart);
      ws.setUTCDate(ws.getUTCDate() - ws.getUTCDay()); ws.setUTCHours(0,0,0,0);
      while (ws <= maxDate && safety++ < 5000) {
        for (const dow of [...rrule.byDay].sort()) {
          if (rrule.count && instances.length >= rrule.count) break;
          const day = new Date(ws); day.setUTCDate(day.getUTCDate() + dow);
          push(withTime(day));
        }
        if (rrule.count && instances.length >= rrule.count) break;
        ws = new Date(ws); ws.setUTCDate(ws.getUTCDate() + 7 * rrule.interval);
      }
    } else {
      let cur = new Date(evStart);
      while (cur <= maxDate && safety++ < 500) {
        if (rrule.count && instances.length >= rrule.count) break;
        push(cur);
        cur = new Date(cur); cur.setUTCDate(cur.getUTCDate() + 7 * rrule.interval);
      }
    }
  } else if (rrule.freq === 'MONTHLY') {
    let cur = new Date(evStart);
    while (cur <= maxDate && safety++ < 200) {
      if (rrule.count && instances.length >= rrule.count) break;
      push(cur);
      cur = new Date(cur); cur.setUTCMonth(cur.getUTCMonth() + rrule.interval);
    }
  } else if (rrule.freq === 'YEARLY') {
    let cur = new Date(evStart);
    while (cur <= maxDate && safety++ < 20) {
      if (rrule.count && instances.length >= rrule.count) break;
      push(cur);
      cur = new Date(cur); cur.setUTCFullYear(cur.getUTCFullYear() + rrule.interval);
    }
  }

  return instances;
}

// ── Outlook sync ──
async function syncOutlook(env) {
  const icsUrl = env.OUTLOOK_ICS_URL;
  if (!icsUrl) return { ok: false, error: 'OUTLOOK_ICS_URL secret not set' };
  try {
    const res = await fetch(icsUrl, { headers: { 'User-Agent': 'Cerebro/1.0' } });
    if (!res.ok) throw new Error(`ICS fetch failed: HTTP ${res.status}`);
    const text   = await res.text();
    const events = parseICS(text);

    for (const ev of events) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO outlook_events
         (uid, title, description, organizer, location, start_time, end_time, is_all_day, recurrence_rule, recurrence_exceptions, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`
      ).bind(
        ev.uid, ev.title, ev.description, ev.organizer, ev.location,
        ev.start_time, ev.end_time, ev.is_all_day,
        ev.recurrence_rule, ev.recurrence_exceptions
      ).run();
    }

    await env.DB.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('outlook_last_sync', ?)`
    ).bind(new Date().toISOString()).run();

    return { ok: true, count: events.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Personal-event recurring helpers (unchanged) ──
function advanceDatePersonal(date, type) {
  const d = new Date(date);
  switch (type) {
    case 'DAILY':    d.setDate(d.getDate() + 1);   break;
    case 'WEEKLY':   d.setDate(d.getDate() + 7);   break;
    case 'BIWEEKLY': d.setDate(d.getDate() + 14);  break;
    case 'MONTHLY':  d.setMonth(d.getMonth() + 1); break;
  }
  return d;
}

function dateStrLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function generateRecurringInstances(event, rangeStart, rangeEnd, exceptionMap) {
  const instances = [];
  if (event.recurrence_type === 'NONE') return instances;

  const start    = new Date(event.start_time);
  const duration = event.end_time ? (new Date(event.end_time) - start) : 0;
  const recEnd   = event.recurrence_end ? new Date(event.recurrence_end + 'T23:59:59') : new Date(rangeEnd + 'T23:59:59');
  const rEnd     = recEnd < new Date(rangeEnd + 'T23:59:59') ? recEnd : new Date(rangeEnd + 'T23:59:59');
  const rStart   = new Date(rangeStart + 'T00:00:00');

  let cur = new Date(start);
  let safety = 0;

  while (cur <= rEnd && safety++ < 500) {
    const key = `${event.id}_${dateStrLocal(cur)}`;
    const exc = exceptionMap[key];

    if (cur >= rStart) {
      if (exc) {
        if (!exc.is_deleted) instances.push({ ...exc, _isInstance: true });
      } else {
        const endTime = duration ? new Date(cur.getTime() + duration).toISOString() : null;
        instances.push({
          ...event,
          start_time:    cur.toISOString(),
          end_time:      endTime,
          _instanceDate: dateStrLocal(cur),
          _isInstance:   true,
        });
      }
    }
    cur = advanceDatePersonal(cur, event.recurrence_type);
  }
  return instances;
}

// ── Router ──
export default {
  async fetch(request, env) {
    await runMigrations(env);

    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (path.startsWith('/api/') && !checkAuth(request, env)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Cerebro"', ...CORS },
      });
    }

    const seg = path.split('/').filter(Boolean); // ['api', ...]

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

          const po = "CASE priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 WHEN 'BACKLOG' THEN 3 ELSE 4 END";
          if (sort === 'priority')  q += ` ORDER BY ${po}, due_date ASC NULLS LAST`;
          else if (sort === 'due')  q += ' ORDER BY due_date ASC NULLS LAST, created_at DESC';
          else                      q += ' ORDER BY created_at DESC';

          const { results } = await env.DB.prepare(q).bind(...p).all();
          return json({ tasks: results });
        }
        if (method === 'POST') {
          const body = await request.json();
          const id   = crypto.randomUUID();
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
      // CALENDAR EVENTS (personal)
      // ──────────────────────────────
      if (seg[1] === 'events' && !seg[2]) {
        if (method === 'GET') {
          const start = url.searchParams.get('start') || dateStrLocal(new Date());
          const end   = url.searchParams.get('end')   || dateStrLocal(new Date(Date.now() + 86400000 * 30));

          const { results: baseEvents } = await env.DB.prepare(
            `SELECT * FROM calendar_events
             WHERE parent_event_id IS NULL AND is_deleted = 0
             AND ((recurrence_type = 'NONE' AND date(start_time) >= ? AND date(start_time) <= ?)
               OR recurrence_type != 'NONE')
             ORDER BY start_time ASC`
          ).bind(start, end).all();

          const { results: exceptions } = await env.DB.prepare(
            `SELECT * FROM calendar_events WHERE parent_event_id IS NOT NULL AND exception_date >= ? AND exception_date <= ?`
          ).bind(start, end).all();

          const exceptionMap = {};
          for (const ex of exceptions) {
            exceptionMap[`${ex.parent_event_id}_${ex.exception_date}`] = ex;
          }

          const allEvents = [];
          for (const ev of baseEvents) {
            if (ev.recurrence_type === 'NONE') allEvents.push(ev);
            else allEvents.push(...generateRecurringInstances(ev, start, end, exceptionMap));
          }
          allEvents.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
          return json({ events: allEvents });
        }

        if (method === 'POST') {
          const body = await request.json();
          const id   = crypto.randomUUID();
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
          const { results } = await env.DB.prepare(`SELECT * FROM notes WHERE event_id = ? ORDER BY created_at ASC`).bind(eventId).all();
          return json({ notes: results });
        }
        if (method === 'POST') {
          const body = await request.json();
          const id   = crypto.randomUUID();
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
          const body       = await request.json();
          const deleteAll  = url.searchParams.get('all') === 'true';

          if (body._instanceDate && !deleteAll) {
            const parentId = body.parentEventId || id;
            const excId    = crypto.randomUUID();
            const original = await env.DB.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(parentId).first();
            if (!original) return json({ error: 'Not found' }, 404);
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
          const deleteAll    = url.searchParams.get('all') === 'true';
          const instanceDate = url.searchParams.get('instanceDate');
          if (instanceDate) {
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
            await env.DB.prepare('DELETE FROM calendar_events WHERE id = ? OR parent_event_id = ?').bind(id, id).run();
          } else {
            await env.DB.prepare('DELETE FROM calendar_events WHERE id = ?').bind(id).run();
          }
          return json({ ok: true });
        }
      }

      // ──────────────────────────────
      // OUTLOOK EVENTS
      // ──────────────────────────────
      if (seg[1] === 'outlook' && seg[2] === 'events' && method === 'GET') {
        const start = url.searchParams.get('start');
        const end   = url.searchParams.get('end');
        if (!start || !end) return json({ error: 'start and end required' }, 400);

        const { results: hiddenRows } = await env.DB.prepare('SELECT uid FROM hidden_outlook_events').all();
        const hiddenUids = new Set(hiddenRows.map(r => r.uid));

        const { results: allStored } = await env.DB.prepare('SELECT * FROM outlook_events').all();
        const out = [];

        for (const ev of allStored) {
          if (hiddenUids.has(ev.uid)) continue;
          if (!ev.start_time) continue;

          if (!ev.recurrence_rule) {
            const d = ev.start_time.split('T')[0];
            if (d >= start && d <= end) out.push(ev);
          } else {
            const rrule = parseRRule(ev.recurrence_rule);
            if (rrule) {
              out.push(...generateOutlookInstances(ev, rrule, start, end));
            }
          }
        }

        out.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
        return json({ events: out });
      }

      // Hidden events list
      if (seg[1] === 'outlook' && seg[2] === 'hidden' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT uid, title, hidden_at FROM hidden_outlook_events ORDER BY hidden_at DESC'
        ).all();
        return json({ hidden: results });
      }

      // Hide an event
      if (seg[1] === 'outlook' && seg[2] === 'hide' && !seg[3]) {
        if (method === 'POST') {
          const body = await request.json();
          await env.DB.prepare(
            `INSERT OR REPLACE INTO hidden_outlook_events (uid, title) VALUES (?,?)`
          ).bind(body.uid, body.title || '').run();
          return json({ ok: true });
        }
      }

      // Unhide an event
      if (seg[1] === 'outlook' && seg[2] === 'hide' && seg[3]) {
        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM hidden_outlook_events WHERE uid = ?').bind(seg[3]).run();
          return json({ ok: true });
        }
      }

      // ──────────────────────────────
      // SYNC
      // ──────────────────────────────
      if (seg[1] === 'sync' && seg[2] === 'outlook' && method === 'POST') {
        const result = await syncOutlook(env);
        return result.ok ? json(result) : json(result, 500);
      }

      if (seg[1] === 'sync' && seg[2] === 'status' && method === 'GET') {
        const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'outlook_last_sync'`).first();
        return json({ lastSync: row?.value || null });
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
          const id   = crypto.randomUUID();
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

        const pastDate   = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
        const futureDate = new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0];

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
Resolve relative dates to absolute YYYY-MM-DD based on today being ${today}.

For all other responses return plain text — no JSON.`;

        const aiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          max_tokens: 512,
        });

        const raw = aiRes.response.trim();
        let parsed = null;
        try {
          const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          parsed = JSON.parse(clean);
        } catch (_) {}

        if (parsed?.action?.type === 'create_task') {
          const d  = parsed.action.data;
          const id = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO tasks (id, title, description, priority, due_date) VALUES (?,?,?,?,?)`
          ).bind(id, d.title, d.description || '', d.priority || 'NORMAL', d.dueDate || null).run();
          return json({ type: 'chat', message: parsed.message || `Task "${d.title}" added.`, action: { type: 'create_task' } });
        }

        if (parsed?.action?.type === 'create_event') {
          const d  = parsed.action.data;
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

  // ── Cron: 6-hour Outlook sync ──
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncOutlook(env));
  },
};
