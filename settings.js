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
    document.getElementById('weather-zip-input').value = s.weatherZip || '';
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
        tickers:    tickersTag.getValue(),
        teams:      teamsTag.getValue(),
        topics:     topicsTag.getValue(),
        weatherZip: document.getElementById('weather-zip-input').value.trim(),
      }),
    });
    toast('Settings saved', 'success');
  } catch (e) {
    toast(e.message || 'Save failed', 'error');
  }
});

// ── Start ──
loadSettings();

// ── Work Tasks ──
async function loadWorkSettings() {
  try {
    const s = await apiFetch('/api/work/settings');
    document.getElementById('work-tasks-url').value   = s.url   || '';
    document.getElementById('work-tasks-token').value = s.token || '';
  } catch { /* not configured yet */ }
}

document.getElementById('work-tasks-save-btn').addEventListener('click', async () => {
  try {
    await apiFetch('/api/work/settings', {
      method: 'PUT',
      body: JSON.stringify({
        url:   document.getElementById('work-tasks-url').value.trim(),
        token: document.getElementById('work-tasks-token').value.trim(),
      }),
    });
    toast('Work tasks settings saved', 'success');
  } catch (e) { toast(e.message || 'Save failed', 'error'); }
});

loadWorkSettings();

// ── Gmail ──
async function loadGmailStatus() {
  try {
    const { connected } = await apiFetch('/api/gmail/status');
    document.getElementById('gmail-disconnected').style.display = connected ? 'none' : 'block';
    document.getElementById('gmail-connected').style.display   = connected ? 'block' : 'none';
    if (connected) {
      const s = await apiFetch('/api/gmail/settings');
      if (!gmailSendersTag) gmailSendersTag = makeTagInput('gmail-senders-wrap', s.senders || '');
      else gmailSendersTag.setValue(s.senders || '');
      if (!gmailTopicsTag) gmailTopicsTag = makeTagInput('gmail-topics-wrap', s.topics || '');
      else gmailTopicsTag.setValue(s.topics || '');
    }
  } catch { /* not configured yet */ }
}

let gmailSendersTag, gmailTopicsTag;

document.getElementById('gmail-connect-btn').addEventListener('click', () => {
  const workerUrl = document.querySelector('meta[name="worker-url"]')?.content || '';
  window.location.href = `${workerUrl}/api/gmail/auth?origin=${encodeURIComponent(window.location.origin)}`;
});

document.getElementById('gmail-disconnect-btn').addEventListener('click', async () => {
  if (!confirm('Disconnect Gmail? This will remove your tokens.')) return;
  try {
    await apiFetch('/api/gmail/disconnect', { method: 'DELETE' });
    toast('Gmail disconnected', 'success');
    loadGmailStatus();
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('gmail-filters-save-btn').addEventListener('click', async () => {
  try {
    await apiFetch('/api/gmail/settings', {
      method: 'PUT',
      body: JSON.stringify({ senders: gmailSendersTag?.getValue() || '', topics: gmailTopicsTag?.getValue() || '' }),
    });
    toast('Gmail filters saved', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// Check for ?gmail=connected in URL after OAuth redirect
if (new URLSearchParams(location.search).get('gmail') === 'connected') {
  toast('Gmail connected successfully!', 'success');
  history.replaceState({}, '', location.pathname);
}

loadGmailStatus();
