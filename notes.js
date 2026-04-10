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

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Load notes ──
async function loadNotes() {
  try {
    const qs = searchQuery ? `?search=${encodeURIComponent(searchQuery)}` : '';
    const { notes } = await apiFetch(`/api/notes${qs}`);
    allNotes = notes;
    renderTagFilters();
    renderList();
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

  if (!allTags.length) { row.style.display = 'none'; return; }

  row.style.display = 'block';
  pills.innerHTML = [
    `<button class="filter-pill${!filterTag ? ' active' : ''}" data-tag="">All</button>`,
    ...allTags.map(t => `<button class="filter-pill${filterTag === t ? ' active' : ''}" data-tag="${t}">${t}</button>`),
  ].join('');

  pills.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      filterTag = btn.dataset.tag;
      renderTagFilters();
      renderList();
    });
  });
}

// ── Render sidebar list ──
function renderList() {
  const list  = document.getElementById('notes-list');
  const notes = getFilteredNotes();

  document.getElementById('notes-count').textContent = `${notes.length} note${notes.length !== 1 ? 's' : ''}`;

  if (!notes.length) {
    list.innerHTML = `<div class="empty-state" style="padding:32px 16px">
      <div class="empty-icon">📝</div>
      <div class="empty-text">${searchQuery || filterTag ? 'No notes match' : 'No notes yet'}</div>
    </div>`;
    return;
  }

  list.innerHTML = notes.map(n => {
    const active = n.id === currentNoteId ? ' active' : '';
    return `<div class="notes-list-item${active}" onclick="openNote('${n.id}')">
      <div class="notes-list-title">${n.title || 'Untitled'}</div>
      <div class="notes-list-preview">${(n.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}</div>
      ${parseTags(n.tags).length ? `<div class="notes-list-tags">${parseTags(n.tags).map(t=>`<span class="notes-list-tag">${t}</span>`).join('')}</div>` : ''}
      <div class="notes-list-footer">
        <span class="notes-list-time">${formatTimestamp(n.updated_at)}</span>
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

  document.getElementById('note-title').value     = note.title   || '';
  document.getElementById('note-content').innerHTML = note.content || '';
  setDirty(false);
  const ind = document.getElementById('save-indicator');
  ind.textContent = '';
  ind.classList.remove('saved', 'unsaved');

  renderCurrentTags();
  document.getElementById('notes-panel-empty').style.display = 'none';
  document.getElementById('notes-editor').style.display      = 'flex';
  document.getElementById('notes-split').classList.add('note-open');

  renderList(); // re-render to update active highlight
  document.getElementById('note-content').focus();
  updateToolbarState();
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
  if (currentNoteId) setDirty(true);
};

document.getElementById('note-tag-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value.trim().toLowerCase().replace(/,/g, '');
    if (val && !currentTags.includes(val)) {
      currentTags.push(val);
      renderCurrentTags();
      if (currentNoteId) setDirty(true);
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

// ── Mobile back ──
document.getElementById('back-btn').addEventListener('click', () => {
  document.getElementById('notes-split').classList.remove('note-open');
});

// ── Dirty tracking ──
let isDirty = false;
function setDirty(val) {
  isDirty = val;
  const ind = document.getElementById('save-indicator');
  if (val) {
    ind.textContent = 'Unsaved changes';
    ind.classList.add('unsaved');
    ind.classList.remove('saved');
  } else {
    ind.classList.remove('unsaved');
  }
}

// ── Save ──
async function saveNote() {
  if (!currentNoteId) return;
  const title   = document.getElementById('note-title').value;
  const content = document.getElementById('note-content').innerHTML;
  const tags    = currentTags.join(',');
  const ind     = document.getElementById('save-indicator');
  try {
    const { note } = await apiFetch(`/api/notes/${currentNoteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, content, tags }),
    });
    const idx = allNotes.findIndex(n => n.id === currentNoteId);
    if (idx >= 0) allNotes[idx] = note;
    setDirty(false);
    ind.textContent = 'Saved ✓';
    ind.classList.add('saved');
    setTimeout(() => { if (!isDirty) { ind.textContent = ''; ind.classList.remove('saved'); } }, 2000);
    renderList();
  } catch (e) {
    ind.textContent = 'Save failed';
    ind.classList.remove('saved', 'unsaved');
  }
}

document.getElementById('save-note-btn').addEventListener('click', saveNote);

document.getElementById('note-title').addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveNote(); }
});

// ── Formatting toolbar ──
function execFmt(cmd, val = null) {
  document.getElementById('note-content').focus();
  document.execCommand(cmd, false, val);
  updateToolbarState();
}

function updateToolbarState() {
  document.getElementById('fmt-bold').classList.toggle('active', document.queryCommandState('bold'));
  document.getElementById('fmt-italic').classList.toggle('active', document.queryCommandState('italic'));
  document.getElementById('fmt-ul').classList.toggle('active', document.queryCommandState('insertUnorderedList'));
  document.getElementById('fmt-ol').classList.toggle('active', document.queryCommandState('insertOrderedList'));
  const block = document.queryCommandValue('formatBlock');
  document.getElementById('fmt-h2').classList.toggle('active', block === 'h2');
  document.getElementById('fmt-h3').classList.toggle('active', block === 'h3');
}

document.getElementById('fmt-bold').addEventListener('click',   () => execFmt('bold'));
document.getElementById('fmt-italic').addEventListener('click', () => execFmt('italic'));
document.getElementById('fmt-ul').addEventListener('click',     () => execFmt('insertUnorderedList'));
document.getElementById('fmt-ol').addEventListener('click',     () => execFmt('insertOrderedList'));
document.getElementById('fmt-h2').addEventListener('click', () => {
  execFmt('formatBlock', document.queryCommandValue('formatBlock') === 'h2' ? 'p' : 'h2');
});
document.getElementById('fmt-h3').addEventListener('click', () => {
  execFmt('formatBlock', document.queryCommandValue('formatBlock') === 'h3' ? 'p' : 'h3');
});

const noteContent = document.getElementById('note-content');
noteContent.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveNote(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); execFmt('bold'); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'i') { e.preventDefault(); execFmt('italic'); }
});
noteContent.addEventListener('keyup',   updateToolbarState);
noteContent.addEventListener('mouseup', updateToolbarState);
noteContent.addEventListener('input',   () => { if (currentNoteId) setDirty(true); });
document.getElementById('note-title').addEventListener('input', () => { if (currentNoteId) setDirty(true); });

// ── Delete ──
window.deleteNote = async function(id) {
  if (!confirm('Delete this note?')) return;
  try {
    await apiFetch(`/api/notes/${id}`, { method: 'DELETE' });
    allNotes = allNotes.filter(n => n.id !== id);
    if (currentNoteId === id) {
      currentNoteId = null;
      document.getElementById('notes-editor').style.display      = 'none';
      document.getElementById('notes-panel-empty').style.display = 'flex';
      document.getElementById('notes-split').classList.remove('note-open');
    }
    renderList();
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
