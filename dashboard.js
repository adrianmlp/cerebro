import { apiFetch, toast, localDateStr, formatTime, priorityBadge, isPast, PRIORITY_CLASSES } from './api.js';
import { initNav } from './nav.js';

initNav('dashboard');

// ── Helpers ──
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
window.closeModal = closeModal;

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

// Close modal on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
});

// ── Brief action buttons (delegated — rendered dynamically) ──
document.addEventListener('click', e => {
  if (e.target.closest('#brief-add-task-btn')) { openModal('task-modal'); return; }
  const emailBtn = e.target.closest('.brief-email-action[data-action]');
  if (emailBtn) {
    const action  = emailBtn.dataset.action;
    const subject = emailBtn.dataset.subject || '';
    const snippet = emailBtn.dataset.snippet || '';
    if (action === 'task') {
      document.getElementById('task-title').value    = subject;
      document.getElementById('task-priority').value = 'NORMAL';
      document.getElementById('task-due').value      = '';
      openModal('task-modal');
    } else if (action === 'event') {
      document.getElementById('event-title').value = subject;
      document.getElementById('event-date').value  = localDateStr();
      document.getElementById('event-start').value = '';
      openModal('event-modal');
    } else if (action === 'note') {
      document.getElementById('note-title').value   = subject;
      document.getElementById('note-content').value = snippet;
      openModal('note-modal');
    }
  }
});

document.getElementById('task-save-btn').addEventListener('click', async () => {
  const title = document.getElementById('task-title').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }
  try {
    await apiFetch('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title,
        priority: document.getElementById('task-priority').value,
        dueDate: document.getElementById('task-due').value || null,
      }),
    });
    closeModal('task-modal');
    document.getElementById('task-title').value = '';
    toast('Task added', 'success');
    loadBrief();
  } catch (e) { toast(e.message, 'error'); }
});


// ── Note quick-add (also used from email action) ──
document.getElementById('note-save-btn').addEventListener('click', async () => {
  const title   = document.getElementById('note-title').value.trim();
  const content = document.getElementById('note-content').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }
  try {
    await apiFetch('/api/notes', { method: 'POST', body: JSON.stringify({ title, content }) });
    closeModal('note-modal');
    document.getElementById('note-title').value   = '';
    document.getElementById('note-content').value = '';
    toast('Note added', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('event-save-btn').addEventListener('click', async () => {
  const title = document.getElementById('event-title').value.trim();
  const date  = document.getElementById('event-date').value;
  const time  = document.getElementById('event-start').value;
  if (!title || !date) { toast('Title and date are required', 'error'); return; }
  try {
    const startTime = time ? `${date}T${time}:00` : `${date}T09:00:00`;
    await apiFetch('/api/events', { method: 'POST', body: JSON.stringify({ title, startTime }) });
    closeModal('event-modal');
    document.getElementById('event-title').value = '';
    toast('Event added', 'success');
    loadSchedule();
  } catch (e) { toast(e.message, 'error'); }
});

// ── AI Chat ──
const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');
const chatSendBtn  = document.getElementById('chat-send-btn');

function appendMsg(role, text) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `
    <div class="chat-avatar">${role === 'user' ? 'Me' : '✦'}</div>
    <div class="chat-bubble">${text.replace(/\n/g, '<br>')}</div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function isTranscript(text) {
  // Only treat as transcript if it's long AND looks like meeting notes / speaker turns
  if (text.length < 300) return false;
  return /transcript|action item|discussed|agreed to|follow.?up|next steps/i.test(text)
    || /\b[A-Z][a-z]+\s*:/m.test(text);  // speaker attribution like "John:"
}

async function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;

  chatInput.value = '';
  chatInput.style.height = 'auto';
  appendMsg('user', msg);

  const mode = isTranscript(msg) ? 'transcript' : 'chat';
  const loadingDiv = appendMsg('assistant', '<span class="spinner"></span> Thinking…');
  chatSendBtn.disabled = true;

  try {
    const data = await apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: msg, mode,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzLabel: new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '',
      }),
    });

    loadingDiv.remove();

    if (data.type === 'transcript_analysis') {
      appendMsg('assistant', `<strong>Analysis complete!</strong><br>${data.summary}`);
      renderTranscriptCards(data);
    } else {
      appendMsg('assistant', data.message);
      // If the AI performed a write action, refresh the relevant card
      if (data.action?.type === 'create_task')  loadTasks();
      if (data.action?.type === 'create_event') loadSchedule();
    }
  } catch (e) {
    loadingDiv.remove();
    appendMsg('assistant', `Sorry, something went wrong: ${e.message}`);
  } finally {
    chatSendBtn.disabled = false;
  }
}

function renderTranscriptCards(data) {
  const area = document.getElementById('transcript-area');
  const summaryEl = document.getElementById('transcript-summary');
  const cardsEl = document.getElementById('transcript-cards');
  area.style.display = 'block';

  const kp = data.keyPoints?.map(p => `• ${p}`).join('<br>') || '';
  summaryEl.innerHTML = `<strong>Key Points:</strong><br>${kp}`;

  const cards = [
    ...(data.tasks || []).map(t => ({ kind: 'task', ...t })),
    ...(data.events || []).map(e => ({ kind: 'event', ...e })),
  ];

  cardsEl.innerHTML = cards.map((item, i) => `
    <div class="transcript-card" id="tc-${i}">
      <div class="transcript-card-body">
        <div class="transcript-card-label">${item.kind === 'task' ? '☑ Task' : '📅 Event'}</div>
        <div style="font-weight:500">${item.title}</div>
        ${item.description ? `<div style="font-size:12px;color:var(--text-3)">${item.description}</div>` : ''}
      </div>
      <button class="btn btn-primary btn-sm" onclick="confirmTranscriptItem(${i}, ${JSON.stringify(item).replace(/"/g, '&quot;')})">Add</button>
      <button class="btn-icon danger" onclick="document.getElementById('tc-${i}').remove()">✕</button>
    </div>
  `).join('');
}

window.confirmTranscriptItem = async function(i, item) {
  try {
    if (item.kind === 'task') {
      await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify({ title: item.title, description: item.description, priority: item.priority || 'NORMAL' }) });
      toast('Task added', 'success');
      loadTasks();
    } else {
      const today = localDateStr();
      await apiFetch('/api/events', { method: 'POST', body: JSON.stringify({ title: item.title, description: item.description, startTime: item.startTime || `${today}T09:00:00` }) });
      toast('Event added', 'success');
      loadSchedule();
    }
    document.getElementById(`tc-${i}`)?.remove();
  } catch (e) { toast(e.message, 'error'); }
};

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
  setTimeout(() => { chatInput.style.height = 'auto'; chatInput.style.height = chatInput.scrollHeight + 'px'; }, 0);
});

// ── Chat expand / collapse ──
const chatBarBody       = document.getElementById('chat-bar-body');
const chatContent       = document.getElementById('chat-content');
const chatFullscreen    = document.getElementById('chat-fullscreen-modal');
const chatFullscreenBody = document.getElementById('chat-fullscreen-body');

function expandChat() {
  chatFullscreenBody.appendChild(chatContent);
  chatFullscreen.classList.add('open');
  chatMessages.scrollTop = chatMessages.scrollHeight;
  chatInput.focus();
}

function collapseChat() {
  chatBarBody.appendChild(chatContent);
  chatFullscreen.classList.remove('open');
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Chat bar header toggles collapsed state ──
document.getElementById('chat-bar-header').addEventListener('click', e => {
  if (e.target.closest('button')) return;
  document.getElementById('chat-bar').classList.toggle('collapsed');
});

document.getElementById('chat-expand-btn').addEventListener('click', expandChat);
document.getElementById('chat-collapse-btn').addEventListener('click', collapseChat);
chatFullscreen.addEventListener('click', e => { if (e.target === chatFullscreen) collapseChat(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && chatFullscreen.classList.contains('open')) collapseChat(); });

// ── Daily Brief ──
const PRIORITY_DOT = { URGENT: 'URGENT', HIGH: 'HIGH', NORMAL: 'NORMAL', BACKLOG: 'BACKLOG' };

function briefFmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch { return ''; }
}

function briefFmtChange(val) {
  if (val == null) return '';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

async function loadBrief() {
  const body = document.getElementById('brief-body');
  const subtitle = document.getElementById('brief-subtitle');
  try {
    const data = await apiFetch(`/api/brief?date=${localDateStr()}`);

    // Sections: upcoming tasks (next 7 days)
    const today = localDateStr();
    const tomorrow = localDateStr(new Date(Date.now() + 86400000));
    function fmtDue(d) {
      if (d === today) return 'Today';
      if (d === tomorrow) return 'Tomorrow';
      const [y, m, day] = d.split('-');
      return new Date(y, m-1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    const dueSec = data.dueToday?.length
      ? `<div class="brief-due-list">${data.dueToday.slice(0,7).map(t=>`
          <div class="brief-due-item">
            <div class="brief-due-dot ${PRIORITY_DOT[t.priority]||'NORMAL'}"></div>
            <span class="brief-due-title">${t.title}</span>
            <span class="brief-due-date">${fmtDue(t.due_date)}</span>
          </div>`).join('')}
          ${data.dueToday.length > 7 ? `<div class="brief-empty">+${data.dueToday.length-7} more</div>` : ''}
        </div>`
      : `<div class="brief-empty">No tasks due in the next 7 days</div>`;

    // Meetings
    const meetSec = data.meetings?.length
      ? `<div class="brief-meeting-list">${data.meetings.slice(0,5).map(e=>`
          <div class="brief-meeting-item">
            <span class="brief-meeting-time">${briefFmtTime(e.start_time)}</span>
            <span class="brief-meeting-title">${e.title}</span>
          </div>`).join('')}
          ${data.meetings.length > 5 ? `<div class="brief-empty">+${data.meetings.length-5} more</div>` : ''}
        </div>`
      : `<div class="brief-empty">No meetings today</div>`;

    // Stocks
    const stockSec = data.stocks?.length
      ? `<div class="brief-stocks">${data.stocks.map(s => {
          const up = (s.changePercent || 0) >= 0;
          const stateMap = { REGULAR: ['Open','brief-stock-open'], PRE: ['Pre','brief-stock-pre'], POST: ['After','brief-stock-pre'], CLOSED: ['Closed','brief-stock-closed'] };
          const [stateLabel, stateCls] = stateMap[s.marketState] || ['Closed','brief-stock-closed'];
          return `<a class="brief-stock" href="https://finance.yahoo.com/quote/${s.symbol}" target="_blank" rel="noopener">
            <div class="brief-stock-row1">
              <span class="brief-stock-symbol">${s.symbol}</span>
              <span class="brief-stock-price">$${(s.price||0).toFixed(2)}</span>
            </div>
            <div class="brief-stock-row2">
              <span class="brief-stock-change ${up?'up':'down'}">${briefFmtChange(s.changePercent)}</span>
              <span class="${stateCls}">${stateLabel}</span>
            </div>
          </a>`;
        }).join('')}</div>`
      : data.settings?.tickers
        ? `<div class="brief-empty">Could not load stock data — markets may be unavailable</div>`
        : `<div class="brief-empty">No tickers configured — click ⚙ Settings to add some</div>`;

    // Sports
    const sportSec = data.sports?.length
      ? `<div class="brief-sports">${data.sports.map(g => {
          const hasScore = g.homeScore !== '' && g.awayScore !== '';
          const aScore = hasScore ? parseInt(g.awayScore, 10) : -1;
          const hScore = hasScore ? parseInt(g.homeScore, 10) : -1;
          const isScheduled = g.statusState === 'pre' || (!hasScore && (g.status === 'Scheduled' || g.status === ''));
          const statusStr = isScheduled
            ? briefFmtTime(g.date)
            : (g.status || (hasScore ? 'Final' : briefFmtTime(g.date)));
          const broadcastHtml = (g.broadcasts?.length && isScheduled)
            ? `<span class="brief-score-tv">${g.broadcasts.join(' · ')}</span>`
            : '';
          const inner = `
            <div class="brief-score-matchup">
              <div class="brief-score-row">
                <span class="brief-score-team${hasScore && aScore > hScore ? ' winner' : ''}">${g.away}</span>
                ${hasScore ? `<span class="brief-score-num${aScore > hScore ? ' winner' : ''}">${g.awayScore}</span>` : ''}
              </div>
              <div class="brief-score-row">
                <span class="brief-score-team${hasScore && hScore > aScore ? ' winner' : ''}">${g.home}</span>
                ${hasScore ? `<span class="brief-score-num${hScore > aScore ? ' winner' : ''}">${g.homeScore}</span>` : '<span class="brief-score-vs">vs</span>'}
              </div>
            </div>
            <div class="brief-score-footer">
              <span class="brief-score-status">${statusStr}</span>
              ${broadcastHtml}
              <span class="brief-score-badge">${g.league.toUpperCase()}</span>
            </div>`;
          return g.link
            ? `<a class="brief-score" href="${g.link}" target="_blank" rel="noopener">${inner}</a>`
            : `<div class="brief-score">${inner}</div>`;
        }).join('')}</div>`
      : `<div class="brief-empty">No teams configured — click ⚙ Settings to add some</div>`;

    // Sports news
    const sportsNewsSec = data.sportsNews?.length
      ? `<div class="brief-news">${data.sportsNews.map(n => `
          <div class="brief-news-item">
            <div class="brief-news-bullet">•</div>
            <div class="brief-news-content">
              <a class="brief-news-title" href="${n.link}" target="_blank" rel="noopener">${n.title}</a>
              <div class="brief-news-meta">
                ${n.topic ? `<span class="brief-news-topic">${n.topic}</span>` : ''}
                ${n.source || ''}
              </div>
            </div>
          </div>`).join('')}</div>`
      : '';

    // News
    const newsSec = data.news?.length
      ? `<div class="brief-news">${data.news.map(n => `
          <div class="brief-news-item">
            <div class="brief-news-bullet">•</div>
            <div class="brief-news-content">
              <a class="brief-news-title" href="${n.link}" target="_blank" rel="noopener">${n.title}</a>
              <div class="brief-news-meta">
                ${n.topic ? `<span class="brief-news-topic">${n.topic}</span>` : ''}
                ${n.source || ''}
              </div>
            </div>
          </div>`).join('')}</div>`
      : data.settings?.topics
        ? `<div class="brief-empty">Could not load news — try refreshing</div>`
        : `<div class="brief-empty">No news topics configured — click ⚙ Settings to add some</div>`;

    // Gmail emails
    const gmailSec = data.gmailConnected
      ? (data.gmailEmails?.length
          ? `<div class="brief-emails">${data.gmailEmails.map(e => `
              <div class="brief-email${e.isImportant ? ' important' : ''}">
                <div class="brief-email-meta">
                  <span class="brief-email-from">${e.fromName || e.fromEmail}</span>
                  ${e.isImportant ? '<span class="brief-email-star">★</span>' : ''}
                  <span class="brief-email-date">${e.date ? new Date(e.date).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''}</span>
                </div>
                <div class="brief-email-subject">${e.subject}</div>
                <div class="brief-email-snippet">${e.snippet}</div>
                <div class="brief-email-actions">
                  <button class="brief-email-action" data-action="task"  data-subject="${e.subject.replace(/"/g,'&quot;')}" data-snippet="${e.snippet.replace(/"/g,'&quot;')}">→ Task</button>
                  <button class="brief-email-action" data-action="event" data-subject="${e.subject.replace(/"/g,'&quot;')}" data-snippet="${e.snippet.replace(/"/g,'&quot;')}">→ Event</button>
                  <button class="brief-email-action" data-action="note"  data-subject="${e.subject.replace(/"/g,'&quot;')}" data-snippet="${e.snippet.replace(/"/g,'&quot;')}">→ Note</button>
                  <a class="brief-email-action" href="${e.link}" target="_blank" rel="noopener">Open ↗</a>
                </div>
              </div>`).join('')}</div>`
          : `<div class="brief-empty">No matching unread emails — add filters in <a href="settings.html" style="color:var(--indigo)">Settings</a></div>`)
      : null;

    body.innerHTML = `<div class="brief-grid">
      <div class="brief-top-row">
        <div>
          <div class="brief-section-label">📌 Upcoming Tasks <button class="brief-add-btn" id="brief-add-task-btn">+ Add</button></div>
          ${dueSec}
        </div>
        <a class="brief-section-link brief-section-block" href="calendar.html?view=day&date=${localDateStr()}">
          <div class="brief-section-label">📅 Today's Schedule ↗</div>
          ${meetSec}
        </a>
      </div>
      ${gmailSec ? `<div><div class="brief-section-label">📧 Emails</div>${gmailSec}</div>` : ''}
      <div>
        <div class="brief-section-label">📰 News</div>
        ${newsSec}
      </div>
      <div>
        <div class="brief-section-label">📈 Stocks</div>
        ${stockSec}
      </div>
      <div>
        <div class="brief-section-label">🏆 Scores</div>
        ${sportSec}
        ${sportsNewsSec ? `<div class="brief-section-label" style="margin-top:12px">📰 Sports News</div>${sportsNewsSec}` : ''}
      </div>
    </div>`;

    const now = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    subtitle.textContent = `Updated ${now}`;
  } catch (e) {
    body.innerHTML = `<div class="brief-empty">Failed to load brief: ${e.message}</div>`;
    subtitle.textContent = 'Error';
  }
}


document.getElementById('brief-refresh-btn').addEventListener('click', () => {
  document.getElementById('brief-subtitle').textContent = 'Refreshing…';
  loadBrief();
});

// ── Init ──
loadBrief().catch(e => toast(e.message, 'error'));
