import { apiFetch, toast } from './api.js';
import { initNav } from './nav.js';

initNav('notes');

let allNotes = [];
let currentNoteId = null;
let currentTags = [];
let filterTag = '';
let searchQuery = '';

// ── Helpers ──
function parseTags(str) {
  if (!str) return [];
  return str.split(',').map(t => t.trim()).filter(Boolean);
}

function formatRelative(ts) {
  if (!ts) return '';
  const d = new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'));
  const diff = Date.now() - d.getTime();
  if (diff < 60000)    return 'Just now';
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Load notes ──
async function loadNotes() {
  try {
    const qs = searchQuery ? `?search=${encodeURIComponent(searchQuery)}` : '';
    const { notes } = await apiFetch(`/api/notes${qs}`);
    allNotes = notes;
    renderTagFilters();
    renderGrid();
  } catch (e) { toast(e.message, 'error'); }
}

function getFilteredNotes() {
  if (!filterTag) return allNotes;
  return allNotes.filter(n => parseTags(n.tags).includes(filterTag));
}

// ── Tag filter pills ──
function renderTagFilters() {
  const allTags = [...new Set(allNotes.flatMap(n => parseTags(n.tags)))].sort();
  const row   = document.getElementById('tag-filter-row');
  const pills = document.getElementById('tag-filter-pills');

  if (!allTags.length) {
    row.style.display = 'none';
    return;
  }

  row.style.display = 'block';
  pills.innerHTML = [
    `<button class="filter-pill${!filterTag ? ' active' : ''}" data-tag="">All</button>`,
    ...allTags.map(t => `<button class="filter-pill${filterTag === t ? ' active' : ''}" data-tag="${t}">${t}</button>`),
  ].join('');

  pills.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      filterTag = btn.dataset.tag;
      renderTagFilters();
      renderGrid();
    });
  });
}

// ── Render grid ──
function renderGrid() {
  const grid  = document.getElementById('notes-grid');
  const notes = getFilteredNotes();

  if (!notes.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">📝</div>
      <div class="empty-text">${searchQuery || filterTag ? 'No notes match your filter' : 'No notes yet'}</div>
      <div class="empty-sub">${searchQuery || filterTag ? '' : 'Click "New Note" to get started'}</div>
    </div>`;
    return;
  }

  grid.innerHTML = notes.map(n => {
    const tags    = parseTags(n.tags);
    const tagHtml = tags.length
      ? `<div class="note-card-tags">${tags.map(t => `<span class="tag-chip">${t}</span>`).join('')}</div>`
      : '';
    return `
    <div class="note-card" onclick="openNote('${n.id}')">
      <div class="note-card-title">${n.title || 'Untitled'}</div>
      <div class="note-card-preview">${n.content || ''}</div>
      ${tagHtml}
      <div class="note-card-footer">
        <span class="note-timestamp">${formatRelative(n.updated_at)}</span>
        <button class="btn-icon danger" onclick="event.stopPropagation();deleteNote('${n.id}')" title="Delete">🗑</button>
      </div>
    </div>`;
  }).join('');
}

// ── Open note ──
window.openNote = function(id) {
  const note = allNotes.find(n => n.id === id);
  if (!note) return;
  currentNoteId = id;
  currentTags   = parseTags(note.tags);

  document.getElementById('note-title').value   = note.title   || '';
  document.getElementById('note-content').value = note.content || '';
  const ind = document.getElementById('save-indicator');
  ind.textContent = '';
  ind.classList.remove('saved');

  renderCurrentTags();
  document.getElementById('grid-view').style.display   = 'none';
  document.getElementById('editor-view').style.display = 'block';
  document.getElementById('note-content').focus();
};

// ── Current tag chips (inside editor) ──
function renderCurrentTags() {
  const chips = document.getElementById('note-tags-chips');
  chips.innerHTML = currentTags.map((t, i) =>
    `<span class="tag-chip editable">${t}<button class="tag-chip-remove" onclick="removeTag(${i})">×</button></span>`
  ).join('');
}

window.removeTag = function(i) {
  currentTags.splice(i, 1);
  renderCurrentTags();
};

// Add tag on Enter or comma
document.getElementById('note-tag-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value.trim().toLowerCase().replace(/,/g, '');
    if (val && !currentTags.includes(val)) {
      currentTags.push(val);
      renderCurrentTags();
    }
    e.target.value = '';
  }
});

// ── New note ──
document.getElementById('new-note-btn').addEventListener('click', async () => {
  try {
    const { note } = await apiFetch('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'Untitled', content: '', tags: '' }),
    });
    allNotes.unshift(note);
    openNote(note.id);
  } catch (e) { toast(e.message, 'error'); }
});

// ── Back ──
document.getElementById('back-btn').addEventListener('click', () => {
  currentNoteId = null;
  document.getElementById('editor-view').style.display = 'none';
  document.getElementById('grid-view').style.display   = 'block';
  loadNotes();
});

// ── Save ──
async function saveNote() {
  if (!currentNoteId) return;
  const title   = document.getElementById('note-title').value;
  const content = document.getElementById('note-content').value;
  const tags    = currentTags.join(',');
  const ind     = document.getElementById('save-indicator');
  try {
    const { note } = await apiFetch(`/api/notes/${currentNoteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, content, tags }),
    });
    const idx = allNotes.findIndex(n => n.id === currentNoteId);
    if (idx >= 0) allNotes[idx] = note;
    ind.textContent = 'Saved ✓';
    ind.classList.add('saved');
    setTimeout(() => { ind.textContent = ''; ind.classList.remove('saved'); }, 2000);
  } catch (e) {
    ind.textContent = 'Save failed';
    ind.classList.remove('saved');
  }
}

document.getElementById('save-note-btn').addEventListener('click', saveNote);

// Ctrl/Cmd + S shortcut
['note-title', 'note-content'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveNote(); }
  });
});

// ── Formatting toolbar ──
document.getElementById('fmt-bold').addEventListener('click', () => {
  const ta  = document.getElementById('note-content');
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const selected = value.slice(s, e);
  if (!selected) return;
  ta.setRangeText(`**${selected}**`, s, e, 'end');
  ta.focus();
});

document.getElementById('fmt-bullet').addEventListener('click', () => {
  const ta  = document.getElementById('note-content');
  const { selectionStart: s, selectionEnd: e, value } = ta;

  // Expand selection to cover full lines
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const lineEndIdx = value.indexOf('\n', e);
  const blockEnd  = lineEndIdx === -1 ? value.length : lineEndIdx;
  const block     = value.slice(lineStart, blockEnd);

  const bulleted = block.split('\n').map(line => {
    if (line.startsWith('• ')) return line;  // already bulleted
    return line ? `• ${line}` : line;
  }).join('\n');

  ta.setRangeText(bulleted, lineStart, blockEnd, 'preserve');
  ta.focus();
});

// ── Delete ──
window.deleteNote = async function(id) {
  if (!confirm('Delete this note?')) return;
  try {
    await apiFetch(`/api/notes/${id}`, { method: 'DELETE' });
    allNotes = allNotes.filter(n => n.id !== id);
    if (currentNoteId === id) {
      currentNoteId = null;
      document.getElementById('editor-view').style.display = 'none';
      document.getElementById('grid-view').style.display   = 'block';
    }
    renderGrid();
    toast('Note deleted', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

document.getElementById('delete-note-btn').addEventListener('click', () => {
  if (currentNoteId) window.deleteNote(currentNoteId);
});

// ── Search ──
let searchTimer;
document.getElementById('search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchQuery = e.target.value;
  searchTimer = setTimeout(loadNotes, 300);
});

// ── Init ──
loadNotes();
