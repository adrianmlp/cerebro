import { apiFetch, toast, isPast, priorityBadge, PRIORITY_ORDER } from './api.js';
import { initNav } from './nav.js';

initNav('tasks');

let allTasks = [];
let workTasks = [];
let filterPriority = '';
let filterSource = '';
let showCompleted = true;
let searchQuery = '';
let editId = null;

// ── Modal ──
function openModal(task = null) {
  editId = task?.id || null;
  document.getElementById('modal-title').textContent = task ? 'Edit Task' : 'Add Task';
  document.getElementById('task-title').value = task?.title || '';
  document.getElementById('task-desc').value = task?.description || '';
  document.getElementById('task-priority').value = task?.priority || 'NORMAL';
  document.getElementById('task-due').value = task?.due_date || '';
  document.getElementById('save-btn').textContent = task ? 'Save Changes' : 'Add Task';
  document.getElementById('task-modal').classList.add('open');
  setTimeout(() => document.getElementById('task-title').focus(), 50);
}

window.closeModal = function() {
  document.getElementById('task-modal').classList.remove('open');
  editId = null;
};

document.getElementById('task-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) window.closeModal();
});

// ── Save task ──
document.getElementById('save-btn').addEventListener('click', async () => {
  const title = document.getElementById('task-title').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }

  const payload = {
    title,
    description: document.getElementById('task-desc').value,
    priority: document.getElementById('task-priority').value,
    dueDate: document.getElementById('task-due').value || null,
  };

  try {
    if (editId) {
      await apiFetch(`/api/tasks/${editId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast('Task updated', 'success');
    } else {
      await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      toast('Task added', 'success');
    }
    window.closeModal();
    loadTasks();
  } catch (e) { toast(e.message, 'error'); }
});

// ── Work task actions (local D1 only) ──
window.toggleWorkTask = async function(id, completed) {
  try {
    await apiFetch(`/api/work/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ completed }) });
    const t = workTasks.find(t => t.id === id);
    if (t) t.completed = completed;
    renderTasks();
    updateStats();
  } catch (e) { toast(e.message, 'error'); }
};

window.deleteWorkTask = async function(id) {
  if (!confirm('Remove this work task from Cerebro?')) return;
  try {
    await apiFetch(`/api/work/tasks/${id}`, { method: 'DELETE' });
    workTasks = workTasks.filter(t => t.id !== id);
    renderTasks();
    updateStats();
    toast('Work task removed', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

// ── Toggle completed ──
window.toggleTask = async function(id, completed) {
  try {
    await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ completed }) });
    const t = allTasks.find(t => t.id === id);
    if (t) t.completed = completed;
    renderTasks();
    updateStats();
  } catch (e) { toast(e.message, 'error'); }
};

// ── Edit ──
window.editTask = function(id) {
  const t = allTasks.find(t => t.id === id);
  if (t) openModal(t);
};

// ── Delete ──
window.deleteTask = async function(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' });
    allTasks = allTasks.filter(t => t.id !== id);
    renderTasks();
    updateStats();
    toast('Task deleted', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

// ── Load & render ──
async function loadTasks() {
  try {
    const [personalRes, workRes] = await Promise.allSettled([
      apiFetch('/api/tasks?sort=priority'),
      apiFetch('/api/work/tasks'),
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : { tasks: [] }));
    allTasks  = (personalRes.tasks || []).map(t => ({ ...t, source: 'personal' }));
    workTasks = (workRes.tasks     || []).map(t => ({ ...t, source: 'work' }));
    renderTasks();
    updateStats();
  } catch (e) { toast(e.message, 'error'); }
}

function updateStats() {
  const total  = allTasks.length;
  const done   = allTasks.filter(t => t.completed).length;
  const pct    = total ? Math.round(done / total * 100) : 0;
  const wCount = workTasks.filter(t => !t.completed).length;
  document.getElementById('task-count').textContent = `${total} personal · ${wCount} work`;
  document.getElementById('completed-count').textContent = `${done} completed`;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-pct').textContent = pct + '%';
}

function getFiltered() {
  return [...allTasks, ...workTasks]
    .filter(t => {
      if (!showCompleted && t.completed) return false;
      if (filterSource && t.source !== filterSource) return false;
      if (filterPriority && t.priority !== filterPriority) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!t.title.toLowerCase().includes(q) && !t.description?.toLowerCase().includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      return (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
    });
}

function renderTasks() {
  const tasks = getFiltered();
  const body = document.getElementById('task-list-body');

  if (!tasks.length) {
    body.innerHTML = `<div class="empty-state"><div class="empty-icon">☑</div><div class="empty-text">No tasks found</div><div class="empty-sub">Add a task to get started</div></div>`;
    return;
  }

  body.innerHTML = tasks.map(t => {
    const isWork = t.source === 'work';
    return `
    <div class="task-item${t.completed ? ' completed' : ''}${isWork ? ' task-work' : ''}">
      <input type="checkbox" class="task-checkbox" ${t.completed ? 'checked' : ''}
        onchange="${isWork ? `toggleWorkTask('${t.id}', this.checked)` : `toggleTask('${t.id}', this.checked)`}" />
      <div class="task-body">
        <div class="task-title">${t.title}${isWork ? ' <span class="task-source-badge">work</span>' : ''}</div>
        ${t.description ? `<div class="task-desc">${t.description}</div>` : ''}
        <div class="task-meta">
          ${priorityBadge(t.priority)}
          ${t.due_date ? `<span class="task-due${isPast(t.due_date) && !t.completed ? ' overdue' : ''}">📅 ${t.due_date}</span>` : ''}
        </div>
      </div>
      <div class="task-actions">
        ${isWork
          ? `<button class="btn-icon danger" onclick="deleteWorkTask('${t.id}')" title="Remove">🗑</button>`
          : `<button class="btn-icon" onclick="editTask('${t.id}')" title="Edit">✏️</button>
             <button class="btn-icon danger" onclick="deleteTask('${t.id}')" title="Delete">🗑</button>`}
      </div>
    </div>`;
  }).join('');
}

// ── Controls ──
document.getElementById('add-task-btn').addEventListener('click', () => openModal());

document.getElementById('search-input').addEventListener('input', e => {
  searchQuery = e.target.value;
  renderTasks();
});

let hideCompleted = false;
document.getElementById('toggle-completed-btn').addEventListener('click', function() {
  hideCompleted = !hideCompleted;
  showCompleted = !hideCompleted;
  this.textContent = hideCompleted ? 'Show Completed' : 'Hide Completed';
  renderTasks();
});

document.getElementById('priority-filters').addEventListener('click', e => {
  const btn = e.target.closest('[data-priority]');
  if (!btn) return;
  filterPriority = btn.dataset.priority;
  document.querySelectorAll('[data-priority]').forEach(b => b.classList.toggle('active', b === btn));
  renderTasks();
});

document.getElementById('source-filters').addEventListener('click', e => {
  const btn = e.target.closest('[data-source]');
  if (!btn) return;
  filterSource = btn.dataset.source;
  document.querySelectorAll('[data-source]').forEach(b => b.classList.toggle('active', b === btn));
  renderTasks();
});

// ── Keyboard shortcut ──
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openModal(); }
});

loadTasks();
