// --- Config ---
// Worker URL is set via meta tag in index.html
const WORKER_URL = document.querySelector('meta[name="worker-url"]')?.content || '';

// --- State ---
let currentView = 'inbox';
let taskFilter = 'open';
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1;

// --- Auth helpers ---
// Basic auth credentials are stored in sessionStorage after first use
function getAuthHeader() {
  const creds = sessionStorage.getItem('cerebro_creds');
  if (!creds) return null;
  return 'Basic ' + btoa('cerebro:' + creds);
}

async function api(path, opts = {}) {
  const authHeader = getAuthHeader();
  if (!authHeader && path.startsWith('/api/')) {
    const pass = prompt('Cerebro password:');
    if (!pass) throw new Error('No password');
    sessionStorage.setItem('cerebro_creds', pass);
  }

  const res = await fetch(WORKER_URL + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
      ...(opts.headers || {}),
    },
  });

  if (res.status === 401) {
    sessionStorage.removeItem('cerebro_creds');
    const pass = prompt('Wrong password. Try again:');
    if (!pass) throw new Error('No password');
    sessionStorage.setItem('cerebro_creds', pass);
    return api(path, opts); // retry once
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// --- Toast ---
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type ? `show ${type}` : 'show';
  setTimeout(() => { el.className = ''; }, 3000);
}

// --- Entry helpers ---
const TYPE_ICON = { task: '☑', note: '📝', bookmark: '🔖', event: '📅' };
const TYPE_CLASS = { task: 'icon-task', note: 'icon-note', bookmark: 'icon-bookmark', event: 'icon-event' };

function dueBadge(dateStr) {
  if (!dateStr) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr + 'T00:00:00');
  const diff = Math.round((due - today) / 86400000);
  if (diff < 0) return `<span class="due-badge due-overdue">Overdue: ${dateStr}</span>`;
  if (diff === 0) return `<span class="due-badge due-today">Today</span>`;
  if (diff <= 3) return `<span class="due-badge due-soon">${dateStr}</span>`;
  return `<span class="due-badge due-future">${dateStr}</span>`;
}

function renderTags(tagStr) {
  if (!tagStr) return '';
  return tagStr.split(',').filter(Boolean).map(t => `<span class="tag">${t.trim()}</span>`).join('');
}

function entryCard(e) {
  const card = document.createElement('div');
  card.className = `entry-card${e.status === 'done' ? ' done' : ''}`;
  card.dataset.id = e.id;

  const urlSnippet = e.url
    ? `<a class="entry-url" href="${e.url}" target="_blank" rel="noopener">${e.url.replace(/^https?:\/\//, '').split('/')[0]}</a>`
    : '';

  card.innerHTML = `
    <div class="entry-icon ${TYPE_CLASS[e.type] || 'icon-note'}">${TYPE_ICON[e.type] || '•'}</div>
    <div class="entry-body">
      <div class="entry-title">${e.title}</div>
      <div class="entry-meta">
        ${dueBadge(e.due_date)}
        ${urlSnippet}
        ${renderTags(e.tags)}
        ${e.ai_summary && !e.url ? `<span>${e.ai_summary}</span>` : ''}
      </div>
    </div>
    <div class="entry-actions">
      ${e.type === 'task' ? `<button class="action-btn done-btn" title="${e.status === 'done' ? 'Reopen' : 'Mark done'}" onclick="toggleDone(${e.id})">${e.status === 'done' ? '↩' : '✓'}</button>` : ''}
      <button class="action-btn delete-btn" title="Delete" onclick="deleteEntry(${e.id})">✕</button>
    </div>
  `;

  return card;
}

function renderEntries(entries, container) {
  container.innerHTML = '';
  if (!entries.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🧠</div><div class="empty-text">Nothing here yet</div></div>`;
    return;
  }
  entries.forEach(e => container.appendChild(entryCard(e)));
}

// --- Capture ---
async function capture() {
  const input = document.getElementById('capture-input');
  const btn = document.getElementById('capture-btn');
  const raw = input.value.trim();
  if (!raw) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Saving…';

  try {
    const { entry } = await api('/api/capture', {
      method: 'POST',
      body: JSON.stringify({ raw }),
    });
    input.value = '';
    input.style.height = 'auto';
    toast('Saved!', 'success');
    loadView(currentView); // refresh current view
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Capture';
  }
}

// --- Toggle done ---
async function toggleDone(id) {
  const card = document.querySelector(`.entry-card[data-id="${id}"]`);
  const isDone = card?.classList.contains('done');
  try {
    await api(`/api/entries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: isDone ? 'open' : 'done' }),
    });
    loadView(currentView);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// --- Delete ---
async function deleteEntry(id) {
  if (!confirm('Delete this entry?')) return;
  try {
    await api(`/api/entries/${id}`, { method: 'DELETE' });
    toast('Deleted', 'success');
    loadView(currentView);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// --- Views ---
async function loadInbox() {
  const container = document.getElementById('inbox-list');
  try {
    const { entries } = await api('/api/entries');
    renderEntries(entries.reverse(), container); // newest first
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function loadTasks() {
  const container = document.getElementById('tasks-list');
  try {
    const { entries } = await api(`/api/entries?type=task&status=${taskFilter}`);
    renderEntries(entries, container);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function loadNotes() {
  const container = document.getElementById('notes-list');
  try {
    const { entries } = await api('/api/entries?type=note');
    renderEntries(entries.reverse(), container);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function loadBookmarks() {
  const container = document.getElementById('bookmarks-list');
  try {
    const { entries } = await api('/api/entries?type=bookmark');
    renderEntries(entries.reverse(), container);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// --- Calendar ---
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

async function loadCalendar() {
  document.getElementById('cal-month-label').textContent = `${MONTHS[calMonth - 1]} ${calYear}`;

  let entries = [];
  try {
    const res = await api(`/api/calendar?year=${calYear}&month=${calMonth}`);
    entries = res.entries;
  } catch (e) {
    toast(e.message, 'error');
  }

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  // Day headers
  DAYS.forEach(d => {
    const h = document.createElement('div');
    h.className = 'cal-day-header';
    h.textContent = d;
    grid.appendChild(h);
  });

  const firstDay = new Date(calYear, calMonth - 1, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const todayStr = new Date().toISOString().split('T')[0];

  // Empty cells before 1st
  for (let i = 0; i < firstDay; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell empty';
    grid.appendChild(cell);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calYear}-${String(calMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = `cal-cell${dateStr === todayStr ? ' today' : ''}`;

    const dateLabel = document.createElement('div');
    dateLabel.className = 'cal-date';
    dateLabel.textContent = day;
    cell.appendChild(dateLabel);

    entries.filter(e => e.due_date === dateStr).forEach(e => {
      const chip = document.createElement('div');
      chip.className = `cal-entry ${e.type}`;
      chip.title = e.title;
      chip.textContent = e.title;
      cell.appendChild(chip);
    });

    grid.appendChild(cell);
  }
}

// --- Navigation ---
function setView(name) {
  currentView = name;

  // Update nav buttons (desktop + mobile)
  document.querySelectorAll('#desktop-nav button, #mobile-nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name);
  });

  // Show/hide sections
  const sections = ['inbox-section', 'tasks-section', 'notes-section', 'bookmarks-section', 'calendar-section'];
  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  const target = document.getElementById(`${name}-section`);
  if (target) target.style.display = 'block';

  loadView(name);
}

function loadView(name) {
  if (name === 'inbox') loadInbox();
  else if (name === 'tasks') loadTasks();
  else if (name === 'notes') loadNotes();
  else if (name === 'bookmarks') loadBookmarks();
  else if (name === 'calendar') loadCalendar();
}

// --- Search ---
async function runSearch(q) {
  const panel = document.getElementById('search-panel');
  const answerEl = document.getElementById('search-answer');
  const refsEl = document.getElementById('search-refs');

  if (!q.trim()) {
    panel.classList.remove('visible');
    return;
  }

  answerEl.innerHTML = '<span class="spinner"></span>Thinking…';
  refsEl.innerHTML = '';
  panel.classList.add('visible');

  try {
    const { answer, entries } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    answerEl.textContent = answer;
    if (entries.length) {
      const label = document.createElement('div');
      label.className = 'search-ref-label';
      label.textContent = 'Referenced entries';
      refsEl.appendChild(label);
      entries.forEach(e => refsEl.appendChild(entryCard(e)));
    }
  } catch (e) {
    answerEl.textContent = `Error: ${e.message}`;
  }
}

function closeSearch() {
  document.getElementById('search-panel').classList.remove('visible');
  document.getElementById('search-input').value = '';
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  // Capture
  const input = document.getElementById('capture-input');
  input.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') capture();
    // Auto-grow
    setTimeout(() => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; }, 0);
  });
  document.getElementById('capture-btn').addEventListener('click', capture);

  // Nav (desktop + mobile)
  document.querySelectorAll('#desktop-nav button, #mobile-nav button').forEach(b => {
    b.addEventListener('click', () => setView(b.dataset.view));
  });

  // Mobile search
  document.getElementById('mobile-search-btn')?.addEventListener('click', () => {
    const overlay = document.getElementById('mobile-search-overlay');
    overlay.classList.add('open');
    document.getElementById('mobile-search-input').focus();
  });

  document.getElementById('mobile-search-close')?.addEventListener('click', () => {
    document.getElementById('mobile-search-overlay').classList.remove('open');
    document.getElementById('mobile-search-input').value = '';
    document.getElementById('search-panel').classList.remove('visible');
  });

  let mobileSearchTimeout;
  document.getElementById('mobile-search-input')?.addEventListener('input', e => {
    clearTimeout(mobileSearchTimeout);
    mobileSearchTimeout = setTimeout(() => runSearch(e.target.value), 600);
  });

  document.getElementById('mobile-search-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') runSearch(e.target.value);
    if (e.key === 'Escape') {
      document.getElementById('mobile-search-overlay').classList.remove('open');
      document.getElementById('search-panel').classList.remove('visible');
    }
  });

  // Task filter buttons
  document.querySelectorAll('.filter-btn[data-filter]').forEach(b => {
    b.addEventListener('click', () => {
      taskFilter = b.dataset.filter;
      document.querySelectorAll('.filter-btn[data-filter]').forEach(x => x.classList.toggle('active', x === b));
      loadTasks();
    });
  });

  // Calendar nav
  document.getElementById('cal-prev')?.addEventListener('click', () => {
    calMonth--;
    if (calMonth < 1) { calMonth = 12; calYear--; }
    loadCalendar();
  });

  document.getElementById('cal-next')?.addEventListener('click', () => {
    calMonth++;
    if (calMonth > 12) { calMonth = 1; calYear++; }
    loadCalendar();
  });

  // Search
  let searchTimeout;
  document.getElementById('search-input')?.addEventListener('input', e => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => runSearch(e.target.value), 600);
  });

  document.getElementById('search-input')?.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSearch();
    if (e.key === 'Enter') runSearch(e.target.value);
  });

  // Start on inbox
  setView('inbox');
});

// Expose globals needed for inline onclick handlers
window.toggleDone = toggleDone;
window.deleteEntry = deleteEntry;
window.closeSearch = closeSearch;
