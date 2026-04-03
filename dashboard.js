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

// ── Load Tasks Summary ──
async function loadTasks() {
  const { tasks } = await apiFetch('/api/tasks?completed=false&sort=priority');
  const allTasks = await apiFetch('/api/tasks');
  const total = allTasks.tasks.length;
  const done  = allTasks.tasks.filter(t => t.completed).length;
  const pct   = total ? Math.round(done / total * 100) : 0;

  document.getElementById('todo-subtitle').textContent = `${tasks.length} open · ${done} completed`;
  document.getElementById('todo-progress').style.width = pct + '%';
  document.getElementById('todo-pct').textContent = pct + '%';

  const list = document.getElementById('todo-list');
  const top5 = tasks.slice(0, 5);

  if (!top5.length) {
    list.innerHTML = `<div class="empty-state" style="padding:20px 0"><div class="empty-text">All caught up! 🎉</div></div>`;
    return;
  }

  list.innerHTML = top5.map(t => `
    <div class="task-item" data-id="${t.id}">
      <input type="checkbox" class="task-checkbox" ${t.completed ? 'checked' : ''} onchange="toggleTask('${t.id}', this.checked)" />
      <div class="task-body">
        <div class="task-title">${t.title}</div>
        ${t.due_date ? `<div class="task-meta"><span class="task-due${isPast(t.due_date) && !t.completed ? ' overdue' : ''}">${t.due_date}</span></div>` : ''}
      </div>
      ${priorityBadge(t.priority)}
    </div>
  `).join('');
}

// ── Load Today's Schedule ──
async function loadSchedule() {
  const today = localDateStr();

  const [personalRes, outlookRes] = await Promise.all([
    apiFetch(`/api/events?start=${today}&end=${today}`),
    apiFetch(`/api/outlook/events?start=${today}&end=${today}`).catch(() => ({ events: [] })),
  ]);

  const personal = (personalRes.events || []).map(e => ({ ...e, _source: 'personal' }));
  const work     = (outlookRes.events  || []).map(e => ({ ...e, _source: 'work' }));

  // Merge and sort by start time
  const allEvents = [...personal, ...work].sort((a, b) =>
    (a.start_time || '').localeCompare(b.start_time || '')
  );

  const subtitle = document.getElementById('schedule-subtitle');
  const list = document.getElementById('schedule-list');

  const d = new Date();
  subtitle.textContent = `${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · ${allEvents.length} event${allEvents.length !== 1 ? 's' : ''}`;

  if (!allEvents.length) {
    list.innerHTML = `<div class="empty-state" style="padding:20px 0"><div class="empty-text">No events today</div></div>`;
    return;
  }

  list.innerHTML = allEvents.map(e => {
    const isWork = e._source === 'work';
    const borderColor = isWork ? '#38BDF8' : (e.color || 'var(--violet)');
    const badge = isWork
      ? `<span style="font-size:10px;color:#38BDF8;opacity:0.8;margin-left:auto;flex-shrink:0">🏢</span>`
      : (e.recurrence_type !== 'NONE' ? '<span style="font-size:11px;color:var(--text-3);margin-left:auto">↻</span>' : '');
    return `
      <div class="event-chip" style="border-color:${borderColor}">
        <div class="event-chip-time">${formatTime(e.start_time)}</div>
        <div class="event-chip-title">${e.title}</div>
        ${badge}
      </div>
    `;
  }).join('');
}

// ── Toggle task done ──
window.toggleTask = async function(id, completed) {
  try {
    await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ completed }) });
    loadTasks();
  } catch (e) { toast(e.message, 'error'); }
};

// ── Quick Add Task ──
document.getElementById('todo-add-btn').addEventListener('click', () => openModal('task-modal'));

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
    loadTasks();
  } catch (e) { toast(e.message, 'error'); }
});

// ── Quick Add Event ──
document.getElementById('schedule-add-btn').addEventListener('click', () => {
  document.getElementById('event-date').value = localDateStr();
  openModal('event-modal');
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
  return text.length > 200 || /transcript|meeting|discussed|agenda|action item/i.test(text);
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
      body: JSON.stringify({ message: msg, mode }),
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
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendChat();
  setTimeout(() => { chatInput.style.height = 'auto'; chatInput.style.height = chatInput.scrollHeight + 'px'; }, 0);
});

// ── Chat expand / collapse ──
const chatCard          = document.getElementById('chat-card');
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
  chatCard.appendChild(chatContent);
  chatFullscreen.classList.remove('open');
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

document.getElementById('chat-expand-btn').addEventListener('click', expandChat);
document.getElementById('chat-collapse-btn').addEventListener('click', collapseChat);
chatFullscreen.addEventListener('click', e => { if (e.target === chatFullscreen) collapseChat(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && chatFullscreen.classList.contains('open')) collapseChat(); });

// ── Init ──
loadTasks().catch(e => toast(e.message, 'error'));
loadSchedule().catch(e => toast(e.message, 'error'));
