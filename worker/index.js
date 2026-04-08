const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── HMAC token helpers ──
async function signToken(env, expiryDays = 30) {
  const payload = btoa(JSON.stringify({ iat: Date.now(), exp: Date.now() + expiryDays * 86400000 }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.APP_PASSWORD),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

async function verifyToken(token, env) {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  try {
    const { exp } = JSON.parse(atob(payload));
    if (exp < Date.now()) return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.APP_PASSWORD),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload));
  } catch { return false; }
}

async function checkAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Bearer ')) return verifyToken(header.slice(7), env);
  if (header.startsWith('Basic ')) {
    const [, pass] = atob(header.slice(6)).split(':');
    return pass === env.APP_PASSWORD;
  }
  return false;
}

// ── Migrations — run once per isolate lifetime, not on every request ──
let _migrationsDone = false;
async function runMigrations(env) {
  if (_migrationsDone) return;
  _migrationsDone = true;
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
    `CREATE TABLE IF NOT EXISTS saves (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      thumbnail TEXT DEFAULT '',
      type TEXT DEFAULT 'link',
      tags TEXT DEFAULT '',
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS work_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority TEXT DEFAULT 'NORMAL',
      due_date TEXT,
      completed INTEGER DEFAULT 0,
      synced_at TEXT DEFAULT (datetime('now'))
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

// ── Gmail OAuth helpers ──
async function getGmailAccessToken(env) {
  const [tokenRow, expiresRow, refreshRow] = await Promise.all([
    env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_access_token').first(),
    env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_token_expires').first(),
    env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_refresh_token').first(),
  ]);
  if (!refreshRow?.value) return null;
  // Return cached token if still valid (with 60s buffer)
  if (tokenRow?.value && parseInt(expiresRow?.value||'0') > Date.now() + 60000) return tokenRow.value;
  // Refresh
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshRow.value, grant_type: 'refresh_token' }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  await Promise.all([
    env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('gmail_access_token', data.access_token).run(),
    env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('gmail_token_expires', String(Date.now() + data.expires_in * 1000)).run(),
  ]);
  return data.access_token;
}

async function fetchGmailEmails(env) {
  const token = await getGmailAccessToken(env);
  if (!token) return [];
  const [sendersRow, topicsRow] = await Promise.all([
    env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_filter_senders').first(),
    env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_filter_topics').first(),
  ]);
  const senders = (sendersRow?.value || '').split(',').map(s => s.trim()).filter(Boolean);
  const topics  = (topicsRow?.value  || '').split(',').map(t => t.trim()).filter(Boolean);
  if (!senders.length && !topics.length) return [];
  const parts = [];
  if (senders.length) parts.push('(' + senders.map(s => `from:${s}`).join(' OR ') + ')');
  if (topics.length)  parts.push('(' + topics.map(t => t.includes(' ') ? `"${t}"` : t).join(' OR ') + ')');
  const q = `is:unread newer_than:2d (${parts.join(' OR ')})`;
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) return [];
  const { messages = [] } = await listRes.json();
  const settled = await Promise.allSettled(messages.map(async m => {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return null;
    const msg = await r.json();
    const get = name => (msg.payload?.headers || []).find(h => h.name === name)?.value || '';
    const fromRaw = get('From');
    const fm = fromRaw.match(/^"?([^"<]+?)"?\s*<(.+?)>$/);
    return {
      id: msg.id,
      fromName:    fm ? fm[1].trim() : fromRaw,
      fromEmail:   fm ? fm[2]        : fromRaw,
      subject:     get('Subject') || '(no subject)',
      snippet:     msg.snippet || '',
      date:        get('Date'),
      isImportant: (msg.labelIds || []).includes('IMPORTANT'),
      link:        `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
    };
  }));
  return settled.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
}

// ── Save metadata fetcher ──
async function fetchSaveMeta(url) {
  const meta = { title: '', description: '', thumbnail: '', type: 'link' };
  try {
    // YouTube
    const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (ytMatch) {
      meta.type = 'video';
      const oembed = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (oembed.ok) {
        const d = await oembed.json();
        meta.title = d.title || '';
        meta.thumbnail = d.thumbnail_url || `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`;
        meta.description = d.author_name ? `by ${d.author_name}` : '';
      }
      return meta;
    }
    // General OG/meta extraction
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Cerebro/1.0)' } });
    if (!res.ok) return meta;
    const html = await res.text();
    const og = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
               || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'));
      return m ? m[1] : '';
    };
    const metaName = (name) => {
      const m = html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))
               || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'));
      return m ? m[1] : '';
    };
    const titleTag = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
    meta.title = og('title') || metaName('title') || titleTag;
    meta.description = og('description') || metaName('description') || '';
    meta.thumbnail = og('image') || '';
    // Detect type
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('video') || url.match(/\.(mp4|webm|mov)$/i)) meta.type = 'video';
    else if (ct.includes('text/html')) meta.type = 'article';
    // Trim
    if (meta.description.length > 300) meta.description = meta.description.slice(0, 297) + '...';
  } catch {}
  return meta;
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
  // Collect all configured ICS URLs (primary + up to 9 extras)
  const icsUrls = [];
  if (env.OUTLOOK_ICS_URL) icsUrls.push(env.OUTLOOK_ICS_URL);
  for (let i = 2; i <= 10; i++) {
    const extra = env[`OUTLOOK_ICS_URL_${i}`];
    if (extra) icsUrls.push(extra);
  }
  if (icsUrls.length === 0) return { ok: false, error: 'OUTLOOK_ICS_URL secret not set' };

  const syncTime = new Date().toISOString();
  const errors = [];
  let totalCount = 0;

  for (const icsUrl of icsUrls) {
    try {
      const res = await fetch(icsUrl, { headers: { 'User-Agent': 'Cerebro/1.0' } });
      if (!res.ok) throw new Error(`ICS fetch failed: HTTP ${res.status}`);
      const text   = await res.text();
      const events = parseICS(text);

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
      totalCount += events.length;
    } catch (e) {
      errors.push(e.message);
    }
  }

  // Delete events not touched by any calendar in this sync = removed from Outlook
  if (totalCount > 0) {
    await env.DB.prepare(
      `DELETE FROM outlook_events WHERE synced_at < ?`
    ).bind(syncTime).run();
    await env.DB.prepare(
      `DELETE FROM hidden_outlook_events WHERE uid NOT IN (SELECT uid FROM outlook_events)`
    ).run();
  }

  await env.DB.prepare(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('outlook_last_sync', ?)`
  ).bind(new Date().toISOString()).run();

  if (errors.length && totalCount === 0) {
    return { ok: false, error: errors.join('; ') };
  }
  return { ok: true, count: totalCount, calendars: icsUrls.length, errors: errors.length ? errors : undefined };
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

// ── Daily Brief: external data helpers ──

function wmoInfo(code) {
  if (code === 0)                    return { icon: '☀️',  label: 'Clear' };
  if (code <= 2)                     return { icon: '🌤',  label: 'Mostly Clear' };
  if (code === 3)                    return { icon: '☁️',  label: 'Overcast' };
  if (code <= 48)                    return { icon: '🌫',  label: 'Foggy' };
  if (code <= 55)                    return { icon: '🌦',  label: 'Drizzle' };
  if (code <= 65)                    return { icon: '🌧',  label: 'Rain' };
  if (code <= 75)                    return { icon: '❄️',  label: 'Snow' };
  if (code <= 82)                    return { icon: '🌧',  label: 'Showers' };
  if (code === 85 || code === 86)    return { icon: '🌨',  label: 'Snow Showers' };
  if (code >= 95)                    return { icon: '⛈',  label: 'Thunderstorm' };
  return { icon: '🌡', label: 'Unknown' };
}

async function geocodeZip(zip) {
  const raw = zip.trim();
  const isUsZip = /^\d{5}$/.test(raw);

  // Primary for US ZIP codes: Census Bureau geocoding — free .gov API, handles ZIP natively
  if (isUsZip) {
    try {
      const res = await fetch(
        `https://geocoding.geo.census.gov/geocoder/locations/address?benchmark=Public_AR_Current&zip=${raw}&format=json`
      );
      if (res.ok) {
        const d = await res.json();
        const match = d.result?.addressMatches?.[0];
        if (match) {
          const { x: lon, y: lat } = match.coordinates;
          const city  = match.addressComponents?.city  || '';
          const state = match.addressComponents?.state || '';
          const name  = [city, state].filter(Boolean).join(', ') || raw;
          return { lat, lon, name };
        }
      }
    } catch { /* fall through */ }
  }

  // Fallback: Open-Meteo geocoding (works for city names, may work for some ZIPs)
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(raw)}&count=3&language=en&format=json`);
    if (res.ok) {
      const d = await res.json();
      const r = d.results?.find(x => x.country_code === 'US') || d.results?.[0];
      if (r) return { lat: r.latitude, lon: r.longitude, name: `${r.name}, ${r.admin1 || ''}`.replace(/, $/, '') };
    }
  } catch { /* fall through */ }

  // Last resort for US ZIPs: zippopotam.us
  if (isUsZip) {
    try {
      const res = await fetch(`https://api.zippopotam.us/us/${raw}`);
      if (res.ok) {
        const d = await res.json();
        const place = d.places?.[0];
        if (place) return { lat: parseFloat(place.latitude), lon: parseFloat(place.longitude), name: `${place['place name']}, ${place['state abbreviation']}` };
      }
    } catch { /* give up */ }
  }

  return null;
}

async function briefFetchWeather(lat, lon) {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,precipitation` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=6`
    );
    if (!res.ok) return null;
    const d = await res.json();
    const cur = d.current || {};
    const day = d.daily  || {};
    const { icon, label } = wmoInfo(cur.weathercode ?? 0);
    // Build 5-day forecast (today + next 4 days, indices 0-4)
    const dates    = day.time                       || [];
    const highs    = day.temperature_2m_max         || [];
    const lows     = day.temperature_2m_min         || [];
    const codes    = day.weathercode                || [];
    const forecast = dates.slice(0, 5).map((date, i) => ({
      date,
      high: Math.round(highs[i] ?? 0),
      low:  Math.round(lows[i]  ?? 0),
      ...wmoInfo(codes[i] ?? 0),
    }));
    return {
      temp:        Math.round(cur.temperature_2m       ?? 0),
      feelsLike:   Math.round(cur.apparent_temperature ?? 0),
      high:        Math.round((highs)[0] ?? 0),
      low:         Math.round((lows)[0]  ?? 0),
      precipChance:(day.precipitation_probability_max || [])[0] ?? 0,
      windSpeed:   Math.round(cur.windspeed_10m ?? 0),
      icon, label, forecast, lat, lon,
    };
  } catch { return null; }
}

// Weather via wttr.in — accepts ZIP/city directly, no geocoding needed
async function briefFetchWeatherByZip(zip) {
  try {
    const res = await fetch(
      `https://wttr.in/${encodeURIComponent(zip.trim())}?format=j1`,
      { headers: { 'User-Agent': 'Cerebro/1.0 personal-dashboard', Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const cur = d.current_condition?.[0];
    if (!cur) return null;

    // Location name from wttr.in nearest_area
    const area  = d.nearest_area?.[0];
    const city  = area?.areaName?.[0]?.value || '';
    const state = area?.region?.[0]?.value   || '';
    const locationName = [city, state].filter(Boolean).join(', ');

    // wttr.in weather code → icon/label
    function wwoInfo(code) {
      const c = parseInt(code);
      if (c === 113)                              return { icon: '☀️',  label: 'Clear' };
      if (c === 116)                              return { icon: '🌤',  label: 'Partly Cloudy' };
      if (c === 119 || c === 122)                 return { icon: '☁️',  label: 'Overcast' };
      if ([143,248,260].includes(c))              return { icon: '🌫',  label: 'Foggy' };
      if ([176,263,266,293,296].includes(c))      return { icon: '🌦',  label: 'Drizzle' };
      if ([299,302,305,308,311,314].includes(c))  return { icon: '🌧',  label: 'Rain' };
      if (c >= 317 && c <= 395 && c !== 386 && c !== 389 && c !== 392 && c !== 395)
                                                  return { icon: '❄️',  label: 'Snow' };
      if ([200,386,389,392,395].includes(c))      return { icon: '⛈',  label: 'Thunderstorm' };
      return { icon: '🌡', label: 'Unknown' };
    }

    const { icon, label } = wwoInfo(cur.weatherCode);

    // Max rain-chance across today's hourly slots
    const todayHourly  = d.weather?.[0]?.hourly || [];
    const precipChance = todayHourly.reduce((m, h) => Math.max(m, parseInt(h.chanceofrain || 0)), 0);

    // 5-day forecast
    const forecast = (d.weather || []).slice(0, 5).map(day => {
      const noonSlot = day.hourly?.find(h => parseInt(h.time) >= 1100) || day.hourly?.[0];
      return {
        date: day.date,
        high: parseInt(day.maxtempF || 0),
        low:  parseInt(day.mintempF || 0),
        ...wwoInfo(noonSlot?.weatherCode || '113'),
      };
    });

    return {
      temp:         parseInt(cur.temp_F),
      feelsLike:    parseInt(cur.FeelsLikeF),
      high:         parseInt(d.weather?.[0]?.maxtempF ?? cur.temp_F),
      low:          parseInt(d.weather?.[0]?.mintempF ?? cur.temp_F),
      precipChance, windSpeed: parseInt(cur.windspeedMiles),
      icon, label, forecast,
      lat: null, lon: null, locationName,
    };
  } catch { return null; }
}

async function briefFetchStocks(tickerStr) {
  if (!tickerStr.trim()) return [];
  const symbols = tickerStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 12);
  if (!symbols.length) return [];
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json' };
  const results = await Promise.allSettled(
    symbols.map(sym =>
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d`, { headers })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          const meta = data?.chart?.result?.[0]?.meta;
          if (!meta) return null;
          const price         = meta.regularMarketPrice || meta.previousClose || 0;
          const prevClose     = meta.chartPreviousClose || meta.previousClose || price;
          const change        = price - prevClose;
          // Prefer Yahoo's official changePercent; fall back to manual calc
          const changePercent = meta.regularMarketChangePercent != null
            ? meta.regularMarketChangePercent
            : (prevClose ? (change / prevClose) * 100 : 0);
          return {
            symbol:      sym,
            name:        meta.longName || meta.shortName || sym,
            price,
            change,
            changePercent,
            marketState: meta.marketState || 'CLOSED',   // REGULAR | PRE | POST | CLOSED
          };
        })
    )
  );
  return results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
}

async function briefFetchSports(teamStr) {
  if (!teamStr.trim()) return [];
  const teams = teamStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!teams.length) return [];

  const leagues = [
    ['football',   'nfl'],
    ['basketball', 'nba'],
    ['baseball',   'mlb'],
    ['hockey',     'nhl'],
    ['soccer',     'usa.1'],    // MLS
    ['basketball', 'wnba'],
    ['football',   'college-football'],
    ['basketball', 'mens-college-basketball'],
  ];

  const ESPN_PATH = { 'nfl':'nfl','nba':'nba','mlb':'mlb','nhl':'nhl','usa.1':'soccer','wnba':'wnba','college-football':'college-football','mens-college-basketball':'mens-college-basketball' };

  const settled = await Promise.allSettled(
    leagues.map(([sport, league]) =>
      fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl: 180 } })
      .then(r => r.ok ? r.json() : { events: [] })
      .then(data => (data.events || []).map(ev => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === 'home');
        const away = comp?.competitors?.find(c => c.homeAway === 'away');
        const sportPath = ESPN_PATH[league] || league;
        const broadcasts = (comp?.broadcasts || [])
          .flatMap(b => b.names || [])
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 4);
        // statusState: 'pre' = not started, 'in' = live, 'post' = final
        const statusState = comp?.status?.type?.state || 'pre';
        // shortDetail gives nicely-formatted game state e.g. "Q3 - 5:22", "Top 3rd", "76'", "2nd OT"
        const statusDetail = comp?.status?.type?.shortDetail || comp?.status?.type?.detail || '';
        return {
          league,
          home:        home?.team?.displayName || '',
          away:        away?.team?.displayName || '',
          homeScore:   statusState !== 'pre' ? (home?.score ?? '') : '',
          awayScore:   statusState !== 'pre' ? (away?.score ?? '') : '',
          status:      comp?.status?.type?.description || '',
          statusState,
          statusDetail,
          date:        ev.date || '',
          link:        `https://www.espn.com/${sportPath}/game/_/gameId/${ev.id}`,
          broadcasts,
        };
      }))
    )
  );

  const allGames = settled.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  return allGames.filter(g => {
    const hn = g.home.toLowerCase();
    const an = g.away.toLowerCase();
    return teams.some(t => {
      if (hn.includes(t) || an.includes(t)) return true;
      // All significant words in the user's term must appear in the team name
      const tWords = t.split(' ').filter(w => w.length > 3);
      return tWords.length > 0 && (tWords.every(w => hn.includes(w)) || tWords.every(w => an.includes(w)));
    });
  });
}

async function briefFetchNews(topicStr) {
  if (!topicStr.trim()) return [];
  const topics = topicStr.split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
  if (!topics.length) return [];

  const raw = t => t?.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/<[^>]+>/g,'') || '';
  // Extract source from "Title - Source" pattern when RSS tag is missing
  function splitTitleSource(title, rssSource) {
    if (rssSource) return { title, source: rssSource };
    // Use greedy .* so we split at the LAST dash separator (source is always at the end)
    const m = title.match(/^(.*)\s+[-–—]\s+([^-–—]{3,60})$/);
    return m ? { title: m[1].trim(), source: m[2].trim() } : { title, source: '' };
  }

  async function fetchFromBing(topic) {
    const res = await fetch(
      `https://www.bing.com/news/search?q=${encodeURIComponent(topic)}&format=RSS&mkt=en-US&count=5`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } }
    );
    if (!res.ok) return [];
    const text = await res.text();
    const results = [];
    for (const [, block] of [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 3)) {
      const rawTitle = raw(block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]);
      const link     = block.match(/<link\s*\/?>(.*?)<\/link>/)?.[1]?.trim() || block.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/)?.[1] || '';
      const rssSource = raw(block.match(/<source[^>]*>(.*?)<\/source>/i)?.[1]) || raw(block.match(/<[a-zA-Z]*:?provider[^>]*>(.*?)<\/[a-zA-Z]*:?provider>/i)?.[1]) || raw(block.match(/<[a-zA-Z]+:name[^>]*>(.*?)<\/[a-zA-Z]+:name>/i)?.[1]) || '';
      const pubDate  = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      if (rawTitle) { const { title, source } = splitTitleSource(rawTitle, rssSource); results.push({ title, link, source, pubDate, topic }); }
    }
    return results;
  }

  async function fetchFromGoogle(topic) {
    const res = await fetch(
      `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }
    );
    if (!res.ok) return [];
    const text = await res.text();
    const results = [];
    for (const [, block] of [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 3)) {
      const rawTitle  = raw(block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]);
      const link      = block.match(/<link>(.*?)<\/link>/)?.[1] || block.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/)?.[1] || '';
      const rssSource = raw(block.match(/<source[^>]*>(.*?)<\/source>/)?.[1]) || '';
      const pubDate   = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      if (rawTitle) { const { title, source } = splitTitleSource(rawTitle, rssSource); results.push({ title, link, source, pubDate, topic }); }
    }
    return results;
  }

  // Collect per-topic results then flatten in settings order (not arrival order)
  const settled = await Promise.allSettled(
    topics.map(async topic => {
      try {
        let results = await fetchFromBing(topic);
        if (!results.length) results = await fetchFromGoogle(topic);
        return results;
      } catch { return []; }
    })
  );
  return settled.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

// ── Router ──
export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      // Top-level catch: always return CORS headers so browser doesn't see a network error
      return new Response(JSON.stringify({ error: e.message || 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncOutlook(env));
  },
};

async function handleRequest(request, env) {
    await runMigrations(env);

    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── Login: exchange password for 30-day token ──
    if (path === '/api/auth/token' && method === 'POST') {
      const { password } = await request.json();
      if (password !== env.APP_PASSWORD) return json({ error: 'Unauthorized' }, 401);
      const token = await signToken(env);
      return json({ token });
    }

    // ── Work Tasks inbound sync (no Cerebro auth — uses its own sync token + HMAC) ──
    if (path === '/api/work/tasks/sync' && method === 'POST') {
      const tokenRow = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('work_sync_token').first();
      if (!tokenRow?.value) return json({ error: 'Sync not configured' }, 503);

      const rawBody = await request.text();
      const secret = tokenRow.value;

      // Verify HMAC-SHA256 signature if provided (X-Cerebro-Signature: sha256=<hex>)
      const sigHeader = request.headers.get('X-Cerebro-Signature') || '';
      if (sigHeader) {
        const expected = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader;
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
        const actual = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2,'0')).join('');
        if (actual !== expected) return json({ error: 'Invalid signature' }, 401);
      } else {
        // Fall back to Bearer token check if no signature header
        const authHeader = request.headers.get('Authorization') || '';
        const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        if (!provided || provided !== secret) return json({ error: 'Invalid sync token' }, 401);
      }

      let body; try { body = JSON.parse(rawBody); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const incoming = Array.isArray(body) ? body : (body.tasks || []);
      const now = new Date().toISOString();
      // Full replace: delete all existing, insert all incoming in a batch
      await env.DB.prepare('DELETE FROM work_tasks').run();
      if (incoming.length) {
        for (const t of incoming) {
          await env.DB.prepare(
            `INSERT INTO work_tasks (id, title, description, priority, due_date, completed, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            String(t.id || crypto.randomUUID()),
            t.title || '',
            t.description || '',
            t.priority || 'NORMAL',
            t.dueDate ? t.dueDate.slice(0, 10) : (t.due_date || null),
            t.completed ? 1 : 0,
            now
          ).run();
        }
      }
      return json({ ok: true, synced: incoming.length });
    }

    // ── Gmail OAuth callback (no Cerebro auth — comes from Google redirect) ──
    if (path === '/api/gmail/callback' && method === 'GET') {
      const code  = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const stateRow = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_oauth_state').first();
      const [savedState, origin] = (stateRow?.value || '').split('|');
      if (!code || !state || state !== savedState) {
        return new Response('Invalid OAuth state', { status: 400 });
      }
      // Exchange code for tokens
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${url.origin}/api/gmail/callback`, grant_type: 'authorization_code',
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        return new Response(`Token exchange failed: ${err}`, { status: 400 });
      }
      const data = await res.json();
      await Promise.all([
        env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('gmail_refresh_token', data.refresh_token).run(),
        env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('gmail_access_token', data.access_token).run(),
        env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('gmail_token_expires', String(Date.now() + (data.expires_in||3600) * 1000)).run(),
        env.DB.prepare('DELETE FROM settings WHERE key=?').bind('gmail_oauth_state').run(),
      ]);
      return Response.redirect(`${origin || url.origin}/settings.html?gmail=connected`, 302);
    }

    if (path.startsWith('/api/') && !await checkAuth(request, env)) {
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

      // Debug: search outlook_events by title substring (auth required)
      if (seg[1] === 'outlook' && seg[2] === 'search' && method === 'GET') {
        if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
        const q = url.searchParams.get('q') || '';
        const { results } = await env.DB.prepare(
          `SELECT uid, title, start_time, recurrence_rule, event_tzid, local_start FROM outlook_events WHERE LOWER(title) LIKE ? LIMIT 20`
        ).bind(`%${q.toLowerCase()}%`).all();
        const total = await env.DB.prepare(`SELECT COUNT(*) as n FROM outlook_events`).first();
        return json({ total: total?.n, matches: results });
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
        const { message, mode, timezone, tzLabel } = body;
        const tz = timezone || 'UTC';
        const tzDisplay = tzLabel || tz;
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

        const futureDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
        const todayPrefix = today + 'T00:00:00';

        // Extract search keywords from message
        const STOPWORDS = new Set(['when','is','my','next','last','the','a','an','what','do','does','did','will','would','could','should','have','has','had','i','me','you','we','they','this','that','are','or','and','but','for','not','with','from','by','at','to','of','in','on','about','any','all','tell','show','find','list','get','meeting','event','calendar','schedule','scheduled','upcoming','today','tomorrow','week']);
        const queryKeywords = [...new Set(
          message.toLowerCase().split(/\W+/).filter(w => w.length > 1 && !STOPWORDS.has(w))
        )];

        // Keyword search: find matching base events (newest first), generate their upcoming instances.
        // ORDER BY start_time DESC ensures we find the active/latest series before expired older ones.
        let sqlMatched = [];
        if (queryKeywords.length) {
          const likeClause = queryKeywords.map(() => 'LOWER(title) LIKE ?').join(' OR ');
          const likeArgs   = queryKeywords.map(k => `%${k}%`);
          const { results: baseMatches } = await env.DB.prepare(
            `SELECT * FROM outlook_events WHERE ${likeClause} ORDER BY start_time DESC LIMIT 20`
          ).bind(...likeArgs).all();
          for (const base of baseMatches) {
            if (base.recurrence_rule) {
              const rr = parseRRule(base.recurrence_rule);
              if (rr) sqlMatched.push(...generateOutlookInstances(base, rr, today, futureDate).slice(0, 5));
            } else if (base.start_time >= todayPrefix) {
              sqlMatched.push(base);
            }
          }
          // Also personal calendar
          const { results: calMatches } = await env.DB.prepare(
            `SELECT id, title, start_time FROM calendar_events WHERE (${likeClause}) AND is_deleted=0 AND date(start_time) >= ? LIMIT 5`
          ).bind(...likeArgs, today).all();
          sqlMatched.push(...calMatches);
          sqlMatched.sort((a,b) => (a.start_time||'').localeCompare(b.start_time||''));
        }

        const [{ results: tasks }, { results: calEvents }, { results: recentNotes }, { results: outlookBase }] = await Promise.all([
          env.DB.prepare(`SELECT title, priority, completed, due_date FROM tasks ORDER BY created_at DESC LIMIT 15`).all(),
          env.DB.prepare(
            `SELECT title, start_time FROM calendar_events
             WHERE is_deleted=0 AND date(start_time) >= ? AND date(start_time) <= ?
             ORDER BY start_time ASC LIMIT 10`
          ).bind(today, futureDate).all(),
          env.DB.prepare(`SELECT title, content FROM notes WHERE event_id IS NULL ORDER BY updated_at DESC LIMIT 5`).all(),
          // Fallback: all base event titles so AI can fuzzy-match by context
          env.DB.prepare(`SELECT uid, title, start_time, recurrence_rule, event_tzid, local_start FROM outlook_events ORDER BY start_time DESC LIMIT 60`).all(),
        ]);

        const tr = s => (s || '').length > 60 ? s.slice(0, 60) + '…' : (s || '');

        function fmtEvent(startIso) {
          if (!startIso) return 'no time';
          try {
            return new Date(startIso).toLocaleString('en-US', { timeZone: tz, weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12: true }) + ' ' + tzDisplay;
          } catch(_) { return startIso; }
        }

        const todayLocal = new Date().toLocaleDateString('en-US', { timeZone: tz, weekday:'long', year:'numeric', month:'long', day:'numeric' });
        const matchedUpcoming = sqlMatched.filter(e => (e.start_time||'') >= todayPrefix).slice(0, 8);

        // If SQL search found no matches, fetch upcoming work events (7-day window to stay fast)
        const hasMatches = matchedUpcoming.length > 0;
        const calUpcoming = calEvents.slice(0, 10);
        let workUpcoming = [];
        if (!hasMatches) {
          const nearFuture = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
          workUpcoming = (await fetchOutlookEventsInRange(env, today, nearFuture)).slice(0, 20);
          if (workUpcoming.length === 0) {
            // Nothing this week — try the full 30-day window
            workUpcoming = (await fetchOutlookEventsInRange(env, today, futureDate)).slice(0, 20);
          }
        }

        const context = `Today is ${todayLocal}. Times are in ${tzDisplay} — quote exactly, never say UTC.
${matchedUpcoming.length ? `\nEVENTS MATCHING QUERY:\n${matchedUpcoming.map(e => `- ${e.title} — ${fmtEvent(e.start_time)}`).join('\n')}` : ''}
TASKS: ${tasks.slice(0,10).map(t => `${tr(t.title)}(${t.completed?'done':'open'})`).join(', ') || 'none'}
${calUpcoming.length ? `PERSONAL EVENTS:\n${calUpcoming.map(e=>`- ${tr(e.title)} — ${fmtEvent(e.start_time)}`).join('\n')}` : ''}
${workUpcoming.length ? `WORK EVENTS:\n${workUpcoming.map(e=>`- ${tr(e.title)} — ${fmtEvent(e.start_time)}`).join('\n')}` : ''}
NOTES: ${recentNotes.map(n=>`${tr(n.title)}: ${(n.content||'').slice(0,60)}`).join(' | ') || 'none'}`;

        const systemPrompt = `You are Cerebro, a concise personal assistant.
${context}
${!hasMatches ? `\nSearch ALL events above carefully to answer the user's question.` : ''}
Reply in 1-3 sentences. For create task/event return JSON: {"message":"...","action":{"type":"create_task","data":{"title":"...","priority":"NORMAL","dueDate":null}}} or {"message":"...","action":{"type":"create_event","data":{"title":"...","startTime":"YYYY-MM-DDTHH:MM:00","endTime":null}}}. Otherwise plain text only.`;

        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('AI response timed out — please try again')), 28000)
        );
        const aiRes = await Promise.race([
          env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: message },
            ],
            max_tokens: 256,
          }),
          timeout,
        ]);

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

      // ──────────────────────────────
      // DAILY BRIEF
      // ──────────────────────────────

      // Settings: GET / PUT
      if (seg[1] === 'brief' && seg[2] === 'settings') {
        if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
        if (method === 'GET') {
          const [t, te, to, wz] = await Promise.all([
            env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('brief_tickers').first(),
            env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('brief_teams').first(),
            env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('brief_topics').first(),
            env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('weather_zip').first(),
          ]);
          return json({ tickers: t?.value||'', teams: te?.value||'', topics: to?.value||'', weatherZip: wz?.value||'' });
        }
        if (method === 'PUT') {
          const { tickers='', teams='', topics='', weatherZip='' } = await request.json();
          await Promise.all([
            env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('brief_tickers', tickers).run(),
            env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('brief_teams', teams).run(),
            env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('brief_topics', topics).run(),
            env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('weather_zip', weatherZip).run(),
          ]);
          return json({ ok: true });
        }
      }

      // ── Work Tasks (auth-protected reads + settings) ──
      if (seg[1] === 'work') {
        if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

        // GET /api/work/settings — return sync token (generate if missing) + webhook URL
        if (seg[2] === 'settings' && method === 'GET') {
          let tokenRow = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('work_sync_token').first();
          if (!tokenRow?.value) {
            const newToken = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2,'0')).join('');
            await env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('work_sync_token', newToken).run();
            tokenRow = { value: newToken };
          }
          return json({ token: tokenRow.value, webhookUrl: `${url.origin}/api/work/tasks/sync` });
        }

        // POST /api/work/settings/regenerate — issue a new token
        if (seg[2] === 'settings' && seg[3] === 'regenerate' && method === 'POST') {
          const newToken = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2,'0')).join('');
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('work_sync_token', newToken).run();
          return json({ token: newToken, webhookUrl: `${url.origin}/api/work/tasks/sync` });
        }

        // GET /api/work/tasks — read work tasks from D1
        if (seg[2] === 'tasks' && method === 'GET') {
          const { results } = await env.DB.prepare(
            `SELECT id, title, description, priority, due_date, completed FROM work_tasks ORDER BY
             CASE priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
             due_date ASC NULLS LAST`
          ).all();
          return json({ tasks: results.map(t => ({ ...t, completed: !!t.completed, source: 'work' })) });
        }
      }

      // ── Saves ──
      if (seg[1] === 'saves') {
        if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

        if (!seg[2] && method === 'GET') {
          const tag    = url.searchParams.get('tag')    || '';
          const type   = url.searchParams.get('type')   || '';
          const unread = url.searchParams.get('unread') || '';
          const search = url.searchParams.get('search') || '';
          let q = 'SELECT * FROM saves WHERE 1=1';
          const params = [];
          if (tag)    { q += " AND (',' || tags || ',' LIKE ?)"; params.push(`%,${tag},%`); }
          if (type)   { q += ' AND type=?'; params.push(type); }
          if (unread) { q += ' AND is_read=0'; }
          if (search) { q += ' AND (title LIKE ? OR url LIKE ? OR tags LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
          q += ' ORDER BY created_at DESC';
          const stmt = env.DB.prepare(q);
          const { results } = params.length ? await stmt.bind(...params).all() : await stmt.all();
          return json(results);
        }

        if (!seg[2] && method === 'POST') {
          const body = await request.json();
          if (!body.url) return json({ error: 'url required' }, 400);
          const id   = crypto.randomUUID();
          const meta = await fetchSaveMeta(body.url);
          const title = body.title || meta.title || body.url;
          const tags  = (body.tags || '').toLowerCase().trim();
          await env.DB.prepare(
            `INSERT INTO saves (id, url, title, description, thumbnail, type, tags) VALUES (?,?,?,?,?,?,?)`
          ).bind(id, body.url, title, meta.description, meta.thumbnail, meta.type, tags).run();
          return json({ id, url: body.url, title, description: meta.description, thumbnail: meta.thumbnail, type: meta.type, tags, is_read: 0 }, 201);
        }

        if (seg[2] && method === 'PATCH') {
          const id = seg[2];
          const body = await request.json();
          const fields = [];
          const params = [];
          if ('title'   in body) { fields.push('title=?');   params.push(body.title); }
          if ('tags'    in body) { fields.push('tags=?');     params.push((body.tags||'').toLowerCase().trim()); }
          if ('is_read' in body) { fields.push('is_read=?'); params.push(body.is_read ? 1 : 0); }
          if (!fields.length) return json({ error: 'Nothing to update' }, 400);
          params.push(id);
          await env.DB.prepare(`UPDATE saves SET ${fields.join(',')} WHERE id=?`).bind(...params).run();
          return json({ ok: true });
        }

        if (seg[2] && method === 'DELETE') {
          await env.DB.prepare('DELETE FROM saves WHERE id=?').bind(seg[2]).run();
          return json({ ok: true });
        }
      }

      // Expanded news for a single topic (modal)
      if (seg[1] === 'news' && !seg[2] && method === 'GET') {
        if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
        const topic = url.searchParams.get('topic')?.trim() || '';
        if (!topic) return json([]);

        const rawStr = t => t?.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/<[^>]+>/g,'') || '';
        function splitTS(title, rssSource) {
          if (rssSource) return { title, source: rssSource };
          const m = title.match(/^(.*)\s+[-–—]\s+([^-–—]{3,60})$/);
          return m ? { title: m[1].trim(), source: m[2].trim() } : { title, source: '' };
        }
        const results = []; const seen = new Set();
        function parseItems(text, limit) {
          for (const [, block] of [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit)) {
            const rawTitle  = rawStr(block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]);
            const link      = block.match(/<link\s*\/?>(.*?)<\/link>/)?.[1]?.trim() || block.match(/<link>(.*?)<\/link>/)?.[1] || block.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/)?.[1] || '';
            const rssSource = rawStr(block.match(/<source[^>]*>(.*?)<\/source>/i)?.[1]) || rawStr(block.match(/<[a-zA-Z]*:?provider[^>]*>(.*?)<\/[a-zA-Z]*:?provider>/i)?.[1]) || '';
            const pubDate   = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
            if (rawTitle && !seen.has(rawTitle)) {
              seen.add(rawTitle);
              const { title, source } = splitTS(rawTitle, rssSource);
              results.push({ title, link, source, pubDate });
            }
          }
        }
        const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
        await Promise.allSettled([
          fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(topic)}&format=RSS&mkt=en-US&count=15`, { headers: { ...UA, 'Accept-Language': 'en-US,en;q=0.9' } })
            .then(r => r.ok ? r.text() : '').then(t => t && parseItems(t, 12)).catch(() => {}),
          fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`, { headers: UA })
            .then(r => r.ok ? r.text() : '').then(t => t && parseItems(t, 12)).catch(() => {}),
        ]);
        results.sort((a, b) => (new Date(b.pubDate) || 0) - (new Date(a.pubDate) || 0));
        return json(results.slice(0, 20));
      }

      // Main brief endpoint
      if (seg[1] === 'brief' && !seg[2] && method === 'GET') {
        if (!await checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

        const today = url.searchParams.get('date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
        const endDate = (() => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + 6); return d.toISOString().slice(0,10); })();

        // Location: prefer ?lat&lon from client GPS; fall back to stored zip
        const latParam = url.searchParams.get('lat');
        const lonParam = url.searchParams.get('lon');

        // Load settings + D1 data in parallel
        const [tickerRow, teamRow, topicRow, zipRow, { results: dueTasks }, { results: workDueTasks }, personalEvRes, outlookEvRes] = await Promise.all([
          env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('brief_tickers').first(),
          env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('brief_teams').first(),
          env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('brief_topics').first(),
          env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('weather_zip').first(),
          env.DB.prepare(`SELECT title, priority, due_date FROM tasks WHERE completed=0 AND ((due_date BETWEEN ? AND ?) OR priority IN ('URGENT','HIGH')) ORDER BY CASE priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END, due_date ASC NULLS LAST`).bind(today, endDate).all(),
          env.DB.prepare(`SELECT id, title, priority, due_date FROM work_tasks WHERE completed=0 AND ((due_date BETWEEN ? AND ?) OR priority IN ('URGENT','HIGH'))`).bind(today, endDate).all(),
          (async () => {
            try {
              const r = await fetch(`${url.origin}/api/events?start=${today}&end=${today}`, { headers: request.headers });
              return r.ok ? r.json() : { events: [] };
            } catch { return { events: [] }; }
          })(),
          (async () => { try { return await fetchOutlookEventsInRange(env, today, today); } catch { return []; } })(),
        ]);

        const personalEv = (personalEvRes.events || []).map(e => ({ title: e.title, start_time: e.start_time }));
        const workEv     = Array.isArray(outlookEvRes) ? outlookEvRes.map(e => ({ title: e.title, start_time: e.start_time })) : [];
        const meetings   = [...personalEv, ...workEv].sort((a,b)=>(a.start_time||'').localeCompare(b.start_time||''));

        // Resolve weather: GPS params → Open-Meteo direct; stored ZIP → geocode → Open-Meteo
        let weatherLatLon = null, weatherLocation = '';
        if (latParam && lonParam) {
          weatherLatLon = { lat: parseFloat(latParam), lon: parseFloat(lonParam) };
          weatherLocation = 'Current Location';
        } else if (zipRow?.value) {
          const geo = await geocodeZip(zipRow.value).catch(() => null);
          if (geo) { weatherLatLon = geo; weatherLocation = geo.name || zipRow.value; }
        }

        // Fetch external data in parallel
        const gmailTokenRow = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_refresh_token').first();
        const gmailConnected = !!gmailTokenRow?.value;

        const [stocks, sports, news, sportsNews, gmailEmails, weather] = await Promise.all([
          briefFetchStocks(tickerRow?.value || ''),
          briefFetchSports(teamRow?.value   || ''),
          briefFetchNews(topicRow?.value    || ''),
          briefFetchNews(teamRow?.value     || ''),
          gmailConnected ? fetchGmailEmails(env).catch(() => []) : Promise.resolve([]),
          weatherLatLon ? briefFetchWeather(weatherLatLon.lat, weatherLatLon.lon).catch(() => null) : Promise.resolve(null),
        ]);

        // Merge personal + work tasks sorted by priority then due date
        const PO = { URGENT: 0, HIGH: 1, NORMAL: 2, BACKLOG: 3 };
        const allDueTasks = [
          ...dueTasks.map(t => ({ ...t, source: 'personal' })),
          ...(workDueTasks || []).map(t => ({ ...t, source: 'work' })),
        ].sort((a, b) => {
          const pd = (PO[a.priority] ?? 2) - (PO[b.priority] ?? 2);
          if (pd !== 0) return pd;
          if (!a.due_date && !b.due_date) return 0;
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return a.due_date.localeCompare(b.due_date);
        });

        return json({ dueToday: allDueTasks, meetings, stocks, sports, news, sportsNews, gmailEmails, gmailConnected, weather, weatherLocation, settings: { tickers: tickerRow?.value||'', teams: teamRow?.value||'', topics: topicRow?.value||'', weatherZip: zipRow?.value||'' } });
      }

      // ──────────────────────────────
      // GMAIL
      // ──────────────────────────────
      if (seg[1] === 'gmail') {
        // Start OAuth flow
        if (seg[2] === 'auth' && method === 'GET') {
          const origin = url.searchParams.get('origin') || url.origin;
          const state  = crypto.randomUUID().replace(/-/g,'');
          await env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('gmail_oauth_state', `${state}|${origin}`).run();
          const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          authUrl.searchParams.set('client_id',     env.GOOGLE_CLIENT_ID);
          authUrl.searchParams.set('redirect_uri',  `${url.origin}/api/gmail/callback`);
          authUrl.searchParams.set('response_type', 'code');
          authUrl.searchParams.set('scope',         'https://www.googleapis.com/auth/gmail.readonly');
          authUrl.searchParams.set('access_type',   'offline');
          authUrl.searchParams.set('prompt',         'consent');
          authUrl.searchParams.set('state',          state);
          return Response.redirect(authUrl.toString(), 302);
        }
        // Connection status
        if (seg[2] === 'status' && method === 'GET') {
          const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_refresh_token').first();
          return json({ connected: !!row?.value });
        }
        // Debug: test fetch emails directly
        if (seg[2] === 'test' && method === 'GET') {
          const emails = await fetchGmailEmails(env);
          const [sr, tr] = await Promise.all([
            env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_filter_senders').first(),
            env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_filter_topics').first(),
          ]);
          return json({ emails, senders: sr?.value||'', topics: tr?.value||'', count: emails.length });
        }
        // Disconnect
        if (seg[2] === 'disconnect' && method === 'DELETE') {
          await Promise.all([
            env.DB.prepare('DELETE FROM settings WHERE key=?').bind('gmail_refresh_token').run(),
            env.DB.prepare('DELETE FROM settings WHERE key=?').bind('gmail_access_token').run(),
            env.DB.prepare('DELETE FROM settings WHERE key=?').bind('gmail_token_expires').run(),
          ]);
          return json({ ok: true });
        }
        // Gmail filter settings
        if (seg[2] === 'settings') {
          if (method === 'GET') {
            const [sr, tr] = await Promise.all([
              env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_filter_senders').first(),
              env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('gmail_filter_topics').first(),
            ]);
            return json({ senders: sr?.value || '', topics: tr?.value || '' });
          }
          if (method === 'PUT') {
            const { senders, topics } = await request.json();
            await Promise.all([
              env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('gmail_filter_senders', senders || '').run(),
              env.DB.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').bind('gmail_filter_topics',  topics  || '').run(),
            ]);
            return json({ ok: true });
          }
        }
      }

      return json({ error: 'Not found' }, 404);

    } catch (e) {
      return json({ error: e.message }, 500);
    }
}
