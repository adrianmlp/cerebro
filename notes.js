import { apiFetch, toast } from './api.js';
import { initNav } from './nav.js';

initNav('notes');

let allNotes = [];
let currentNoteId = null;
let saveTimer = null;
let searchQuery = '';

// ── Load notes ──
async function loadNotes() {
  try {
    const { notes } = await apiFetch(`/api/notes${searchQuery ? `?search=${encodeURIComponent(searchQuery)}` : ''}`);
    allNotes = notes;
    renderGrid();
  } catch (e) { toast(e.message, 'error'); }
}

function renderGrid() {
  const grid = document.getElementById('notes-grid');

  if (!allNotes.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">📝</div>
      <div class="empty-text">${searchQuery ? 'No notes match your search' : 'No notes yet'}</div>
      <div class="empty-sub">${searchQuery ? '' : 'Click "New Note" to get started'}</div>
    </div>`;
    return;
  }

  grid.innerHTML = allNotes.map(n => `
    <div class="note-card" onclick="openNote('${n.id}')">
      <div class="note-card-title">${n.title || 'Untitled'}</div>
      <div class="note-card-preview">${n.content || ''}</div>
      <div class="note-card-footer">
        <span class="note-timestamp">${formatRelative(n.updated_at)}</span>
        <button class="btn-icon danger" onclick="event.stopPropagation();deleteNote('${n.id}')" title="Delete">🗑</button>
      </div>
    </div>
  `).join('');
}

function formatRelative(ts) {
  if (!ts) return '';
  const d = new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'));
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000)   return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Open note ──
window.openNote = function(id) {
  const note = allNotes.find(n => n.id === id);
  if (!note) return;
  currentNoteId = id;
  document.getElementById('note-title').value = note.title || '';
  document.getElementById('note-content').value = note.content || '';
  document.getElementById('save-indicator').textContent = '';
  document.getElementById('save-indicator').classList.remove('saved');
  document.getElementById('grid-view').style.display = 'none';
  document.getElementById('editor-view').style.display = 'block';
  document.getElementById('note-content').focus();
};

// ── New note ──
document.getElementById('new-note-btn').addEventListener('click', async () => {
  try {
    const { note } = await apiFetch('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'Untitled', content: '' }),
    });
    allNotes.unshift(note);
    openNote(note.id);
  } catch (e) { toast(e.message, 'error'); }
});

// ── Back ──
document.getElementById('back-btn').addEventListener('click', () => {
  if (saveTimer) { clearTimeout(saveTimer); saveNote(); }
  currentNoteId = null;
  document.getElementById('editor-view').style.display = 'none';
  document.getElementById('grid-view').style.display = 'block';
  loadNotes();
});

// ── Auto-save ──
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  document.getElementById('save-indicator').textContent = '…';
  document.getElementById('save-indicator').classList.remove('saved');
  saveTimer = setTimeout(saveNote, 2000);
}

async function saveNote() {
  if (!currentNoteId) return;
  const title   = document.getElementById('note-title').value;
  const content = document.getElementById('note-content').value;
  try {
    const { note } = await apiFetch(`/api/notes/${currentNoteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, content }),
    });
    const idx = allNotes.findIndex(n => n.id === currentNoteId);
    if (idx >= 0) allNotes[idx] = note;
    document.getElementById('save-indicator').textContent = 'Saved ✓';
    document.getElementById('save-indicator').classList.add('saved');
  } catch (e) {
    document.getElementById('save-indicator').textContent = 'Save failed';
  }
}

document.getElementById('note-title').addEventListener('input', scheduleSave);
document.getElementById('note-content').addEventListener('input', scheduleSave);

// ── Delete ──
window.deleteNote = async function(id) {
  if (!confirm('Delete this note?')) return;
  try {
    await apiFetch(`/api/notes/${id}`, { method: 'DELETE' });
    allNotes = allNotes.filter(n => n.id !== id);
    if (currentNoteId === id) {
      currentNoteId = null;
      document.getElementById('editor-view').style.display = 'none';
      document.getElementById('grid-view').style.display = 'block';
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
