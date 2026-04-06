import { apiFetch, toast } from './api.js';
import { initNav } from './nav.js';

// ── Init ──
initNav('settings');

// ── Utilities ──
function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Tag Input helper ──
function makeTagInput(wrapId, initialValue) {
  const wrap = document.getElementById(wrapId);
  let tags = (initialValue || '').split(',').map(t => t.trim()).filter(Boolean);

  function render() {
    wrap.innerHTML = '';
    tags.forEach((tag, i) => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.innerHTML = `${escHtml(tag)}<button class="tag-pill-remove" aria-label="Remove" data-i="${i}">×</button>`;
      wrap.appendChild(pill);
    });

    const inp = document.createElement('input');
    inp.className = 'tag-input-field';
    inp.placeholder = tags.length ? '' : 'Type and press Enter…';
    wrap.appendChild(inp);

    wrap.querySelectorAll('.tag-pill-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        tags.splice(parseInt(btn.dataset.i), 1);
        render();
      });
    });

    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = inp.value.replace(/,+$/, '').trim();
        if (val && !tags.map(t => t.toLowerCase()).includes(val.toLowerCase())) {
          tags.push(val);
          render();
          wrap.querySelector('.tag-input-field')?.focus();
        } else {
          inp.value = '';
        }
      } else if (e.key === 'Backspace' && inp.value === '' && tags.length) {
        tags.pop();
        render();
      }
    });

    inp.addEventListener('blur', () => {
      const val = inp.value.replace(/,+$/, '').trim();
      if (val && !tags.map(t => t.toLowerCase()).includes(val.toLowerCase())) {
        tags.push(val);
        render();
      }
    });

    wrap.addEventListener('click', () => wrap.querySelector('.tag-input-field')?.focus());
  }

  render();
  return {
    getValue: () => tags.join(', '),
    setValue: v => { tags = (v || '').split(',').map(t => t.trim()).filter(Boolean); render(); },
  };
}

// ── Load settings ──
let tickersTag, teamsTag, topicsTag;

async function loadSettings() {
  try {
    const s = await apiFetch('/api/brief/settings');
    tickersTag = makeTagInput('tickers-wrap', s.tickers || '');
    teamsTag   = makeTagInput('teams-wrap',   s.teams   || '');
    topicsTag  = makeTagInput('topics-wrap',  s.topics  || '');
  } catch {
    tickersTag = makeTagInput('tickers-wrap', '');
    teamsTag   = makeTagInput('teams-wrap',   '');
    topicsTag  = makeTagInput('topics-wrap',  '');
  }
}

// ── Save ──
document.getElementById('brief-save-btn').addEventListener('click', async () => {
  try {
    await apiFetch('/api/brief/settings', {
      method: 'PUT',
      body: JSON.stringify({
        tickers: tickersTag.getValue(),
        teams:   teamsTag.getValue(),
        topics:  topicsTag.getValue(),
      }),
    });
    toast('Settings saved', 'success');
  } catch (e) {
    toast(e.message || 'Save failed', 'error');
  }
});

// ── Start ──
loadSettings();
