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
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).run(); } catch (e) {}
  }
  // Column additions — idempotent
  try { await env.DB.prepare(`ALTER TABLE notes ADD COLUMN tags TEXT DEFAULT ''`).run(); } catch(e) {}
  try { await env.DB.prepare(`ALTER TABLE outlook_events ADD COLUMN event_tzid TEXT`).run(); } catch(e) {}
  try { await env.DB.prepare(`ALTER TABLE outlook_events ADD COLUMN local_start TEXT`).run(); } catch(e) {}
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

// Windows TZ name → IANA timezone ID
const WIN_TO_IANA = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Daylight Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Chihuahua',
  'Mountain Standard Time': 'America/Denver',
  'Mountain Daylight Time': 'America/Denver',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago',
  'Central Daylight Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Eastern Standard Time': 'America/New_York',
  'Eastern Daylight Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Venezuela Standard Time': 'America/Caracas',
  'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Greenland Standard Time': 'America/Godthab',
  'Montevideo Standard Time': 'America/Montevideo',
  'Bahia Standard Time': 'America/Bahia',
  'UTC-02': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  'Morocco Standard Time': 'Africa/Casablanca',
  'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Namibia Standard Time': 'Africa/Windhoek',
  'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut',
  'Egypt Standard Time': 'Africa/Cairo',
  'Syria Standard Time': 'Asia/Damascus',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Helsinki',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Libya Standard Time': 'Africa/Tripoli',
  'Jordan Standard Time': 'Asia/Amman',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Arab Standard Time': 'Asia/Riyadh',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Russia Time Zone 3': 'Europe/Samara',
  'Mauritius Standard Time': 'Indian/Mauritius',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Calcutta',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Katmandu',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Myanmar Standard Time': 'Asia/Rangoon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'China Standard Time': 'Asia/Shanghai',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Japan Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC+12': 'Etc/GMT-12',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Magadan Standard Time': 'Asia/Magadan',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia',
};

// ── Extract VTIMEZONE offsets from the ICS file itself ──
// Outlook embeds timezone rules (VTIMEZONE) that define the exact UTC offsets including DST.
// Using these is more reliable than mapping timezone names to IANA IDs.
function extractVTimezones(unfolded) {
  const result = {};
  const parts = unfolded.split('BEGIN:VTIMEZONE').slice(1);
  for (const part of parts) {
    const endIdx = part.indexOf('END:VTIMEZONE');
    if (endIdx < 0) continue;
    const vtz = part.slice(0, endIdx);
    const tzid = getICSProp(vtz, 'TZID');
    if (!tzid) continue;

    function compOffset(type) {
      const b = vtz.indexOf(`BEGIN:${type}`);
      const e = vtz.indexOf(`END:${type}`);
      if (b < 0 || e < 0) return null;
      const s = getICSProp(vtz.slice(b, e), 'TZOFFSETTO');
      if (!s) return null;
      const m2 = s.match(/([+-])(\d{2})(\d{2})/);
      if (!m2) return null;
      const sign = m2[1] === '+' ? 1 : -1;
      return sign * (parseInt(m2[2]) * 60 + parseInt(m2[3])) * 60 * 1000;
    }
    result[tzid.trim()] = { standard: compOffset('STANDARD'), daylight: compOffset('DAYLIGHT') };
  }
  return result;
}

// Convert local datetime string to UTC using VTIMEZONE-defined offsets
function localToUTCFromVTZ(localDateStr, vtz) {
  const localDate = new Date(localDateStr + 'Z'); // treat local time as UTC momentarily
  const month = localDate.getUTCMonth() + 1; // 1-12
  // Use daylight offset for Northern Hemisphere DST months (Mar–Nov), otherwise standard
  const offsetMs = (vtz.daylight !== null && month >= 3 && month <= 11)
    ? vtz.daylight
    : vtz.standard;
  if (offsetMs === null) return localDate;
  // UTC = local_time - UTC_offset  (e.g., PDT offset = -7h → UTC = local + 7h)
  return new Date(localDate.getTime() - offsetMs);
}

// Fallback: convert local time using IANA timezone via Intl API
function localToUTCFromIANA(localDateStr, ianaTimezone) {
  const approxUTC = new Date(localDateStr + 'Z');
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaTimezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(approxUTC);
    const get = (t) => parts.find(p => p.type === t)?.value || '00';
    let h = get('hour'); if (h === '24') h = '00';
    const tzLocal = new Date(`${get('year')}-${get('month')}-${get('day')}T${h}:${get('minute')}:${get('second')}Z`);
    return new Date(approxUTC.getTime() + (approxUTC.getTime() - tzLocal.getTime()));
  } catch (e) {
    return approxUTC;
  }
}

// Parse a full DTSTART/DTEND line (including params) → UTC ISO string
// vtimezones: map of TZID → { standard, daylight } offset in ms (from extractVTimezones)
function parseICSDateLine(fullLine, vtimezones = {}) {
  if (!fullLine) return null;
  const colonIdx = fullLine.indexOf(':');
  if (colonIdx < 0) return null;

  const params = fullLine.slice(0, colonIdx);
  const val    = fullLine.slice(colonIdx + 1).trim();

  // All-day DATE value
  if (/^\d{8}$/.test(val)) {
    return { iso: `${val.slice(0,4)}-${val.slice(4,6)}-${val.slice(6,8)}T00:00:00Z`, allDay: true };
  }

  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;

  const localStr = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const hasZ     = !!m[7];

  if (hasZ) return { iso: localStr + 'Z', allDay: false };

  const tzidMatch = params.match(/TZID=([^;:]+)/);
  if (tzidMatch) {
    const tzid = tzidMatch[1].trim();
    // Prefer VTIMEZONE offsets embedded in the ICS (most accurate)
    if (vtimezones[tzid]) {
      return { iso: localToUTCFromVTZ(localStr, vtimezones[tzid]).toISOString(), allDay: false };
    }
    // Fallback: map Windows TZ name to IANA and use Intl API
    const iana = WIN_TO_IANA[tzid] || tzid;
    return { iso: localToUTCFromIANA(localStr, iana).toISOString(), allDay: false };
  }

  // Floating time — treat as UTC
  return { iso: localStr + 'Z', allDay: false };
}

// Legacy helper for EXDATE / RRULE UNTIL (no TZID context needed)
function parseICSDate(raw) {
  if (!raw) return null;
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
  const unfolded   = unfoldICS(text);
  const vtimezones = extractVTimezones(unfolded);
  const events     = [];
  const parts      = unfolded.split('BEGIN:VEVENT');

  for (let i = 1; i < parts.length; i++) {
    const endIdx = parts[i].indexOf('END:VEVENT');
    if (endIdx === -1) continue;
    const block = parts[i].slice(0, endIdx);

    const uid = getICSProp(block, 'UID');
    if (!uid) continue;

    // Dates — capture full line (including TZID params) for proper timezone conversion
    const dtStartLine = block.match(/^(DTSTART[^:\n]*:[^\n]+)$/m)?.[1];
    const dtEndLine   = block.match(/^(DTEND[^:\n]*:[^\n]+)$/m)?.[1];
    const dtStart     = parseICSDateLine(dtStartLine, vtimezones);
    const dtEnd       = parseICSDateLine(dtEndLine, vtimezones);

    // Extract TZID and local clock time from DTSTART for DST-correct recurring instance generation
    const dtStartTzid = dtStartLine?.match(/TZID=([^;:]+)/)?.[1]?.trim() || null;
    const dtStartLocalVal = dtStartLine?.split(':').pop()?.trim() || '';
    const dtStartTimeParts = dtStartLocalVal.match(/^\d{8}T(\d{2})(\d{2})(\d{2})/);
    const localStart = dtStartTimeParts ? `${dtStartTimeParts[1]}:${dtStartTimeParts[2]}:${dtStartTimeParts[3]}` : null;

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
      event_tzid:            dtStartTzid,
      local_start:           localStart,
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

  // DST-correct UTC for each instance: use stored local clock time + IANA timezone
  const localStartTime = event.local_start; // e.g. "14:00:00"
  const ianaTimezone   = event.event_tzid ? (WIN_TO_IANA[event.event_tzid] || event.event_tzid) : null;

  // Returns correct UTC Date for a given UTC-midnight Date, accounting for DST
  function instanceUTC(dayMidnightUTC) {
    const ds = dateStr(dayMidnightUTC); // "YYYY-MM-DD"
    if (localStartTime && ianaTimezone) {
      return localToUTCFromIANA(`${ds}T${localStartTime}`, ianaTimezone);
    }
    // Fallback: use UTC hours from base event start_time
    const r = new Date(dayMidnightUTC);
    r.setUTCHours(evStart.getUTCHours(), evStart.getUTCMinutes(), evStart.getUTCSeconds(), 0);
    return r;
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
    let cur = new Date(evStart); cur.setUTCHours(0, 0, 0, 0);
    while (cur <= maxDate && safety++ < 2000) {
      if (rrule.count && instances.length >= rrule.count) break;
      push(instanceUTC(cur));
      cur.setUTCDate(cur.getUTCDate() + rrule.interval);
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
          push(instanceUTC(day));
        }
        if (rrule.count && instances.length >= rrule.count) break;
        ws.setUTCDate(ws.getUTCDate() + 7 * rrule.interval);
      }
    } else {
      let cur = new Date(evStart); cur.setUTCHours(0, 0, 0, 0);
      while (cur <= maxDate && safety++ < 500) {
        if (rrule.count && instances.length >= rrule.count) break;
        push(instanceUTC(cur));
        cur.setUTCDate(cur.getUTCDate() + 7 * rrule.interval);
      }
    }
  } else if (rrule.freq === 'MONTHLY') {
    let cur = new Date(evStart); cur.setUTCHours(0, 0, 0, 0);
    while (cur <= maxDate && safety++ < 200) {
      if (rrule.count && instances.length >= rrule.count) break;
      push(instanceUTC(cur));
      cur.setUTCMonth(cur.getUTCMonth() + rrule.interval);
    }
  } else if (rrule.freq === 'YEARLY') {
    let cur = new Date(evStart); cur.setUTCHours(0, 0, 0, 0);
    while (cur <= maxDate && safety++ < 20) {
      if (rrule.count && instances.length >= rrule.count) break;
      push(instanceUTC(cur));
      cur.setUTCFullYear(cur.getUTCFullYear() + rrule.interval);
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

    // Stamp every upserted row with this sync's timestamp
    const syncTime = new Date().toISOString();

    for (const ev of events) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO outlook_events
         (uid, title, description, organizer, location, start_time, end_time, is_all_day, recurrence_rule, recurrence_exceptions, event_tzid, local_start, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        ev.uid, ev.title, ev.description, ev.organizer, ev.location,
        ev.start_time, ev.end_time, ev.is_all_day,
        ev.recurrence_rule, ev.recurrence_exceptions,
        ev.event_tzid || null, ev.local_start || null,
        syncTime
      ).run();
    }

    // Delete anything not touched in this sync = deleted from Outlook
    if (events.length > 0) {
      await env.DB.prepare(
        `DELETE FROM outlook_events WHERE synced_at < ?`
      ).bind(syncTime).run();
      // Clean up hidden entries whose source event no longer exists
      await env.DB.prepare(
        `DELETE FROM hidden_outlook_events WHERE uid NOT IN (SELECT uid FROM outlook_events)`
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

// ── Reusable Outlook event fetcher (used by both the API route and chat context) ──
async function fetchOutlookEventsInRange(env, start, end) {
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
      if (rrule) out.push(...generateOutlookInstances(ev, rrule, start, end));
    }
  }
  out.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  return out;
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

        const out = await fetchOutlookEventsInRange(env, start, end);
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
        const { message, mode, timezone } = body;
        const tz = timezone || 'UTC';
        // Derive today's date in the user's local timezone for date math + relative date resolution
        const now = new Date();
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); // YYYY-MM-DD

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

        // Tight date window to stay within model context limit
        const pastDate   = new Date(Date.now() -  7 * 86400000).toISOString().split('T')[0];
        const futureDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

        const [{ results: tasks }, { results: calEvents }, { results: recentNotes }, outlookEventsRaw] = await Promise.all([
          env.DB.prepare(`SELECT id, title, priority, completed, due_date FROM tasks ORDER BY created_at DESC LIMIT 20`).all(),
          env.DB.prepare(
            `SELECT id, title, start_time, recurrence_type FROM calendar_events
             WHERE is_deleted = 0 AND parent_event_id IS NULL
             AND date(start_time) >= ? AND date(start_time) <= ?
             ORDER BY start_time ASC LIMIT 20`
          ).bind(pastDate, futureDate).all(),
          env.DB.prepare(`SELECT title, content FROM notes WHERE event_id IS NULL ORDER BY updated_at DESC LIMIT 5`).all(),
          fetchOutlookEventsInRange(env, pastDate, futureDate),
        ]);

        // Cap and truncate Outlook events to keep token count low
        const tr = s => (s || '').length > 60 ? s.slice(0, 60) + '…' : (s || '');
        const outlookEvents = outlookEventsRaw.slice(0, 40);

        function fmtEvent(startIso) {
          if (!startIso) return 'no time';
          const d = new Date(startIso);
          try {
            const label = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
              .formatToParts(d).find(p => p.type === 'timeZoneName')?.value || tz;
            return d.toLocaleString('en-US', { timeZone: tz, weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12: true }) + ' ' + label;
          } catch(_) {
            return d.toLocaleString('en-US', { timeZone: 'UTC', weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12: true }) + ' UTC';
          }
        }

        const todayLocal = new Date().toLocaleDateString('en-US', { timeZone: tz, weekday:'long', year:'numeric', month:'long', day:'numeric' });
        const context = `Today is ${todayLocal}.

TASKS:
${tasks.map(t => `- [${t.completed ? 'x' : ' '}] ${tr(t.title)} (${t.priority})${t.due_date ? ` due ${t.due_date}` : ''}`).join('\n') || 'none'}

PERSONAL CALENDAR (past 7d – next 30d):
${calEvents.map(e => `- ${tr(e.title)} — ${fmtEvent(e.start_time)}`).join('\n') || 'none'}

WORK CALENDAR / OUTLOOK (past 7d – next 30d):
${outlookEvents.map(e => `- ${tr(e.title)} — ${fmtEvent(e.start_time)}`).join('\n') || 'none'}

NOTES:
${recentNotes.map(n => `- ${tr(n.title)}: ${(n.content || '').slice(0, 80)}`).join('\n') || 'none'}`;

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
