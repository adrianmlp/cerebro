import { apiFetch, toast } from './api.js';
import { initNav } from './nav.js';

initNav('saves');

let allSaves = [];
let filterType = '';
let filterTag = '';
let showUnreadOnly = false;
let searchQuery = '';
let editId = null;

// ── Modal ──
function openModal(save = null) {
  editId = save?.id || null;
  document.getElementById('modal-title').textContent = save ? 'Edit Save' : 'Save URL';
  document.getElementById('save-url').value = save?.url || '';
  document.getElementById('save-url').disabled = !!save;
  document.getElementById('save-title').value = save?.title || '';
  document.getElementById('save-tags').value = save?.tags || '';
  document.getElementById('modal-save-btn').textContent = save ? 'Save Changes' : 'Save';
  document.getElementById('save-modal').classList.add('open');
  setTimeout(() => document.getElementById(save ? 'save-title' : 'save-url').focus(), 50);
}

window.closeModal = function() {
  document.getElementById('save-modal').classList.remove('open');
  editId = null;
};

document.getElementById('save-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) window.closeModal();
});

document.getElementById('add-save-btn').addEventListener('click', () => openModal());

// ── Submit save ──
document.getElementById('modal-save-btn').addEventListener('click', async () => {
  const url   = document.getElementById('save-url').value.trim();
  const title = document.getElementById('save-title').value.trim();
  const tags  = document.getElementById('save-tags').value.trim();

  if (!editId && !url) { toast('URL is required', 'error'); return; }

  const btn = document.getElementById('modal-save-btn');
  btn.disabled = true;
  btn.textContent = editId ? 'Saving…' : 'Fetching…';

  try {
    if (editId) {
      await apiFetch(`/api/saves/${editId}`, { method: 'PATCH', body: JSON.stringify({ title, tags }) });
      toast('Updated');
    } else {
      await apiFetch('/api/saves', { method: 'POST', body: JSON.stringify({ url, title, tags }) });
      toast('Saved');
    }
    window.closeModal();
    await loadSaves();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = editId ? 'Save Changes' : 'Save';
  }
});

// ── Filters ──
document.getElementById('search-input').addEventListener('input', e => {
  searchQuery = e.target.value.toLowerCase();
  render();
});

document.getElementById('type-filters').addEventListener('click', e => {
  const pill = e.target.closest('[data-type]');
  if (!pill) return;
  filterType = pill.dataset.type;
  document.querySelectorAll('#type-filters .filter-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  render();
});

document.getElementById('toggle-unread-btn').addEventListener('click', function() {
  showUnreadOnly = !showUnreadOnly;
  this.classList.toggle('active', showUnreadOnly);
  this.textContent = showUnreadOnly ? 'All Items' : 'Unread Only';
  render();
});

// ── Load ──
async function loadSaves() {
  try {
    allSaves = await apiFetch('/api/saves');
    renderTagPills();
    render();
  } catch (e) {
    document.getElementById('saves-grid').innerHTML =
      `<div class="empty-state"><p style="color:var(--text-3)">${e.message}</p></div>`;
  }
}

function renderTagPills() {
  const allTags = new Set();
  allSaves.forEach(s => (s.tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => allTags.add(t)));
  const container = document.getElementById('tag-pills');
  if (!allTags.size) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <button class="filter-pill ${!filterTag ? 'active' : ''}" data-tag="">All Tags</button>
    ${[...allTags].sort().map(t =>
      `<button class="filter-pill ${filterTag === t ? 'active' : ''}" data-tag="${t}">${t}</button>`
    ).join('')}
  `;
  container.querySelectorAll('[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => {
      filterTag = btn.dataset.tag;
      container.querySelectorAll('[data-tag]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      render();
    });
  });
}

function render() {
  const filtered = allSaves.filter(s => {
    if (filterType && s.type !== filterType) return false;
    if (showUnreadOnly && s.is_read) return false;
    if (filterTag) {
      const tags = (s.tags || '').split(',').map(t => t.trim());
      if (!tags.includes(filterTag)) return false;
    }
    if (searchQuery) {
      const hay = `${s.title} ${s.url} ${s.tags}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });

  const grid = document.getElementById('saves-grid');
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state"><p style="color:var(--text-3)">${allSaves.length ? 'No matches' : 'No saves yet — click "+ Save URL" to add one'}</p></div>`;
    return;
  }

  grid.innerHTML = `<div class="saves-grid">${filtered.map(s => saveCard(s)).join('')}</div>`;

  grid.querySelectorAll('[data-id]').forEach(card => {
    const id = card.dataset.id;
    const save = allSaves.find(s => s.id === id);

    card.querySelector('.save-open-btn').addEventListener('click', async () => {
      window.open(save.url, '_blank');
      if (!save.is_read) {
        save.is_read = 1;
        card.classList.add('is-read');
        await apiFetch(`/api/saves/${id}`, { method: 'PATCH', body: JSON.stringify({ is_read: 1 }) }).catch(() => {});
      }
    });

    card.querySelector('.save-edit-btn').addEventListener('click', e => {
      e.stopPropagation();
      openModal(save);
    });

    card.querySelector('.save-delete-btn').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Delete this save?')) return;
      await apiFetch(`/api/saves/${id}`, { method: 'DELETE' });
      toast('Deleted');
      await loadSaves();
    });

    const readBtn = card.querySelector('.save-read-btn');
    if (readBtn) {
      readBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const newVal = save.is_read ? 0 : 1;
        save.is_read = newVal;
        await apiFetch(`/api/saves/${id}`, { method: 'PATCH', body: JSON.stringify({ is_read: newVal }) });
        render();
      });
    }
  });
}

function saveCard(s) {
  const domain = (() => { try { return new URL(s.url).hostname.replace('www.', ''); } catch { return ''; } })();
  const tags = (s.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const typeIcon = s.type === 'video' ? '▶' : s.type === 'article' ? '📄' : '🔗';
  return `
    <div class="save-card ${s.is_read ? 'is-read' : ''}" data-id="${s.id}">
      ${s.thumbnail ? `<div class="save-thumb" style="background-image:url('${escHtml(s.thumbnail)}')"></div>` : `<div class="save-thumb save-thumb-placeholder">${typeIcon}</div>`}
      <div class="save-body">
        <div class="save-meta">
          <span class="save-type-badge">${typeIcon} ${s.type}</span>
          ${domain ? `<span class="save-domain">${escHtml(domain)}</span>` : ''}
          ${s.is_read ? '<span class="save-read-badge">Read</span>' : ''}
        </div>
        <div class="save-title">${escHtml(s.title || s.url)}</div>
        ${s.description ? `<div class="save-desc">${escHtml(s.description)}</div>` : ''}
        ${tags.length ? `<div class="save-tags">${tags.map(t => `<span class="save-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
        <div class="save-footer">
          <span class="save-date">${new Date(s.created_at + 'Z').toLocaleDateString()}</span>
          <div class="save-actions">
            <button class="btn-icon save-read-btn" title="${s.is_read ? 'Mark unread' : 'Mark read'}">${s.is_read ? '◉' : '○'}</button>
            <button class="btn-icon save-edit-btn" title="Edit">✎</button>
            <button class="btn-icon save-delete-btn" title="Delete">✕</button>
            <button class="btn btn-sm btn-ghost save-open-btn">Open ↗</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

loadSaves();
