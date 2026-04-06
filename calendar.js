import { apiFetch, toast, localDateStr, formatTime, EVENT_COLORS } from './api.js';
import { initNav } from './nav.js';

initNav('calendar');

// ── State ──
const _params      = new URLSearchParams(location.search);
let calView        = _params.get('view') || 'month';
let cursor         = new Date();
const _dateParam   = _params.get('date');
if (_dateParam) { cursor = new Date(_dateParam + 'T12:00:00'); } else { cursor.setDate(1); }
let events         = [];          // personal (Cerebro) events
let outlookEvents  = [];          // work (Outlook) events
let selectedColor  = EVENT_COLORS[0];
let editingEventId = null;
let notesEventId   = null;
let notesNoteId    = null;
let notesSaveTimer = null;
let dayModalDate   = null;
let outlookDetailEv = null;       // Outlook event currently shown in detail modal

// ── Color picker ──
function buildColorPicker() {
  const cp = document.getElementById('color-picker');
  cp.innerHTML = EVENT_COLORS.map(c => `
    <div class="color-swatch${c === selectedColor ? ' selected' : ''}"
      style="background:${c}" data-color="${c}" onclick="selectColor('${c}')"></div>
  `).join('');
}
buildColorPicker();

window.selectColor = function(c) {
  selectedColor = c;
  document.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === c));
};

document.getElementById('event-recurrence').addEventListener('change', function() {
  document.getElementById('recurrence-end-group').style.display = this.value === 'NONE' ? 'none' : 'block';
});

// ── Modal helpers ──
function openEventModal(defaults = {}) {
  editingEventId = defaults.id || null;
  document.getElementById('event-modal-title').textContent = editingEventId ? 'Edit Event' : 'Add Event';
  document.getElementById('event-edit-id').value           = defaults.id || '';
  document.getElementById('event-instance-date').value     = defaults._instanceDate || '';
  document.getElementById('event-parent-id').value         = defaults._parentId || '';
  document.getElementById('event-title').value             = defaults.title || '';
  document.getElementById('event-desc').value              = defaults.description || '';
  document.getElementById('event-date').value              = defaults.date || localDateStr();
  document.getElementById('event-start').value             = defaults.startTime || '';
  document.getElementById('event-end').value               = defaults.endTime || '';
  document.getElementById('event-location').value          = defaults.location || '';
  document.getElementById('event-recurrence').value        = defaults.recurrenceType || 'NONE';
  document.getElementById('event-recurrence-end').value    = defaults.recurrenceEnd || '';
  document.getElementById('event-important').checked       = !!defaults.isImportant;
  document.getElementById('recurrence-end-group').style.display =
    (defaults.recurrenceType && defaults.recurrenceType !== 'NONE') ? 'block' : 'none';
  document.getElementById('event-save-btn').textContent = editingEventId ? 'Save Changes' : 'Add Event';
  selectedColor = defaults.color || EVENT_COLORS[0];
  buildColorPicker();
  document.getElementById('event-modal').classList.add('open');
}

window.closeEventModal   = () => { document.getElementById('event-modal').classList.remove('open'); editingEventId = null; };
window.closeDetailModal  = () => document.getElementById('event-detail-modal').classList.remove('open');
window.closeNotesModal   = () => {
  document.getElementById('notes-modal').classList.remove('open');
  if (notesSaveTimer) clearTimeout(notesSaveTimer);
};
window.closeOutlookDetail = () => {
  document.getElementById('outlook-detail-modal').classList.remove('open');
  outlookDetailEv = null;
};
window.closeHiddenModal  = () => document.getElementById('hidden-events-modal').classList.remove('open');

document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
});

// ── Save event ──
document.getElementById('event-save-btn').addEventListener('click', async () => {
  const title = document.getElementById('event-title').value.trim();
  const date  = document.getElementById('event-date').value;
  if (!title || !date) { toast('Title and date are required', 'error'); return; }

  const startT = document.getElementById('event-start').value;
  const endT   = document.getElementById('event-end').value;
  const startTime    = startT ? `${date}T${startT}:00` : `${date}T00:00:00`;
  const endTime      = endT   ? `${date}T${endT}:00`   : null;
  const instanceDate = document.getElementById('event-instance-date').value;
  const parentId     = document.getElementById('event-parent-id').value;

  const payload = {
    title,
    description:    document.getElementById('event-desc').value,
    startTime,
    endTime,
    location:       document.getElementById('event-location').value,
    color:          selectedColor,
    isImportant:    document.getElementById('event-important').checked,
    recurrenceType: document.getElementById('event-recurrence').value,
    recurrenceEnd:  document.getElementById('event-recurrence-end').value || null,
    ...(instanceDate ? { _instanceDate: instanceDate, parentEventId: parentId || editingEventId } : {}),
  };

  try {
    if (editingEventId) {
      await apiFetch(`/api/events/${editingEventId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast('Event updated', 'success');
    } else {
      await apiFetch('/api/events', { method: 'POST', body: JSON.stringify(payload) });
      toast('Event added', 'success');
    }
    window.closeEventModal();
    loadEvents();
  } catch (e) { toast(e.message, 'error'); }
});

// ── Day Detail Modal ──
function openDayModal(dateStr) {
  dayModalDate = dateStr;
  const d = new Date(dateStr + 'T12:00:00');
  document.getElementById('day-modal-title').textContent =
    d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  refreshDayModal();
  document.getElementById('day-detail-modal').classList.add('open');
}

window.closeDayModal = function() {
  document.getElementById('day-detail-modal').classList.remove('open');
  dayModalDate = null;
};

function refreshDayModal() {
  if (!dayModalDate) return;
  const dayPersonal = events.filter(e => e.start_time?.startsWith(dayModalDate));
  const dayWork     = outlookEvents.filter(e => e.start_time?.startsWith(dayModalDate));
  const body        = document.getElementById('day-modal-body');

  const HOURS = Array.from({length: 16}, (_, i) => i + 7);

  function workChip(e) {
    const startLabel = formatTime(e.start_time);
    const endLabel   = e.end_time ? ` – ${formatTime(e.end_time)}` : '';
    return `<div class="day-event-chip" style="background:#0EA5E9"
      data-outlook-uid="${e.uid}" data-day-instance="${e._instanceDate || ''}">
      <span class="day-event-chip-time">${startLabel}${endLabel}</span>
      <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.title}</span>
    </div>`;
  }

  function personalChip(e) {
    const startLabel = formatTime(e.start_time);
    const endLabel   = e.end_time ? ` – ${formatTime(e.end_time)}` : '';
    return `<div class="day-event-chip" style="background:${e.color}"
      data-day-event-id="${e.id}" data-day-instance="${e._instanceDate || ''}">
      <span class="day-event-chip-time">${startLabel}${endLabel}</span>
      <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.title}</span>
    </div>`;
  }

  // Column header
  let html = `<div class="day-split-col-header">
    <div></div>
    <div class="day-split-col-label work">🏢 Work</div>
    <div class="day-split-col-label personal">🏠 Personal</div>
  </div>`;

  html += HOURS.map(h => {
    const label       = h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`;
    const workSlot    = dayWork.filter(e => e.start_time && new Date(e.start_time).getHours() === h);
    const persSlot    = dayPersonal.filter(e => e.start_time && !e.start_time.endsWith('T00:00:00') && new Date(e.start_time).getHours() === h);

    return `<div class="day-hour-row">
      <div class="day-hour-label">${label}</div>
      <div class="day-hour-work-slot">${workSlot.map(workChip).join('')}</div>
      <div class="day-hour-slot" data-slot-hour="${h}">${persSlot.map(personalChip).join('')}</div>
    </div>`;
  }).join('');

  body.innerHTML = html;

  body.querySelectorAll('.day-hour-slot[data-slot-hour]').forEach(slot => {
    slot.addEventListener('click', e => {
      if (e.target.closest('[data-day-event-id]')) return;
      const h = String(slot.dataset.slotHour).padStart(2, '0');
      openEventModal({ date: dayModalDate, startTime: `${h}:00` });
    });
  });

  body.querySelectorAll('[data-day-event-id]').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      const ev = events.find(ev => ev.id === chip.dataset.dayEventId && (ev._instanceDate || '') === chip.dataset.dayInstance)
              || events.find(ev => ev.id === chip.dataset.dayEventId);
      if (ev) showEventDetail(ev);
    });
  });

  body.querySelectorAll('[data-outlook-uid]').forEach(chip => {
    chip.addEventListener('click', e => {
      e.stopPropagation();
      const ev = outlookEvents.find(ev => ev.uid === chip.dataset.outlookUid && (ev._instanceDate || '') === chip.dataset.dayInstance)
              || outlookEvents.find(ev => ev.uid === chip.dataset.outlookUid);
      if (ev) showOutlookDetail(ev);
    });
  });
}

document.getElementById('day-add-event-btn').addEventListener('click', () => {
  openEventModal({ date: dayModalDate });
});

// ── Load events ──
async function loadEvents() {
  const { start, end } = getRange();
  try {
    const [{ events: evts }, { events: outlookEvts }] = await Promise.all([
      apiFetch(`/api/events?start=${start}&end=${end}`),
      apiFetch(`/api/outlook/events?start=${start}&end=${end}`),
    ]);
    events        = evts;
    outlookEvents = outlookEvts;
    render();
    if (dayModalDate) refreshDayModal();
  } catch (e) { toast(e.message, 'error'); }
}

function getRange() {
  if (calView === 'month') {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const start = `${y}-${String(m+1).padStart(2,'0')}-01`;
    const last  = new Date(y, m+1, 0).getDate();
    const end   = `${y}-${String(m+1).padStart(2,'0')}-${String(last).padStart(2,'0')}`;
    return { start, end };
  }
  if (calView === 'week') {
    const d = new Date(cursor);
    d.setDate(d.getDate() - d.getDay());
    const start = localDateStr(d);
    d.setDate(d.getDate() + 6);
    return { start, end: localDateStr(d) };
  }
  const s = localDateStr(cursor);
  return { start: s, end: s };
}

// ── Render ──
function render() {
  updatePeriodLabel();
  const el = document.getElementById('cal-content');
  if (calView === 'month')      el.innerHTML = renderMonth();
  else if (calView === 'week')  el.innerHTML = renderSplitView('week');
  else                          el.innerHTML = renderSplitView('day');
  attachCellClicks();
}

function updatePeriodLabel() {
  const label = document.getElementById('period-label');
  if (calView === 'month') {
    label.textContent = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  } else if (calView === 'week') {
    const d = new Date(cursor);
    d.setDate(d.getDate() - d.getDay());
    const end = new Date(d); end.setDate(end.getDate() + 6);
    label.textContent = `${d.toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${end.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;
  } else {
    label.textContent = cursor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
}

// ── Month view ──
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function renderMonth() {
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const firstDay     = new Date(y, m, 1).getDay();
  const daysInMonth  = new Date(y, m+1, 0).getDate();
  const todayStr     = localDateStr();

  // Build event maps for both calendars
  const personalMap = {};
  events.forEach(e => {
    const d = e.start_time?.split('T')[0];
    if (d) { personalMap[d] = personalMap[d] || []; personalMap[d].push({ ...e, _source: 'personal' }); }
  });
  const workMap = {};
  outlookEvents.forEach(e => {
    const d = e.start_time?.split('T')[0];
    if (d) { workMap[d] = workMap[d] || []; workMap[d].push({ ...e, _source: 'work' }); }
  });

  let html = `<div class="cal-month-grid">${DAYS.map(d=>`<div class="cal-day-header">${d}</div>`).join('')}`;
  for (let i = 0; i < firstDay; i++) html += `<div class="cal-cell other-month"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const ds      = `${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const personal = personalMap[ds] || [];
    const work     = workMap[ds] || [];
    const all      = [...work, ...personal];
    const isToday  = ds === todayStr;

    let dotsHtml = '';
    // Work events (sky blue dot)
    work.slice(0, 2).forEach(e => {
      dotsHtml += `<div class="cal-event-dot work-event" data-outlook-uid="${e.uid}" data-instance="${e._instanceDate||''}">${e.title}</div>`;
    });
    // Personal events
    personal.slice(0, Math.max(0, 3 - work.slice(0,2).length)).forEach(e => {
      dotsHtml += `<div class="cal-event-dot" style="background:${e.color}" data-event-id="${e.id}" data-instance="${e._instanceDate||''}">${e.title}</div>`;
    });
    const overflow = all.length - (work.slice(0,2).length + personal.slice(0, Math.max(0, 3 - work.slice(0,2).length)).length);

    html += `<div class="cal-cell${isToday?' today':''}${all.length?' has-events':''}" data-date="${ds}">
      <div class="cal-cell-date">${day}</div>
      ${dotsHtml}
      ${overflow > 0 ? `<div style="font-size:10px;color:var(--text-3)">+${overflow} more</div>` : ''}
    </div>`;
  }
  html += '</div>';
  return html;
}

// ── Split view (week + day) ──
const HOURS = Array.from({length:16}, (_,i) => i+7); // 7am–10pm

function getColumns(mode) {
  if (mode === 'week') {
    const d = new Date(cursor);
    d.setDate(d.getDate() - d.getDay());
    return Array.from({length:7}, (_, i) => { const c = new Date(d); c.setDate(c.getDate() + i); return c; });
  }
  return [new Date(cursor)];
}

function renderTimeGrid(mode, cols, sourceEvents, isWork) {
  const todayStr  = localDateStr();
  const colCount  = cols.length;
  const color     = isWork ? '#0EA5E9' : null; // work events always sky blue

  let html = `<div class="cal-time-grid${mode==='week'?' week-view':''}" style="grid-template-columns:48px repeat(${colCount},1fr)">`;

  // Header
  html += `<div class="time-label" style="height:44px;border-bottom:1px solid var(--border)"></div>`;
  cols.forEach(d => {
    const ds      = localDateStr(d);
    const isToday = ds === todayStr;
    html += `<div class="cal-col-header${isToday?' today':''}" style="height:44px">
      <div>${DAYS[d.getDay()]}</div>
      <div class="cal-col-header-date">${d.getDate()}</div>
    </div>`;
  });

  // Time rows
  HOURS.forEach(h => {
    const label = h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h-12} PM`;
    html += `<div class="time-label">${label}</div>`;
    cols.forEach(d => {
      const ds         = localDateStr(d);
      const slotEvents = sourceEvents.filter(e => {
        const eDate = e.start_time?.split('T')[0];
        const eHour = e.start_time ? new Date(e.start_time).getHours() : null;
        return eDate === ds && eHour === h;
      });

      const evHtml = slotEvents.map(e => {
        const c   = color || e.color;
        const uid = e.uid;
        const id  = e.id;
        return isWork
          ? `<div class="time-event work-time-event" style="background:${c}" data-outlook-uid="${uid}" data-instance="${e._instanceDate||''}">${e.title}</div>`
          : `<div class="time-event" style="background:${c}" data-event-id="${id}" data-instance="${e._instanceDate||''}">${e.title}</div>`;
      }).join('');

      // Only personal slots are clickable to add events
      html += isWork
        ? `<div class="time-slot work-slot">${evHtml}</div>`
        : `<div class="time-slot" data-date="${ds}" data-hour="${h}">${evHtml}</div>`;
    });
  });

  html += '</div>';
  return html;
}

function renderSplitView(mode) {
  const cols = getColumns(mode);
  return `
  <div class="cal-split-wrapper">
    <div class="cal-split-panel">
      <div class="cal-split-header work-header">🏢 Work — Outlook</div>
      ${renderTimeGrid(mode, cols, outlookEvents, true)}
    </div>
    <div class="cal-split-divider"></div>
    <div class="cal-split-panel">
      <div class="cal-split-header personal-header">🏠 Personal — Cerebro</div>
      ${renderTimeGrid(mode, cols, events, false)}
    </div>
  </div>`;
}

// ── Click handlers ──
function attachCellClicks() {
  // Month cell → day modal
  document.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', e => {
      if (e.target.closest('[data-event-id],[data-outlook-uid]')) return;
      openDayModal(cell.dataset.date);
    });
  });

  // Personal time slots → add event
  document.querySelectorAll('.time-slot[data-date]').forEach(cell => {
    cell.addEventListener('click', e => {
      if (e.target.closest('[data-event-id]')) return;
      openEventModal({ date: cell.dataset.date, startTime: String(cell.dataset.hour).padStart(2,'0') + ':00' });
    });
  });

  // Personal event chips
  document.querySelectorAll('[data-event-id]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const ev = events.find(ev => ev.id === el.dataset.eventId && (ev._instanceDate||'') === el.dataset.instance)
              || events.find(ev => ev.id === el.dataset.eventId);
      if (ev) showEventDetail(ev);
    });
  });

  // Outlook event chips (month + week/day)
  document.querySelectorAll('[data-outlook-uid]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const ev = outlookEvents.find(ev => ev.uid === el.dataset.outlookUid && (ev._instanceDate||'') === el.dataset.instance)
              || outlookEvents.find(ev => ev.uid === el.dataset.outlookUid);
      if (ev) showOutlookDetail(ev);
    });
  });
}

// ── Personal event detail ──
function showEventDetail(ev) {
  document.getElementById('detail-color-dot').style.background = ev.color;
  document.getElementById('detail-title').textContent = ev.title;

  const start = ev.start_time ? new Date(ev.start_time) : null;
  const end   = ev.end_time   ? new Date(ev.end_time)   : null;

  let body = '';
  if (start) body += `<p style="font-size:13px;color:var(--text-2);margin-bottom:8px">📅 ${start.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}<br>🕐 ${formatTime(ev.start_time)}${end ? ' – ' + formatTime(ev.end_time) : ''}</p>`;
  if (ev.location)  body += `<p style="font-size:13px;color:var(--text-3);margin-bottom:8px">📍 ${ev.location}</p>`;
  if (ev.description) body += `<p style="font-size:13px;color:var(--text-2)">${ev.description}</p>`;
  if (ev.recurrence_type !== 'NONE') body += `<p style="font-size:11px;color:var(--text-3);margin-top:8px">↻ Repeats ${ev.recurrence_type.toLowerCase()}</p>`;
  document.getElementById('detail-body').innerHTML = body;

  const isRecurring = ev.recurrence_type !== 'NONE' || ev.parent_event_id;
  document.getElementById('detail-footer').innerHTML = `
    <button class="btn btn-ghost btn-sm" onclick="openMeetingNotes('${ev.id}')">📋 Event Notes</button>
    <button class="btn btn-ghost btn-sm" onclick="startEdit(${JSON.stringify(ev).replace(/"/g,'&quot;')}, ${isRecurring})">✏️ Edit</button>
    <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="startDelete(${JSON.stringify(ev).replace(/"/g,'&quot;')}, ${isRecurring})">🗑 Delete</button>
  `;
  document.getElementById('event-detail-modal').classList.add('open');
}

// ── Outlook event detail (read-only) ──
function showOutlookDetail(ev) {
  outlookDetailEv = ev;
  document.getElementById('outlook-detail-title').textContent = ev.title;

  const start = ev.start_time ? new Date(ev.start_time) : null;
  const end   = ev.end_time   ? new Date(ev.end_time)   : null;

  let body = '';
  if (start) {
    body += `<p style="font-size:13px;color:var(--text-2);margin-bottom:8px">
      📅 ${start.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}<br>
      🕐 ${formatTime(ev.start_time)}${end ? ' – ' + formatTime(ev.end_time) : ''}
    </p>`;
  }
  if (ev.location)    body += `<p style="font-size:13px;color:var(--text-3);margin-bottom:8px">📍 ${ev.location}</p>`;
  if (ev.organizer)   body += `<p style="font-size:13px;color:var(--text-3);margin-bottom:8px">👤 ${ev.organizer}</p>`;
  if (ev.recurrence_rule) body += `<p style="font-size:11px;color:var(--text-3);margin-bottom:8px">↻ Recurring</p>`;
  if (ev.description) body += `<p style="font-size:13px;color:var(--text-2);white-space:pre-wrap">${ev.description.slice(0,400)}</p>`;

  body += `<p style="font-size:10px;color:var(--text-3);margin-top:12px;font-style:italic">Read-only — synced from Outlook</p>`;
  document.getElementById('outlook-detail-body').innerHTML = body;
  document.getElementById('outlook-detail-modal').classList.add('open');
}

// Hide button inside Outlook detail modal
document.getElementById('outlook-hide-btn').addEventListener('click', async () => {
  if (!outlookDetailEv) return;
  try {
    await apiFetch('/api/outlook/hide', {
      method: 'POST',
      body: JSON.stringify({ uid: outlookDetailEv.uid, title: outlookDetailEv.title }),
    });
    window.closeOutlookDetail();
    toast('Event hidden', 'success');
    loadEvents();
  } catch (e) { toast(e.message, 'error'); }
});

// ── Edit / delete personal events ──
window.startEdit = function(ev, isRecurring) {
  window.closeDetailModal();
  if (isRecurring) { showRecurMenu(ev, 'edit'); }
  else {
    openEventModal({
      id: ev.id, title: ev.title, description: ev.description,
      date: ev.start_time?.split('T')[0],
      startTime: ev.start_time ? new Date(ev.start_time).toTimeString().slice(0,5) : '',
      endTime:   ev.end_time   ? new Date(ev.end_time).toTimeString().slice(0,5)   : '',
      location: ev.location, color: ev.color, isImportant: ev.is_important,
      recurrenceType: ev.recurrence_type, recurrenceEnd: ev.recurrence_end,
    });
  }
};

window.startDelete = function(ev, isRecurring) {
  window.closeDetailModal();
  if (isRecurring) showRecurMenu(ev, 'delete');
  else confirmDelete(ev.id, false, null);
};

async function confirmDelete(id, all, instanceDate) {
  let url = `/api/events/${id}`;
  if (all) url += '?all=true';
  if (instanceDate) url += `?instanceDate=${instanceDate}`;
  try {
    await apiFetch(url, { method: 'DELETE' });
    toast('Event deleted', 'success');
    loadEvents();
  } catch (e) { toast(e.message, 'error'); }
}

function showRecurMenu(ev, action) {
  const menu         = document.getElementById('recur-menu');
  const instanceDate = ev._instanceDate || ev.start_time?.split('T')[0];
  menu.innerHTML     = action === 'edit' ? `
    <button onclick="editInstance(${JSON.stringify(ev).replace(/"/g,'&quot;')})">✏️ Edit this instance</button>
    <button onclick="editSeries('${ev.id}', ${JSON.stringify(ev).replace(/"/g,'&quot;')})">📋 Edit entire series</button>
  ` : `
    <button onclick="deleteInstance('${ev.id}','${instanceDate}')">🗑 Delete this instance</button>
    <button class="danger" onclick="deleteSeries('${ev.id}')">🗑 Delete entire series</button>
  `;
  menu.style.display   = 'block';
  menu.style.left      = '50%';
  menu.style.top       = '50%';
  menu.style.transform = 'translate(-50%,-50%)';
  const close = () => { menu.style.display = 'none'; document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

window.editInstance = function(ev) {
  openEventModal({
    id: ev.id, _instanceDate: ev._instanceDate || ev.start_time?.split('T')[0],
    _parentId: ev.parent_event_id || ev.id, title: ev.title, description: ev.description,
    date: ev.start_time?.split('T')[0],
    startTime: ev.start_time ? new Date(ev.start_time).toTimeString().slice(0,5) : '',
    endTime:   ev.end_time   ? new Date(ev.end_time).toTimeString().slice(0,5)   : '',
    location: ev.location, color: ev.color, isImportant: !!ev.is_important, recurrenceType: 'NONE',
  });
};
window.editSeries = function(id, ev) {
  openEventModal({
    id, title: ev.title, description: ev.description, date: ev.start_time?.split('T')[0],
    startTime: ev.start_time ? new Date(ev.start_time).toTimeString().slice(0,5) : '',
    location: ev.location, color: ev.color, isImportant: !!ev.is_important,
    recurrenceType: ev.recurrence_type, recurrenceEnd: ev.recurrence_end,
  });
};
window.deleteInstance = (id, date) => confirmDelete(id, false, date);
window.deleteSeries   = (id) => confirmDelete(id, true, null);

// ── Meeting Notes ──
window.openMeetingNotes = async function(eventId) {
  window.closeDetailModal();
  notesEventId = eventId;
  try {
    const { notes } = await apiFetch(`/api/events/${eventId}/notes`);
    const note = notes[0];
    notesNoteId = note?.id || null;
    document.getElementById('notes-content').value = note?.content || '';
    document.getElementById('notes-save-indicator').textContent = '';
    document.getElementById('notes-modal').classList.add('open');
  } catch (e) { toast(e.message, 'error'); }
};

document.getElementById('notes-content').addEventListener('input', () => {
  if (notesSaveTimer) clearTimeout(notesSaveTimer);
  document.getElementById('notes-save-indicator').textContent = 'Saving…';
  document.getElementById('notes-save-indicator').classList.remove('saved');
  notesSaveTimer = setTimeout(saveNotes, 2000);
});

async function saveNotes() {
  const content = document.getElementById('notes-content').value;
  try {
    if (notesNoteId) {
      await apiFetch(`/api/notes/${notesNoteId}`, { method: 'PATCH', body: JSON.stringify({ content }) });
    } else {
      const { note } = await apiFetch(`/api/events/${notesEventId}/notes`, {
        method: 'POST', body: JSON.stringify({ title: 'Event Notes', content }),
      });
      notesNoteId = note.id;
    }
    document.getElementById('notes-save-indicator').textContent = 'Saved ✓';
    document.getElementById('notes-save-indicator').classList.add('saved');
  } catch (e) { document.getElementById('notes-save-indicator').textContent = 'Save failed'; }
}

// ── Outlook Sync ──
async function loadSyncStatus() {
  try {
    const { lastSync } = await apiFetch('/api/sync/status');
    updateSyncLabel(lastSync);
  } catch (_) {}
}

function updateSyncLabel(lastSync) {
  const el = document.getElementById('sync-status-text');
  if (!lastSync) { el.textContent = 'Never synced'; el.className = 'sync-status-text unsynced'; return; }
  const d    = new Date(lastSync);
  const diff = Date.now() - d.getTime();
  let label;
  if (diff < 60000)         label = 'Synced just now';
  else if (diff < 3600000)  label = `Synced ${Math.floor(diff/60000)}m ago`;
  else if (diff < 86400000) label = `Synced ${Math.floor(diff/3600000)}h ago`;
  else                      label = `Synced ${d.toLocaleDateString('en-US',{month:'short',day:'numeric'})}`;
  el.textContent = label;
  el.className   = 'sync-status-text';
}

document.getElementById('sync-btn').addEventListener('click', async () => {
  const btn = document.getElementById('sync-btn');
  btn.textContent = '⟳ Syncing…';
  btn.disabled    = true;
  try {
    const result = await apiFetch('/api/sync/outlook', { method: 'POST' });
    toast(`Synced ${result.count} events`, 'success');
    updateSyncLabel(new Date().toISOString());
    loadEvents();
  } catch (e) {
    toast('Sync failed: ' + e.message, 'error');
  } finally {
    btn.textContent = '⟳ Sync';
    btn.disabled    = false;
  }
});

// ── Hidden events modal ──
document.getElementById('hidden-events-btn').addEventListener('click', async () => {
  document.getElementById('hidden-events-modal').classList.add('open');
  document.getElementById('hidden-events-body').innerHTML = '<div class="spinner"></div>';
  try {
    const { hidden } = await apiFetch('/api/outlook/hidden');
    const body = document.getElementById('hidden-events-body');
    if (!hidden.length) {
      body.innerHTML = '<p style="color:var(--text-3);font-size:13px;text-align:center;padding:20px">No hidden events</p>';
      return;
    }
    body.innerHTML = hidden.map(h => `
      <div class="hidden-event-row">
        <div class="hidden-event-title">${h.title || h.uid}</div>
        <button class="btn btn-ghost btn-sm" onclick="restoreOutlookEvent('${h.uid}')">Restore</button>
      </div>
    `).join('');
  } catch (e) { toast(e.message, 'error'); }
});

window.restoreOutlookEvent = async function(uid) {
  try {
    await apiFetch(`/api/outlook/hide/${encodeURIComponent(uid)}`, { method: 'DELETE' });
    toast('Event restored', 'success');
    document.getElementById('hidden-events-modal').classList.remove('open');
    loadEvents();
  } catch (e) { toast(e.message, 'error'); }
};

// ── Navigation ──
document.getElementById('today-btn').addEventListener('click', () => {
  cursor = new Date();
  if (calView !== 'day') cursor.setDate(1);
  loadEvents();
});

document.getElementById('prev-btn').addEventListener('click', () => {
  if (calView === 'month')     cursor.setMonth(cursor.getMonth() - 1);
  else if (calView === 'week') cursor.setDate(cursor.getDate() - 7);
  else                         cursor.setDate(cursor.getDate() - 1);
  loadEvents();
});

document.getElementById('next-btn').addEventListener('click', () => {
  if (calView === 'month')     cursor.setMonth(cursor.getMonth() + 1);
  else if (calView === 'week') cursor.setDate(cursor.getDate() + 7);
  else                         cursor.setDate(cursor.getDate() + 1);
  loadEvents();
});

document.querySelector('.segmented').addEventListener('click', e => {
  const btn = e.target.closest('[data-view]');
  if (!btn) return;
  calView = btn.dataset.view;
  document.querySelectorAll('.segmented button').forEach(b => b.classList.toggle('active', b === btn));
  if (calView !== 'day') { cursor = new Date(); cursor.setDate(1); }
  loadEvents();
});

document.getElementById('add-event-btn').addEventListener('click', () => openEventModal({ date: localDateStr(cursor) }));

// ── Init ──
loadEvents();
loadSyncStatus();
