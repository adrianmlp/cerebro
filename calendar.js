import { apiFetch, toast, localDateStr, formatTime, EVENT_COLORS } from './api.js';
import { initNav } from './nav.js';

initNav('calendar');

// ── State ──
const _params      = new URLSearchParams(location.search);
let calView        = _params.get('view') || 'month';
let cursor         = new Date();
const _dateParam   = _params.get('date');
if (_dateParam) { cursor = new Date(_dateParam + 'T12:00:00'); } else if (calView !== 'day') { cursor.setDate(1); }
// Sync segmented buttons with URL param (HTML defaults to month active)
document.querySelectorAll('.segmented button').forEach(b => b.classList.toggle('active', b.dataset.view === calView));
let events         = [];          // personal (Cerebro) events
let outlookEvents  = [];          // work (Outlook) events
let selectedColor  = EVENT_COLORS[0];
let editingEventId = null;
let notesEventId   = null;
let notesNoteId    = null;
let notesSaveTimer = null;
let dayModalDate   = null;
let outlookDetailEv = null;       // Outlook event currently shown in detail modal
let eventTagInput  = null;        // tag-input instance for the event modal

// ── View filter state (persisted) ──
let showWork     = JSON.parse(localStorage.getItem('cal_show_work')     ?? 'true');
let showPersonal = JSON.parse(localStorage.getItem('cal_show_personal') ?? 'true');
let activeTag    = localStorage.getItem('cal_active_tag') || '';

// ── Tag input helper (shared with settings.js) ──
function _escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function makeTagInput(wrapId, initialValue) {
  const wrap = document.getElementById(wrapId);
  let tags = (initialValue || '').split(',').map(t => t.trim()).filter(Boolean);
  function render() {
    wrap.innerHTML = '';
    tags.forEach((tag, i) => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.innerHTML = `${_escHtml(tag)}<button class="tag-pill-remove" aria-label="Remove" data-i="${i}">×</button>`;
      wrap.appendChild(pill);
    });
    const inp = document.createElement('input');
    inp.className = 'tag-input-field';
    inp.placeholder = tags.length ? '' : 'Type and press Enter…';
    wrap.appendChild(inp);
    wrap.querySelectorAll('.tag-pill-remove').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); tags.splice(+btn.dataset.i, 1); render(); });
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const v = inp.value.replace(/,+$/, '').trim();
        if (v && !tags.map(t => t.toLowerCase()).includes(v.toLowerCase())) { tags.push(v); render(); wrap.querySelector('.tag-input-field')?.focus(); }
        else inp.value = '';
      } else if (e.key === 'Backspace' && inp.value === '' && tags.length) { tags.pop(); render(); }
    });
    inp.addEventListener('blur', () => {
      const v = inp.value.replace(/,+$/, '').trim();
      if (v && !tags.map(t => t.toLowerCase()).includes(v.toLowerCase())) { tags.push(v); render(); }
    });
    wrap.addEventListener('click', () => wrap.querySelector('.tag-input-field')?.focus());
  }
  render();
  return {
    getValue: () => {
      // Flush any text still in the input (user typed but didn't press Enter)
      const inp = wrap.querySelector('.tag-input-field');
      const pending = inp?.value.replace(/,+$/, '').trim();
      if (pending && !tags.map(t => t.toLowerCase()).includes(pending.toLowerCase())) tags.push(pending);
      if (pending) inp.value = '';
      return tags.join(', ');
    },
    setValue: v => { tags = (v||'').split(',').map(t=>t.trim()).filter(Boolean); render(); },
  };
}

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
  document.getElementById('event-end-date').value          = defaults.endDate || '';
  document.getElementById('event-start').value             = defaults.startTime || '';
  document.getElementById('event-end').value               = defaults.endTime || '';
  document.getElementById('event-location').value          = defaults.location || '';
  document.getElementById('event-recurrence').value        = defaults.recurrenceType || 'NONE';
  eventTagInput = makeTagInput('event-tags-wrap', defaults.tags || '');
  document.getElementById('event-recurrence-end').value    = defaults.recurrenceEnd || '';
  document.getElementById('event-important').checked       = !!defaults.isImportant;
  document.getElementById('recurrence-end-group').style.display =
    (defaults.recurrenceType && defaults.recurrenceType !== 'NONE') ? 'block' : 'none';
  document.getElementById('event-save-btn').textContent = editingEventId ? 'Save Changes' : 'Add Event';
  selectedColor = defaults.color || EVENT_COLORS[0];
  buildColorPicker();
  // Show device timezone so user knows what tz the times apply to
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const abbr = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || tz;
  document.getElementById('event-tz-hint').textContent = `🌐 Times are in ${abbr} (${tz})`;
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
  const title    = document.getElementById('event-title').value.trim();
  const date     = document.getElementById('event-date').value;
  const endDate  = document.getElementById('event-end-date').value;
  if (!title || !date) { toast('Title and date are required', 'error'); return; }

  const startT  = document.getElementById('event-start').value;
  const endT    = document.getElementById('event-end').value;
  const startTime = startT ? `${date}T${startT}:00` : `${date}T00:00:00`;
  // Multi-day: use endDate if provided and different from startDate
  const effectiveEndDate = (endDate && endDate >= date) ? endDate : date;
  const endTime = endT
    ? `${effectiveEndDate}T${endT}:00`
    : (effectiveEndDate !== date ? `${effectiveEndDate}T00:00:00` : null);
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
    tags:           eventTagInput?.getValue() || '',
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
  const body = document.getElementById('day-modal-body');

  const START_H  = TG_START;
  const END_H    = TG_END;
  const N_HOURS  = TG_NHOURS;
  const ROW_H    = TG_ROW_H;
  const TOTAL_H  = TG_TOTAL;

  const dayPersonal = events.filter(e => e.start_time?.startsWith(dayModalDate));
  const dayWork     = outlookEvents.filter(e => e.start_time?.startsWith(dayModalDate));

  // Separate all-day/multi-day events (no meaningful time of day)
  const isAllDay = e =>
    e.start_time?.endsWith('T00:00:00') && (!e.end_time || e.end_time.endsWith('T00:00:00'));
  const persAllDay  = dayPersonal.filter(isAllDay);
  const persTimed   = dayPersonal.filter(e => !isAllDay(e));
  const workAllDay  = dayWork.filter(isAllDay);
  const workTimed   = dayWork.filter(e => !isAllDay(e));

  // Build time labels
  let labelsHtml = '';
  for (let h = START_H; h < END_H; h++) {
    const label = h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`;
    labelsHtml += `<div class="dtg-label" style="top:${(h - START_H) * ROW_H}px">${label}</div>`;
  }

  // All-day chips (flat list at top)
  function allDayChips(evList, isWork) {
    return evList.map(e => {
      const color = isWork ? '#0EA5E9' : e.color;
      const data  = isWork
        ? `data-outlook-uid="${e.uid}" data-day-instance="${e._instanceDate || ''}"`
        : `data-day-event-id="${e.id}" data-day-instance="${e._instanceDate || ''}"`;
      return `<div class="day-event-chip" style="background:${color}" ${data}>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.title}</span>
      </div>`;
    }).join('');
  }

  const hasAllDay = persAllDay.length || workAllDay.length;

  let html = `
    <div class="day-split-col-header">
      <div></div>
      <div class="day-split-col-label work">🏢 Work</div>
      <div class="day-split-col-label personal">🏠 Personal</div>
    </div>`;

  if (hasAllDay) {
    html += `<div class="dtg-allday-row">
      <div class="dtg-allday-label">All Day</div>
      <div class="dtg-allday-col">${allDayChips(workAllDay, true)}</div>
      <div class="dtg-allday-col">${allDayChips(persAllDay, false)}</div>
    </div>`;
  }

  const workLaid = tgLayout(workTimed);
  const persLaid = tgLayout(persTimed);
  const workDataAttr = e => `data-outlook-uid="${e.uid}" data-day-instance="${e._instanceDate || ''}"`;
  const persDataAttr = e => `data-day-event-id="${e.id}" data-day-instance="${e._instanceDate || ''}"`;

  html += `<div class="dtg-wrap" style="height:${TOTAL_H}px">
    <div class="dtg-labels">${labelsHtml}</div>
    <div class="dtg-col dtg-work-col">
      ${tgGridLines()}
      ${workLaid.map(item => tgBlock(item, true, workDataAttr)).join('')}
    </div>
    <div class="dtg-col dtg-pers-col" id="dtg-pers-col">
      ${tgGridLines()}
      ${persLaid.map(item => tgBlock(item, false, persDataAttr)).join('')}
    </div>
  </div>`;

  body.innerHTML = html;

  // Click personal column → add event snapped to 15 min
  body.querySelector('#dtg-pers-col').addEventListener('click', e => {
    if (e.target.closest('[data-day-event-id]')) return;
    const rect   = e.currentTarget.getBoundingClientRect();
    const y      = e.clientY - rect.top;
    const raw    = y / ROW_H * 60 + START_H * 60;
    const snapped = Math.min(Math.max(0, Math.round(raw / 15) * 15), END_H * 60 - 15);
    const hh     = String(Math.floor(snapped / 60)).padStart(2, '0');
    const mm     = String(snapped % 60).padStart(2, '0');
    openEventModal({ date: dayModalDate, startTime: `${hh}:${mm}` });
  });

  // Personal timed event clicks
  body.querySelectorAll('[data-day-event-id]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const ev = events.find(ev => ev.id === el.dataset.dayEventId && (ev._instanceDate || '') === el.dataset.dayInstance)
              || events.find(ev => ev.id === el.dataset.dayEventId);
      if (ev) showEventDetail(ev);
    });
  });

  // Work event clicks
  body.querySelectorAll('[data-outlook-uid]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const ev = outlookEvents.find(ev => ev.uid === el.dataset.outlookUid && (ev._instanceDate || '') === el.dataset.dayInstance)
              || outlookEvents.find(ev => ev.uid === el.dataset.outlookUid);
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
    renderTagFilter();
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
  const firstDay    = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const todayStr    = localDateStr();

  // Helper: next day string
  function nextDay(ds) {
    const d = new Date(ds + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    return localDateStr(d);
  }

  // Normalize all events with date ranges, respecting work/personal toggles + tag filter
  const allEvs = [
    ...(showPersonal ? events
      .filter(e => !activeTag || (e.tags || '').split(',').map(t => t.trim()).includes(activeTag))
      .map(e => ({
        id: e.id, uid: null, title: e.title, color: e.color,
        _source: 'personal', _instanceDate: e._instanceDate || '',
        _startDate: e.start_time?.split('T')[0],
        _endDate: (e.end_time || e.start_time)?.split('T')[0],
      })) : []),
    ...(showWork ? outlookEvents.map(e => ({
      id: null, uid: e.uid, title: e.title, color: '#0EA5E9',
      _source: 'work', _instanceDate: e._instanceDate || '',
      _startDate: e.start_time?.split('T')[0],
      _endDate: (e.end_time || e.start_time)?.split('T')[0],
    })) : []),
  ].filter(e => e._startDate);

  // Build week rows: array of arrays of 7 date strings (null = padding)
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++)
    cells.push(`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i+7));

  const MAX_LANES = 3;

  let html = `<div class="cal-month-grid">${DAYS.map(d=>`<div class="cal-day-header">${d}</div>`).join('')}`;

  weeks.forEach(week => {
    const weekDates  = week.filter(Boolean);
    const weekStart  = weekDates[0];
    const weekEnd    = weekDates[weekDates.length - 1];

    // Events overlapping this week
    const weekEvs = allEvs
      .filter(e => e._startDate <= weekEnd && e._endDate >= weekStart)
      .map(e => ({
        ...e,
        clipStart:       e._startDate < weekStart ? weekStart : e._startDate,
        clipEnd:         e._endDate   > weekEnd   ? weekEnd   : e._endDate,
        continuesBefore: e._startDate < weekStart,
        continuesAfter:  e._endDate   > weekEnd,
      }))
      .sort((a, b) => {
        // Multi-day events first (longer spans → lower lane), then by start
        const spanA = week.indexOf(a.clipEnd) - week.indexOf(a.clipStart);
        const spanB = week.indexOf(b.clipEnd) - week.indexOf(b.clipStart);
        if (spanB !== spanA) return spanB - spanA;
        return a.clipStart.localeCompare(b.clipStart);
      });

    // Greedy lane assignment
    const laneEnds = [];
    const assigned = weekEvs.map(ev => {
      for (let lane = 0; ; lane++) {
        if (!laneEnds[lane] || laneEnds[lane] < ev.clipStart) {
          laneEnds[lane] = ev.clipEnd;
          return { ...ev, lane };
        }
      }
    });

    // Count overflows per day
    const overflow = {};
    weekDates.forEach(ds => { overflow[ds] = 0; });
    assigned.forEach(ev => {
      if (ev.lane >= MAX_LANES) {
        let ds = ev.clipStart;
        while (ds <= ev.clipEnd) {
          if (overflow[ds] !== undefined) overflow[ds]++;
          if (ds === weekEnd) break;
          ds = nextDay(ds);
        }
      }
    });

    // Week wrapper (spans all 7 grid columns, position:relative)
    html += `<div class="cal-week-wrapper">`;

    // Day cells
    html += `<div class="cal-week-cells">`;
    week.forEach(ds => {
      const isToday = ds === todayStr;
      const isOther = !ds;
      html += `<div class="cal-cell${isOther ? ' other-month' : ''}${isToday ? ' today' : ''}" data-date="${ds || ''}">`;
      if (ds) {
        html += `<div class="cal-cell-date">${parseInt(ds.split('-')[2])}</div>`;
        if (overflow[ds] > 0)
          html += `<div class="cal-cell-overflow" data-date="${ds}">+${overflow[ds]} more</div>`;
      }
      html += `</div>`;
    });
    html += `</div>`; // .cal-week-cells

    // Event bars (absolute, positioned within .cal-week-wrapper)
    assigned.filter(ev => ev.lane < MAX_LANES).forEach(ev => {
      const startIdx = week.indexOf(ev.clipStart);
      const endIdx   = week.indexOf(ev.clipEnd);
      if (startIdx === -1 || endIdx === -1) return;

      const leftPct  = (startIdx / 7 * 100).toFixed(3);
      const rightPct = ((6 - endIdx) / 7 * 100).toFixed(3);
      const topPx    = 26 + ev.lane * 22;

      const ml = ev.continuesBefore ? '0px' : '2px';
      const mr = ev.continuesAfter  ? '0px' : '2px';

      const capCls = `${!ev.continuesBefore ? ' bar-cap-l' : ''}${!ev.continuesAfter ? ' bar-cap-r' : ''}`;
      const dataAttr = ev._source === 'work'
        ? `data-outlook-uid="${ev.uid}" data-instance="${ev._instanceDate}"`
        : `data-event-id="${ev.id}" data-instance="${ev._instanceDate}"`;

      html += `<div class="cal-multiday-bar${capCls}"
        style="left:calc(${leftPct}% + ${ml});right:calc(${rightPct}% + ${mr});top:${topPx}px;background:${ev.color}"
        ${dataAttr}>${!ev.continuesBefore ? `<span class="cal-bar-title">${ev.title}</span>` : ''}</div>`;
    });

    html += `</div>`; // .cal-week-wrapper
  });

  html += '</div>';
  return html;
}

// ── Split view (week + day) ──
const HOURS = Array.from({length:16}, (_,i) => i+7); // 7am–10pm

// Time-grid constants (shared by renderTimeGrid + refreshDayModal)
const TG_START  = 7;
const TG_END    = 23;
const TG_NHOURS = TG_END - TG_START;
const TG_ROW_H  = 80;   // px per hour
const TG_TOTAL  = TG_NHOURS * TG_ROW_H;

// Build grid-line HTML for one column
function tgGridLines() {
  let s = '';
  for (let i = 0; i < TG_NHOURS; i++) {
    s += `<div class="dtg-hour-line" style="top:${i * TG_ROW_H}px"></div>`;
    s += `<div class="dtg-half-line" style="top:${i * TG_ROW_H + TG_ROW_H / 2}px"></div>`;
  }
  return s;
}

// Compute overlap columns so simultaneous events sit side-by-side
function tgLayout(evList) {
  const items = evList.map(e => {
    const start    = new Date(e.start_time);
    const end      = e.end_time ? new Date(e.end_time) : null;
    const startMin = start.getHours() * 60 + start.getMinutes() - TG_START * 60;
    const endMin   = end
      ? end.getHours() * 60 + end.getMinutes() - TG_START * 60
      : startMin + 60;
    return { e, startMin, endMin: Math.max(startMin + 15, endMin) };
  }).filter(item => item.endMin > 0 && item.startMin < TG_NHOURS * 60);

  items.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  const colEnds = [];
  items.forEach(item => {
    let col = colEnds.findIndex(end => end <= item.startMin);
    if (col === -1) col = colEnds.length;
    colEnds[col] = item.endMin;
    item.col = col;
  });

  items.forEach(item => {
    item.totalCols = items
      .filter(o => o.startMin < item.endMin && o.endMin > item.startMin)
      .reduce((m, o) => Math.max(m, o.col + 1), 1);
  });

  return items;
}

// Build one absolutely-positioned event block
function tgBlock(item, isWork, dataAttr) {
  const { e, startMin, endMin, col, totalCols } = item;
  const end    = e.end_time ? new Date(e.end_time) : null;
  const top    = (Math.max(0, startMin) / 60 * TG_ROW_H).toFixed(1);
  const height = Math.max(TG_ROW_H / 2, (endMin - Math.max(0, startMin)) / 60 * TG_ROW_H).toFixed(1);
  const color  = isWork ? '#0EA5E9' : e.color;
  const time   = `${formatTime(e.start_time)}${end ? ' – ' + formatTime(e.end_time) : ''}`;
  const posStyle = totalCols > 1
    ? `left:calc(${(col / totalCols * 100).toFixed(2)}% + 2px);width:calc(${(100 / totalCols).toFixed(2)}% - 4px);right:auto`
    : `left:3px;right:3px`;
  return `<div class="dtg-event" style="top:${top}px;height:${height}px;background:${color};${posStyle}" ${dataAttr(e)}>
    <span class="dtg-event-title">${e.title}</span>
    <span class="dtg-event-time">${time}</span>
  </div>`;
}

function getColumns(mode) {
  if (mode === 'week') {
    const d = new Date(cursor);
    d.setDate(d.getDate() - d.getDay());
    return Array.from({length:7}, (_, i) => { const c = new Date(d); c.setDate(c.getDate() + i); return c; });
  }
  return [new Date(cursor)];
}

function renderTimeGrid(mode, cols, sourceEvents, isWork) {
  const todayStr = localDateStr();

  // Time labels (left gutter)
  let labelsHtml = '';
  for (let h = TG_START; h < TG_END; h++) {
    const label = h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`;
    labelsHtml += `<div class="dtg-label" style="top:${(h - TG_START) * TG_ROW_H}px">${label}</div>`;
  }

  // Header row
  let headerHtml = `<div class="rtg-header">
    <div class="rtg-header-spacer"></div>`;
  cols.forEach(d => {
    const ds      = localDateStr(d);
    const isToday = ds === todayStr;
    headerHtml += `<div class="cal-col-header${isToday ? ' today' : ''}">
      <div>${DAYS[d.getDay()]}</div>
      <div class="cal-col-header-date">${d.getDate()}</div>
    </div>`;
  });
  headerHtml += `</div>`;

  // Day columns
  let colsHtml = '';
  cols.forEach(d => {
    const ds        = localDateStr(d);
    const dayEvents = sourceEvents.filter(e => {
      if (!e.start_time?.includes('T')) return false;
      const eDate = e.start_time.split('T')[0];
      return eDate === ds;
    });
    const laid = tgLayout(dayEvents);
    const dataAttr = isWork
      ? e => `data-outlook-uid="${e.uid}" data-instance="${e._instanceDate || ''}"`
      : e => `data-event-id="${e.id}" data-instance="${e._instanceDate || ''}"`;
    const colClass = isWork ? 'dtg-col' : 'dtg-col dtg-pers-col';
    const colData  = isWork ? '' : `data-date="${ds}"`;
    colsHtml += `<div class="${colClass}" ${colData}>
      ${tgGridLines()}
      ${laid.map(item => tgBlock(item, isWork, dataAttr)).join('')}
    </div>`;
  });

  return `<div class="rtg-container">
    ${headerHtml}
    <div class="dtg-wrap" style="height:${TG_TOTAL}px">
      <div class="dtg-labels">${labelsHtml}</div>
      ${colsHtml}
    </div>
  </div>`;
}

function renderSplitView(mode) {
  const cols = getColumns(mode);
  const filtPersonal = events.filter(e =>
    !activeTag || (e.tags || '').split(',').map(t => t.trim()).includes(activeTag)
  );

  if (!showWork && !showPersonal) {
    return `<div style="text-align:center;padding:60px 20px;color:var(--text-3)">All events hidden — use the toggles above to show events.</div>`;
  }
  if (!showWork) {
    return `<div class="cal-split-wrapper">
      <div class="cal-split-panel">
        <div class="cal-split-header personal-header">🏠 Personal — Cerebro</div>
        ${renderTimeGrid(mode, cols, filtPersonal, false)}
      </div>
    </div>`;
  }
  if (!showPersonal) {
    return `<div class="cal-split-wrapper">
      <div class="cal-split-panel">
        <div class="cal-split-header work-header">🏢 Work — Outlook</div>
        ${renderTimeGrid(mode, cols, outlookEvents, true)}
      </div>
    </div>`;
  }
  return `<div class="cal-split-wrapper">
    <div class="cal-split-panel">
      <div class="cal-split-header work-header">🏢 Work — Outlook</div>
      ${renderTimeGrid(mode, cols, outlookEvents, true)}
    </div>
    <div class="cal-split-divider"></div>
    <div class="cal-split-panel">
      <div class="cal-split-header personal-header">🏠 Personal — Cerebro</div>
      ${renderTimeGrid(mode, cols, filtPersonal, false)}
    </div>
  </div>`;
}

// ── Click handlers ──
function attachCellClicks() {
  // Month cell → day modal
  document.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
    if (!cell.dataset.date) return;
    cell.addEventListener('click', e => {
      if (e.target.closest('[data-event-id],[data-outlook-uid],.cal-cell-overflow')) return;
      openDayModal(cell.dataset.date);
    });
  });

  // Overflow badge → day modal
  document.querySelectorAll('.cal-cell-overflow[data-date]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openDayModal(el.dataset.date);
    });
  });

  // Personal day columns → click to add event (absolute position → compute time from Y offset)
  document.querySelectorAll('.dtg-col.dtg-pers-col[data-date]').forEach(col => {
    col.addEventListener('click', e => {
      if (e.target.closest('[data-event-id]')) return;
      const rect   = col.getBoundingClientRect();
      const y      = e.clientY - rect.top;
      const raw    = y / TG_ROW_H * 60 + TG_START * 60;
      const snapped = Math.min(Math.max(0, Math.round(raw / 15) * 15), TG_END * 60 - 15);
      const hh     = String(Math.floor(snapped / 60)).padStart(2, '0');
      const mm     = String(snapped % 60).padStart(2, '0');
      openEventModal({ date: col.dataset.date, startTime: `${hh}:${mm}` });
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

// ── Timezone abbreviation for a given date (uses device locale/tz, handles DST) ──
function tzAbbr(date) {
  return new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(date).find(p => p.type === 'timeZoneName')?.value || '';
}

// ── Personal event detail ──
function showEventDetail(ev) {
  document.getElementById('detail-color-dot').style.background = ev.color;
  document.getElementById('detail-title').textContent = ev.title;

  const start = ev.start_time ? new Date(ev.start_time) : null;
  const end   = ev.end_time   ? new Date(ev.end_time)   : null;

  let body = '';
  if (start) body += `<p style="font-size:13px;color:var(--text-2);margin-bottom:8px">📅 ${start.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}<br>🕐 ${formatTime(ev.start_time)}${end ? ' – ' + formatTime(ev.end_time) : ''} <span style="font-size:11px;color:var(--text-3)">${tzAbbr(start)}</span></p>`;
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
      🕐 ${formatTime(ev.start_time)}${end ? ' – ' + formatTime(ev.end_time) : ''} <span style="font-size:11px;color:var(--text-3)">${tzAbbr(start)}</span>
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
    const evStartDate = ev.start_time?.split('T')[0];
    const evEndDate   = ev.end_time?.split('T')[0];
    openEventModal({
      id: ev.id, title: ev.title, description: ev.description,
      date: evStartDate,
      endDate: evEndDate !== evStartDate ? evEndDate : '',
      startTime: ev.start_time ? new Date(ev.start_time).toTimeString().slice(0,5) : '',
      endTime:   ev.end_time   ? new Date(ev.end_time).toTimeString().slice(0,5)   : '',
      location: ev.location, color: ev.color, isImportant: ev.is_important,
      recurrenceType: ev.recurrence_type, recurrenceEnd: ev.recurrence_end,
      tags: ev.tags || '',
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
  const evStartDate = ev.start_time?.split('T')[0];
  const evEndDate   = ev.end_time?.split('T')[0];
  openEventModal({
    id: ev.id, _instanceDate: ev._instanceDate || evStartDate,
    _parentId: ev.parent_event_id || ev.id, title: ev.title, description: ev.description,
    date: evStartDate,
    endDate: evEndDate !== evStartDate ? evEndDate : '',
    startTime: ev.start_time ? new Date(ev.start_time).toTimeString().slice(0,5) : '',
    endTime:   ev.end_time   ? new Date(ev.end_time).toTimeString().slice(0,5)   : '',
    location: ev.location, color: ev.color, isImportant: !!ev.is_important,
    recurrenceType: 'NONE', tags: ev.tags || '',
  });
};
window.editSeries = function(id, ev) {
  const evStartDate = ev.start_time?.split('T')[0];
  const evEndDate   = ev.end_time?.split('T')[0];
  openEventModal({
    id, title: ev.title, description: ev.description,
    date: evStartDate,
    endDate: evEndDate !== evStartDate ? evEndDate : '',
    startTime: ev.start_time ? new Date(ev.start_time).toTimeString().slice(0,5) : '',
    location: ev.location, color: ev.color, isImportant: !!ev.is_important,
    recurrenceType: ev.recurrence_type, recurrenceEnd: ev.recurrence_end,
    tags: ev.tags || '',
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
  cursor = new Date();
  if (calView !== 'day') cursor.setDate(1);
  loadEvents();
});

document.getElementById('add-event-btn').addEventListener('click', () => openEventModal({ date: localDateStr(cursor) }));

// ── Swipe navigation (mobile) ──
let _swipeX = 0, _swipeY = 0;
document.getElementById('cal-content').addEventListener('touchstart', e => {
  _swipeX = e.touches[0].clientX;
  _swipeY = e.touches[0].clientY;
}, { passive: true });
document.getElementById('cal-content').addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - _swipeX;
  const dy = e.changedTouches[0].clientY - _swipeY;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    if (dx < 0) document.getElementById('next-btn').click();
    else         document.getElementById('prev-btn').click();
  }
}, { passive: true });

// ── Work / Personal toggles ──
function applyToggleUI() {
  document.getElementById('toggle-work').classList.toggle('active', showWork);
  document.getElementById('toggle-personal').classList.toggle('active', showPersonal);
}
document.getElementById('toggle-work').addEventListener('click', () => {
  showWork = !showWork;
  localStorage.setItem('cal_show_work', showWork);
  applyToggleUI();
  render();
});
document.getElementById('toggle-personal').addEventListener('click', () => {
  showPersonal = !showPersonal;
  localStorage.setItem('cal_show_personal', showPersonal);
  applyToggleUI();
  render();
});
applyToggleUI();

// ── Tag filter dropdown ──
let _tagDropdownOpen = false;
function renderTagFilter() {
  const allTags = [...new Set(
    events.flatMap(e => (e.tags || '').split(',').map(t => t.trim()).filter(Boolean))
  )].sort();

  const pills   = document.getElementById('cal-tag-pills');
  const empty   = document.getElementById('cal-tag-empty');
  const label   = document.getElementById('cal-tag-label');
  const btn     = document.getElementById('cal-tag-btn');

  // Update label / button highlight
  label.textContent = activeTag ? activeTag : 'Tags';
  btn.classList.toggle('cal-tag-btn-active', !!activeTag);

  if (!allTags.length) {
    pills.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    pills.innerHTML = [
      ...(activeTag ? [`<button class="filter-pill active" data-tag="">✕ Clear filter</button>`] : []),
      ...allTags.map(t => `<button class="filter-pill${activeTag === t ? ' active' : ''}" data-tag="${t}">${t}</button>`),
    ].join('');
    pills.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTag = btn.dataset.tag; // '' for clear
        localStorage.setItem('cal_active_tag', activeTag);
        closeTagDropdown();
        renderTagFilter();
        render();
      });
    });
  }
}

function closeTagDropdown() {
  _tagDropdownOpen = false;
  document.getElementById('cal-tag-dropdown').classList.remove('open');
}

document.getElementById('cal-tag-btn').addEventListener('click', e => {
  e.stopPropagation();
  _tagDropdownOpen = !_tagDropdownOpen;
  document.getElementById('cal-tag-dropdown').classList.toggle('open', _tagDropdownOpen);
});

document.addEventListener('click', e => {
  if (!e.target.closest('#cal-tag-dropdown-wrap')) closeTagDropdown();
});

// ── Init ──
loadEvents();
loadSyncStatus();
