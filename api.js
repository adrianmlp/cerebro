// ── Cerebro shared API helper ──
const WORKER_URL = document.querySelector('meta[name="worker-url"]')?.content || '';
const TOKEN_KEY  = 'cerebro_token';

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function getAuthHeader() { const t = getToken(); return t ? `Bearer ${t}` : null; }

async function acquireToken(msg = 'Cerebro password:') {
  const pass = prompt(msg);
  if (!pass) throw new Error('No password provided');
  const res = await fetch(WORKER_URL + '/api/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pass }),
  });
  if (!res.ok) return acquireToken('Wrong password. Try again:');
  const { token } = await res.json();
  localStorage.setItem(TOKEN_KEY, token);
}

export async function apiFetch(path, opts = {}) {
  if (!getToken()) await acquireToken();

  const res = await fetch(WORKER_URL + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
      ...(opts.headers || {}),
    },
  });

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    await acquireToken('Session expired. Enter password:');
    return apiFetch(path, opts);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// ── Toast ──
export function toast(msg, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast${type ? ' ' + type : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3100);
}

// ── Date helpers ──
export function localDateStr(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

export function localTimeStr(date = new Date()) {
  return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
}

export function formatDate(str) {
  if (!str) return '';
  const [y, m, d] = str.split('-');
  return new Date(y, m-1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function isToday(isoStr) {
  if (!isoStr) return false;
  const today = localDateStr();
  return isoStr.startsWith(today);
}

export function isPast(isoStr) {
  if (!isoStr) return false;
  return localDateStr() > isoStr.split('T')[0];
}

// ── Priority helpers ──
export const PRIORITY_ORDER = { URGENT: 0, HIGH: 1, NORMAL: 2, BACKLOG: 3 };
export const PRIORITY_LABELS = { URGENT: 'Urgent', HIGH: 'High', NORMAL: 'Normal', BACKLOG: 'Backlog' };
export const PRIORITY_CLASSES = { URGENT: 'badge-urgent', HIGH: 'badge-high', NORMAL: 'badge-normal', BACKLOG: 'badge-backlog' };

export function priorityBadge(p) {
  return `<span class="badge ${PRIORITY_CLASSES[p] || 'badge-normal'}">${PRIORITY_LABELS[p] || p}</span>`;
}

// ── Event colors ──
export const EVENT_COLORS = ['#6366F1','#A78BFA','#EC4899','#EF4444','#F97316','#EAB308','#22C55E','#06B6D4'];
