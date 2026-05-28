/**
 * Trip-restaurants render module — pool-based picker.
 *
 * Vanilla ES module. No React, no build step, no dependencies.
 *
 *   import { mountDiningTab } from '@jhwiv/trip-restaurants';
 *   mountDiningTab({
 *     dataset: await (await fetch('santa-fe.json')).json(),
 *     mount:   document.querySelector('#dining'),
 *     storageKey: 'santafe',  // base key; module derives -picks / -bookings / -notes
 *   });
 *
 * The data model exposes a single restaurant pool (dataset.restaurants[]) tagged
 * by tier. Each night shows the full pool grouped by tier. Nothing is preselected.
 * Same restaurant can be picked for multiple nights.
 */

// ---------- public API ----------

export function mountDiningTab({ dataset, mount, storageKey = 'trip-restaurants' }) {
  const state = new PickerState(dataset, storageKey);
  const root = el('div', { class: 'tr-dining' });
  const rerenderAll = () => {
    root.innerHTML = '';
    root.append(renderHeader(dataset, state, rerenderAll));
    root.append(renderGlobalFilters(dataset, state, rerenderAll));
    root.append(renderNights(dataset, state));
  };
  rerenderAll();
  mount.innerHTML = '';
  mount.append(root);
  return state;
}

// ---------- global filter state (cross-night) ----------
const globalFilterState = {
  walkable: false,
  openOnly: true,
  tiers: new Set(),
};

// Per-night tier selection (keyed by night.date). When set, the night shows
// a list of restaurants in that tier. When null, the night shows the
// three-tier picker.
const nightTierSelection = new Map();

function renderGlobalFilters(dataset, state, rerenderAll) {
  const bar = el('div', { class: 'tr-global-filters' });
  bar.append(el('p', { class: 'tr-global-filters-label' }, 'Filter all nights:'));
  const f = globalFilterState;
  const makeChip = (label, isActive, onClick) => {
    const chip = el('button', {
      type: 'button',
      class: `tr-filter-chip ${isActive ? 'is-active' : ''}`,
    }, label);
    chip.addEventListener('click', (e) => { e.preventDefault(); onClick(); rerenderAll(); });
    return chip;
  };
  bar.append(makeChip('Open that night', f.openOnly, () => { f.openOnly = !f.openOnly; }));
  bar.append(makeChip('Walkable from hotel', f.walkable, () => { f.walkable = !f.walkable; }));
  const tierOrder = ['refined', 'elevated', 'signature'];
  for (const t of tierOrder) {
    const def = dataset.tiers?.[t]; if (!def) continue;
    const isActive = f.tiers.has(t);
    bar.append(makeChip(`${def.label} ${def.priceBand}`, isActive, () => {
      if (isActive) f.tiers.delete(t); else f.tiers.add(t);
    }));
  }
  if (f.walkable || !f.openOnly || f.tiers.size) {
    const clear = el('button', { type: 'button', class: 'tr-filter-chip tr-filter-chip-clear' }, 'Clear');
    clear.addEventListener('click', (e) => {
      e.preventDefault();
      f.walkable = false; f.openOnly = true; f.tiers.clear();
      rerenderAll();
    });
    bar.append(clear);
  }
  return bar;
}

/** Render just the reservation timeline (urgent → less urgent) from currently picked restaurants. */
export function mountReservationTimeline({ dataset, mount, storageKey = 'trip-restaurants' }) {
  const state = new PickerState(dataset, storageKey);
  const root = el('div', { class: 'tr-timeline' });
  const rerender = () => { root.innerHTML = ''; root.append(renderTimeline(dataset, state)); };
  rerender();
  state.subscribe(rerender);
  mount.innerHTML = '';
  mount.append(root);
  return state;
}

/** Deep-link builder. Exported so host apps can reuse it for "add to calendar" / SMS reservation reminders. */
export function buildBookingUrl(restaurant, night, party) {
  const b = restaurant.booking || {};
  if (!b.url || !b.platform) return null;
  const url = new URL(b.url);
  const time = (night?.time || party?.defaultTime || '19:00').replace(/\s*(AM|PM)$/i, '');
  const date = night?.date;
  const size = party?.size || 1;
  if (!date) return b.url;
  if (b.platform === 'opentable') {
    // OpenTable: ?dateTime=YYYY-MM-DDTHH:MM:SS&covers=N
    const hh = toHHMM(time);
    url.searchParams.set('dateTime', `${date}T${hh}:00`);
    url.searchParams.set('covers', String(size));
  } else if (b.platform === 'resy') {
    // Resy: ?date=YYYY-MM-DD&seats=N
    url.searchParams.set('date', date);
    url.searchParams.set('seats', String(size));
  }
  return url.toString();
}

// ---------- state ----------

class PickerState {
  constructor(dataset, baseKey) {
    this.dataset = dataset;
    this.keys = {
      picks:    `${baseKey}-picks`,    // { 'YYYY-MM-DD': 'restaurant-id' }
      bookings: `${baseKey}-bookings`, // { 'YYYY-MM-DD': { confirmation, bookedAt } }
      notes:    `${baseKey}-notes`,    // { 'YYYY-MM-DD': 'free text' }
      party:    `${baseKey}-party`,    // { size, defaultTime }
    };
    this.picks    = this._loadObj(this.keys.picks);
    this.bookings = this._loadObj(this.keys.bookings);
    this.notes    = this._loadObj(this.keys.notes);

    // One-time migration: tier-picker release no longer pre-seeds curated
    // picks, but earlier sessions saved 7 default picks to localStorage.
    // Clear those once so users see the new empty / tier-picker state.
    // Picks the user actively saved after the migration ran are preserved.
    if (typeof localStorage !== 'undefined') {
      const migKey = `${baseKey}-mig-tierpicker-2026-05`;
      try {
        if (!localStorage.getItem(migKey)) {
          const validIds = new Set((dataset.restaurants || []).map(r => r.id));
          // If every saved pick maps to a valid restaurant AND looks like the
          // old curated seed (one pick per night, all 7 set), drop them.
          const nightDates = new Set((dataset.nights || []).map(n => n.date));
          const pickEntries = Object.entries(this.picks);
          const allOnTripNights = pickEntries.every(([d]) => nightDates.has(d));
          const allValidIds = pickEntries.every(([, id]) => validIds.has(id));
          const looksLikeSeed = pickEntries.length === (dataset.nights || []).length && pickEntries.length > 0 && allOnTripNights && allValidIds && Object.keys(this.bookings).length === 0;
          if (looksLikeSeed) {
            this.picks = {};
            this._save(this.keys.picks, this.picks);
          }
          localStorage.setItem(migKey, '1');
        }
      } catch {}
    }
    // Party overrides — start from dataset default, then merge stored
    this.party    = Object.assign(
      { size: 1, defaultTime: '19:00' },
      dataset.trip?.party || {},
      this._loadObj(this.keys.party),
    );
    this._subs = new Set();
  }
  resetAll() {
    this.picks = {};
    this.bookings = {};
    this.notes = {};
    this._save(this.keys.picks, this.picks);
    this._save(this.keys.bookings, this.bookings);
    this._save(this.keys.notes, this.notes);
    if (typeof localStorage !== 'undefined') {
      try { localStorage.removeItem(`${this.keys.picks}-seeded`); } catch {}
    }
    this._notify();
  }
  pickFor(night)            { return this.picks[night.date] || null; }
  setPick(night, restId)    { if (restId) this.picks[night.date] = restId; else delete this.picks[night.date]; this._save(this.keys.picks, this.picks); this._notify(); }
  bookingFor(night)         { return this.bookings[night.date] || null; }
  setBooked(night, info)    { if (info) this.bookings[night.date] = info; else delete this.bookings[night.date]; this._save(this.keys.bookings, this.bookings); this._notify(); }
  noteFor(night)            { return this.notes[night.date] || ''; }
  setNote(night, text)      { if (text) this.notes[night.date] = text; else delete this.notes[night.date]; this._save(this.keys.notes, this.notes); /* no full notify — notes don't change timeline */ }
  setParty(partial)         { Object.assign(this.party, partial); this._save(this.keys.party, this.party); this._notify(); }
  subscribe(fn)             { this._subs.add(fn); return () => this._subs.delete(fn); }
  _notify()                 { for (const fn of this._subs) fn(this); }
  _loadObj(k) {
    if (typeof localStorage === 'undefined') return {};
    try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; }
  }
  _save(k, v) {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }
}

// ---------- date helpers ----------

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

function weekdayOf(dateStr) {
  // Parse YYYY-MM-DD as a *local* date (no UTC shift). Returns 'mon'..'sun'.
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return DAY_KEYS[wd];
}

function isOpenOn(restaurant, weekday) {
  const open = restaurant.hours?.openDays;
  if (!open || !open.length) return true; // unknown → assume open
  return open.includes(weekday);
}

function toHHMM(t) {
  // Accept '7:00 PM', '19:00', '7pm', etc. → 'HH:MM'.
  if (!t) return '19:00';
  const s = String(t).trim().toLowerCase();
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return `${pad(m[1])}:${m[2]}`;
  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m) {
    let h = Number(m[1]); const min = m[2] || '00'; const ap = m[3];
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return `${pad(h)}:${min}`;
  }
  return '19:00';
}
function pad(n) { return String(n).padStart(2, '0'); }

// ---------- ICS / Add-to-Calendar ----------
// Builds a single VEVENT for the booked dinner and triggers a file download.
// Format: floating local time (no TZID) so it lands at the same wall-clock
// time regardless of which calendar the user imports it into.
function toIcsLocal(date, hhmm) {
  // date: 'YYYY-MM-DD', hhmm: 'HH:MM' → 'YYYYMMDDTHHMMSS'
  return date.replace(/-/g, '') + 'T' + hhmm.replace(':', '') + '00';
}
function addHours(date, hhmm, hours) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const dt = new Date(y, m - 1, d, h, mi);
  dt.setHours(dt.getHours() + hours);
  return {
    date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
    hhmm: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
  };
}
function icsEscape(s) {
  return String(s || '').replace(/[\\;,]/g, '\\$&').replace(/\n/g, '\\n');
}
function downloadIcs(restaurant, night, state, booking) {
  const time = toHHMM(night?.time || state.party?.defaultTime || '19:00');
  const startStr = toIcsLocal(night.date, time);
  const end = addHours(night.date, time, 2); // assume 2-hour dinner
  const endStr = toIcsLocal(end.date, end.hhmm);
  const uid = `${restaurant.id}-${night.date}@trip-restaurants`;
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const partySize = state.party?.size || 1;
  const descLines = [
    `Reservation for ${partySize}`,
    booking?.confirmation ? `Confirmation: ${booking.confirmation}` : '',
    restaurant.phone ? `Phone: ${formatPhone(restaurant.phone)}` : '',
    restaurant.website ? `Web: ${restaurant.website}` : '',
    restaurant.booking?.note || '',
  ].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//trip-restaurants//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${startStr}`,
    `DTEND:${endStr}`,
    `SUMMARY:${icsEscape('Dinner · ' + restaurant.name)}`,
    restaurant.address ? `LOCATION:${icsEscape(restaurant.address)}` : '',
    `DESCRIPTION:${icsEscape(descLines)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  const blob = new Blob([lines], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${restaurant.id}-${night.date}.ics`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

function bookDeadlineFor(restaurant, night) {
  // Compute the "book by" date given the trip date and the restaurant's lead time.
  const lead = (restaurant.booking?.leadTime || '').toLowerCase();
  const [y, m, d] = night.date.split('-').map(Number);
  const tripDate = new Date(y, m - 1, d);
  const sub = (days) => { const x = new Date(tripDate); x.setDate(x.getDate() - days); return x; };
  if (lead.includes('3') && lead.includes('week')) return sub(21);
  if (lead.includes('2') && lead.includes('week')) return sub(14);
  if (lead.includes('week')) return sub(7);
  if (lead.includes('day')) return sub(2);
  return sub(7); // default cushion
}

function formatShortDate(dt) {
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------- render: header ----------

function renderHeader(dataset, state, onChange) {
  const wrap = el('div', { class: 'tr-header' });
  // (Section heading + intro are rendered by the host page's .lede;
  // don't duplicate them here.)

  // Party-size + default-time controls. These drive deep-link prefills.
  const config = el('div', { class: 'tr-trip-config' });
  const partyLabel = el('label', { class: 'tr-config-label', for: 'tr-party-size' }, 'Party size');
  const partyInput = el('input', {
    id: 'tr-party-size',
    type: 'number',
    min: '1',
    max: '12',
    class: 'tr-config-input tr-config-input-num',
    'aria-label': 'Party size',
  });
  partyInput.value = state.party.size;
  partyInput.addEventListener('change', () => {
    const n = Math.max(1, Math.min(12, Number(partyInput.value) || 2));
    state.setParty({ size: n });
    partyInput.value = n;
    onChange();
  });
  const timeLabel = el('label', { class: 'tr-config-label', for: 'tr-default-time' }, 'Default dinner time');
  const timeInput = el('input', {
    id: 'tr-default-time',
    type: 'time',
    class: 'tr-config-input tr-config-input-time',
    'aria-label': 'Default dinner time',
  });
  timeInput.value = toHHMM(state.party.defaultTime || '19:00');
  timeInput.addEventListener('change', () => {
    state.setParty({ defaultTime: timeInput.value || '19:00' });
    onChange();
  });
  config.append(
    el('div', { class: 'tr-config-group' }, partyLabel, partyInput),
    el('div', { class: 'tr-config-group' }, timeLabel, timeInput),
  );
  wrap.append(config);

  const legend = el('div', { class: 'tr-legend' });
  for (const [id, t] of Object.entries(dataset.tiers || {})) {
    legend.append(el('div', { class: `tr-legend-item tr-legend-${id}` },
      el('span', { class: 'tr-legend-label' }, t.label),
      el('span', { class: 'tr-legend-band' }, t.priceBand),
      t.blurb ? el('span', { class: 'tr-legend-blurb' }, t.blurb) : null,
    ));
  }
  wrap.append(legend);
  return wrap;
}

// ---------- render: per-night cards ----------

function renderNights(dataset, state) {
  const wrap = el('div', { class: 'tr-nights' });
  for (const night of dataset.nights) {
    wrap.append(renderNightCard(dataset, night, state));
  }
  return wrap;
}

function renderNightCard(dataset, night, state) {
  // Each night is a <details> element — collapsed by default unless the user
  // has already picked a restaurant for it.
  const pickId = state.pickFor(night);
  const card = el('details', {
    class: 'tr-night',
    'data-date': night.date,
    ...(pickId ? { open: 'open' } : {}),
  });
  const rerender = () => {
    const fresh = renderNightCard(dataset, night, state);
    // Preserve open state on re-render
    if (card.open) fresh.setAttribute('open', 'open');
    card.replaceWith(fresh);
  };

  card.append(renderNightSummary(dataset, night, state));
  const body = el('div', { class: 'tr-night-body' });
  if (pickId) {
    // User has chosen — show picked card + backup suggestion + note
    body.append(renderPickedBlock(dataset, night, state, rerender));
    body.append(renderBackupBlock(dataset, night, state, rerender));
  } else {
    // No pick yet. Two sub-states:
    //   1. No tier chosen → show 3-tier picker ($$ / $$$ / $$$$)
    //   2. Tier chosen   → show compact list of restaurants in that tier
    const tier = nightTierSelection.get(night.date);
    if (!tier) {
      body.append(renderTierPicker(dataset, night, state, rerender));
    } else {
      body.append(renderTierList(dataset, night, state, tier, rerender));
    }
  }
  body.append(renderNoteBlock(night, state));
  card.append(body);
  return card;
}

// ---------- Tier picker (shown when no pick + no tier selected) ----------
function renderTierPicker(dataset, night, state, rerender) {
  const block = el('div', { class: 'tr-tier-picker' });
  block.append(el('p', { class: 'tr-tier-picker-label' }, 'Start by choosing a price tier:'));
  const grid = el('div', { class: 'tr-tier-grid' });
  const tierOrder = ['refined', 'elevated', 'signature'];
  for (const tid of tierOrder) {
    const def = dataset.tiers?.[tid]; if (!def) continue;
    // Count restaurants available for this night in that tier
    const count = restaurantsFor(dataset, night, tid).length;
    const card = el('button', { type: 'button', class: `tr-tier-card tier-${tid}` });
    card.append(el('span', { class: 'tr-tier-band' }, def.priceBand || ''));
    card.append(el('span', { class: 'tr-tier-name' }, def.label || tid));
    if (def.blurb)    card.append(el('span', { class: 'tr-tier-blurb' }, def.blurb));
    if (def.leadTime) card.append(el('span', { class: 'tr-tier-lead' }, 'Book ' + def.leadTime));
    card.append(el('span', { class: 'tr-tier-count' }, count + ' option' + (count === 1 ? '' : 's')));
    card.addEventListener('click', (e) => {
      e.preventDefault();
      nightTierSelection.set(night.date, tid);
      rerender();
    });
    grid.append(card);
  }
  block.append(grid);
  return block;
}

// ---------- Tier list (after a tier is selected) ----------
function restaurantsFor(dataset, night, tier) {
  const weekday = weekdayOf(night.date);
  return (dataset.restaurants || []).filter(r => {
    if (r.tier !== tier) return false;
    if (!isOpenOn(r, weekday)) return false;
    return true;
  });
}

function renderTierList(dataset, night, state, tier, rerender) {
  const block = el('div', { class: 'tr-tier-list-block' });
  const def = dataset.tiers?.[tier] || {};
  const head = el('div', { class: 'tr-tier-list-head' });
  const back = el('button', { type: 'button', class: 'tr-tier-list-back' }, '← Tiers');
  back.addEventListener('click', (e) => {
    e.preventDefault();
    nightTierSelection.delete(night.date);
    rerender();
  });
  head.append(back);
  head.append(el('span', { class: 'tr-tier-list-title' },
    (def.label || tier) + ' · ' + (def.priceBand || '')));
  block.append(head);

  const items = restaurantsFor(dataset, night, tier);
  if (!items.length) {
    block.append(el('p', { class: 'tr-tier-list-empty' },
      'No ' + (def.label || tier).toLowerCase() + ' spots are open that night. Try another tier.'));
    return block;
  }
  // Sort: walkable first (by walk minutes), then by name
  items.sort((a, b) => {
    const ta = a.travelFromHotel, tb = b.travelFromHotel;
    const aw = ta?.mode === 'walk' ? 0 : 1;
    const bw = tb?.mode === 'walk' ? 0 : 1;
    if (aw !== bw) return aw - bw;
    const am = ta?.walkMinutes ?? ta?.driveMinutes ?? 999;
    const bm = tb?.walkMinutes ?? tb?.driveMinutes ?? 999;
    if (am !== bm) return am - bm;
    return a.name.localeCompare(b.name);
  });
  const list = el('ul', { class: 'tr-tier-list' });
  for (const r of items) list.append(renderTierListRow(dataset, r, night, state, rerender));
  block.append(list);
  return block;
}

function renderTierListRow(dataset, r, night, state, rerender) {
  const li = el('li', { class: 'tr-tier-row', tabindex: '0', role: 'button',
    'aria-label': 'Choose ' + r.name + ' for this night' });
  const main = el('div', { class: 'tr-tier-row-main' });
  main.append(el('p', { class: 'tr-tier-row-name' }, r.name));
  const meta = el('p', { class: 'tr-tier-row-meta' });
  const t = r.travelFromHotel;
  if (t?.label) {
    const span = el('span', { class: 'tr-tier-row-distance tr-mode-' + (t.mode || 'unknown') }, t.label);
    meta.append(span);
  }
  // Reservation method
  const platform = (r.booking?.platform || '').toLowerCase();
  const platformLabel = ({
    opentable: 'OpenTable',
    resy: 'Resy',
    phone: 'Phone',
    yelp: 'Yelp',
    sevenrooms: 'SevenRooms',
    walkin: 'Walk-in',
  })[platform] || (platform ? platform[0].toUpperCase() + platform.slice(1) : 'Reservation');
  meta.append(el('span', { class: 'tr-tier-row-book' }, ' · ' + platformLabel));
  if (r.cuisine) meta.append(el('span', { class: 'tr-tier-row-cuisine' }, ' · ' + r.cuisine));
  main.append(meta);
  li.append(main);
  li.append(el('span', { class: 'tr-tier-row-chevron' }, '›'));
  const pick = (e) => {
    e.preventDefault();
    state.setPick(night, r.id);
    nightTierSelection.delete(night.date);
    rerender();
  };
  li.addEventListener('click', pick);
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') pick(e);
  });
  return li;
}

function renderNightSummary(dataset, night, state) {
  const summary = el('summary', { class: 'tr-night-summary' });
  const left = el('div', { class: 'tr-night-summary-left' });
  left.append(el('p', { class: 'tr-night-date' }, night.label || night.date));
  const sub = el('p', { class: 'tr-night-sub' });
  if (night.theme) sub.append(el('span', { class: 'tr-night-theme' }, night.theme));
  if (night.time)  sub.append(el('span', { class: 'tr-night-time' }, ' · ' + night.time));
  left.append(sub);
  summary.append(left);

  const right = el('div', { class: 'tr-night-summary-right' });
  const pickId = state.pickFor(night);
  const booking = state.bookingFor(night);
  if (pickId) {
    const r = dataset.restaurants.find(x => x.id === pickId);
    if (r) {
      const label = booking ? '✓ Booked' : 'Picked';
      right.append(el('span', { class: `tr-night-status ${booking ? 'is-booked' : 'is-picked'}` }, label));
      right.append(el('span', { class: 'tr-night-pick-name' }, r.name));
    }
  } else {
    right.append(el('span', { class: 'tr-night-status is-empty' }, 'Tap to choose'));
  }
  summary.append(right);
  return summary;
}

function renderSuggestionsBlock(dataset, night, state, rerender) {
  const recId = night.recommended;
  const backupId = night.backup;
  const recR = recId ? dataset.restaurants.find(x => x.id === recId) : null;
  const backupR = backupId ? dataset.restaurants.find(x => x.id === backupId) : null;
  const block = el('div', { class: 'tr-suggestions-block' });
  if (!recR && !backupR) return block;
  block.append(el('p', { class: 'tr-suggestions-label' }, 'Our picks for this night'));
  const grid = el('div', { class: 'tr-suggestions-grid' });
  if (recR)    grid.append(renderSuggestionCard(dataset, recR, night, state, rerender, 'Editor’s pick'));
  if (backupR) grid.append(renderSuggestionCard(dataset, backupR, night, state, rerender, 'Backup'));
  block.append(grid);
  return block;
}

function renderSuggestionCard(dataset, r, night, state, rerender, badgeLabel) {
  const card = el('div', { class: `tr-suggestion tier-${r.tier}`, 'data-id': r.id });
  card.append(el('span', { class: `tr-suggestion-badge tr-suggestion-badge-${badgeLabel === 'Backup' ? 'backup' : 'rec'}` }, badgeLabel));
  const head = el('div', { class: 'tr-restaurant-head' });
  head.append(el('h3', { class: 'tr-name' }, r.name));
  const tierDef = dataset.tiers[r.tier];
  if (tierDef) head.append(el('span', { class: `tr-tier-chip tr-tier-chip-${r.tier}` }, tierDef.priceBand));
  card.append(head);
  const meta = el('p', { class: 'tr-meta' });
  if (r.cuisine) meta.append(el('span', {}, r.cuisine));
  if (r.neighborhood) meta.append(el('span', {}, ' · ' + r.neighborhood));
  card.append(meta);
  if (r.notes?.length) card.append(el('p', { class: 'tr-suggestion-note' }, r.notes[0]));
  const pickBtn = el('button', { type: 'button', class: 'tr-btn-pick-suggestion' }, `Pick ${r.name.split(/[—·]/)[0].trim()}`);
  pickBtn.addEventListener('click', () => {
    state.setPick(night, r.id);
    state.setBooked(night, null);
    rerender();
  });
  card.append(pickBtn);
  const wd = weekdayOf(night.date);
  if (!isOpenOn(r, wd)) {
    card.append(el('p', { class: 'tr-closed-warning' }, `⚠ Closed ${DAY_LABELS[wd]}s`));
  }
  return card;
}

function renderBackupBlock(dataset, night, state, rerender) {
  // Render the curated backup restaurant for this night, if any.
  // Hidden when the user's current pick IS the backup (no point showing twice).
  const backupId = night.backup;
  if (!backupId) return el('div', { class: 'tr-backup-empty' });
  const pickId = state.pickFor(night);
  if (pickId === backupId) return el('div', { class: 'tr-backup-empty' });
  const r = dataset.restaurants.find(x => x.id === backupId);
  if (!r) return el('div', { class: 'tr-backup-empty' });
  const block = el('div', { class: 'tr-backup-block' });
  block.append(el('p', { class: 'tr-backup-label' },
    el('span', { class: 'tr-backup-chip' }, 'Backup'),
    el('span', { class: 'tr-backup-label-text' }, ' · If your first choice falls through'),
  ));
  block.append(renderBackupCard(dataset, r, night, state, rerender));
  return block;
}

function renderBackupCard(dataset, r, night, state, rerender) {
  const card = el('div', { class: `tr-restaurant tr-restaurant-backup tier-${r.tier}`, 'data-id': r.id });
  card.append(renderRestaurantHead(dataset, r));
  if (r.notes?.length) {
    const ul = el('ul', { class: 'tr-notes' });
    for (const n of r.notes.slice(0, 2)) ul.append(el('li', {}, n));
    card.append(ul);
  }
  const actions = el('div', { class: 'tr-actions' });
  actions.append(renderBookingButton(r, night, state));
  if (r.phone) actions.append(el('a', { class: 'tr-btn-secondary', href: 'tel:' + r.phone }, formatPhone(r.phone)));
  if (r.website) actions.append(el('a', { class: 'tr-btn-link', href: r.website, target: '_blank', rel: 'noopener' }, 'Website ↗'));
  card.append(actions);
  // Promote backup to be the primary pick
  const promote = el('button', { type: 'button', class: 'tr-btn-promote' }, 'Use this instead');
  promote.addEventListener('click', () => {
    state.setPick(night, r.id);
    state.setBooked(night, null);
    rerender();
  });
  card.append(promote);
  // Closed-day warning (defensive)
  const wd = weekdayOf(night.date);
  if (!isOpenOn(r, wd)) {
    card.append(el('p', { class: 'tr-closed-warning' },
      `⚠ ${r.name} is closed ${DAY_LABELS[wd]}s — call to confirm.`));
  }
  return card;
}

function renderNightHeader(night, state) {
  const h = el('header', { class: 'tr-night-head' });
  h.append(el('p', { class: 'tr-night-date' }, night.label || night.date));
  const sub = el('p', { class: 'tr-night-sub' });
  if (night.theme) sub.append(el('span', { class: 'tr-night-theme' }, night.theme));
  if (night.time)  sub.append(el('span', { class: 'tr-night-time' }, ' · ' + night.time));
  sub.append(el('span', { class: 'tr-night-party' }, ` · Party of ${state.party.size}`));
  h.append(sub);
  return h;
}

function renderPickedBlock(dataset, night, state, rerender) {
  const pickId = state.pickFor(night);
  const block = el('div', { class: 'tr-picked-block' });
  if (!pickId) {
    // No empty-state text — suggestion cards render right below and explain themselves.
    return block;
  }
  const restaurant = dataset.restaurants.find(r => r.id === pickId);
  if (!restaurant) {
    block.append(el('p', { class: 'tr-picked-empty' }, 'Previously picked restaurant no longer in pool. Pick again below.'));
    return block;
  }
  block.append(el('p', { class: 'tr-picked-label' }, 'Your pick'));
  block.append(renderPickedCard(dataset, restaurant, night, state, rerender));
  return block;
}

function renderPickedCard(dataset, r, night, state, rerender) {
  const booking = state.bookingFor(night);
  const isBooked = !!booking;
  const card = el('div', { class: `tr-restaurant tr-restaurant-picked tier-${r.tier} ${isBooked ? 'is-booked' : ''}`, 'data-id': r.id });
  card.append(renderRestaurantHead(dataset, r));

  if (r.notes?.length) {
    const ul = el('ul', { class: 'tr-notes' });
    for (const n of r.notes.slice(0, 3)) ul.append(el('li', {}, n));
    card.append(ul);
  }

  // Deadline chip (only when not yet booked) — the only place "Book by X" lives
  if (!isBooked) {
    const today = new Date(); today.setHours(0,0,0,0);
    const deadline = bookDeadlineFor(r, night);
    const daysToBook = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
    const tier = daysToBook <= 7 ? 'high' : daysToBook <= 21 ? 'med' : 'low';
    const text = daysToBook <= 0 ? 'Book today' : `Book by ${formatShortDate(deadline)}`;
    card.append(el('p', { class: `tr-picked-deadline tr-urgency-${tier}` }, text));
  }

  // Booked state
  if (isBooked) {
    const booked = el('div', { class: 'tr-booked-banner' });
    booked.append(el('span', { class: 'tr-booked-check' }, '✓'));
    booked.append(el('span', { class: 'tr-booked-text' }, ` Booked${booking.confirmation ? ' · #' + booking.confirmation : ''}`));
    const actionsRow = el('span', { class: 'tr-booked-actions' });
    const icsBtn = el('button', { type: 'button', class: 'tr-btn-link tr-booked-ics', title: 'Download .ics calendar file' }, '📅 Add to Calendar');
    icsBtn.addEventListener('click', () => downloadIcs(r, night, state, booking));
    actionsRow.append(icsBtn);
    const clearBtn = el('button', { type: 'button', class: 'tr-btn-link tr-booked-clear' }, 'Clear');
    clearBtn.addEventListener('click', () => { state.setBooked(night, null); rerender(); });
    actionsRow.append(clearBtn);
    booked.append(actionsRow);
    card.append(booked);
  }

  // Actions
  const actions = el('div', { class: 'tr-actions' });
  actions.append(renderBookingButton(r, night, state));
  if (r.phone) actions.append(el('a', { class: 'tr-btn-secondary', href: 'tel:' + r.phone }, formatPhone(r.phone)));
  if (r.website) actions.append(el('a', { class: 'tr-btn-link', href: r.website, target: '_blank', rel: 'noopener' }, 'Website ↗'));
  card.append(actions);

  // Mark-as-booked control (only if not yet booked)
  if (!isBooked) {
    const mark = el('div', { class: 'tr-mark-booked' });
    const input = el('input', { type: 'text', class: 'tr-confirmation-input', placeholder: 'Confirmation # (optional)', 'aria-label': 'Confirmation number' });
    const btn = el('button', { type: 'button', class: 'tr-btn-mark' }, 'Mark as booked');
    btn.addEventListener('click', () => {
      state.setBooked(night, { confirmation: input.value.trim() || null, bookedAt: new Date().toISOString() });
      rerender();
    });
    mark.append(input, btn);
    card.append(mark);
  }

  // Closed-day warning (shouldn't happen if pool was filtered, but defensive)
  const wd = weekdayOf(night.date);
  if (!isOpenOn(r, wd)) {
    card.append(el('p', { class: 'tr-closed-warning' },
      `⚠ ${r.name} is closed ${DAY_LABELS[wd]}s — call to confirm or pick another.`));
  }

  if (r.booking?.note) card.append(el('p', { class: 'tr-booking-note' }, r.booking.note));

  // Change pick
  const change = el('button', { type: 'button', class: 'tr-btn-change' }, 'Change pick');
  change.addEventListener('click', () => { state.setPick(night, null); state.setBooked(night, null); rerender(); });
  card.append(change);

  return card;
}

function renderRestaurantHead(dataset, r) {
  const head = el('div', { class: 'tr-restaurant-head' });
  const top = el('div', { class: 'tr-restaurant-top' });
  top.append(el('h3', { class: 'tr-name' }, r.name));
  const tierDef = dataset.tiers[r.tier];
  if (tierDef) {
    top.append(el('span', { class: `tr-tier-chip tr-tier-chip-${r.tier}` }, tierDef.priceBand));
  }
  head.append(top);
  const meta = el('p', { class: 'tr-meta' });
  if (r.cuisine) meta.append(el('span', {}, r.cuisine));
  if (r.neighborhood) meta.append(el('span', {}, ' · ' + r.neighborhood));
  if (r.priceBand) meta.append(el('span', { class: 'tr-meta-price' }, ' · ' + r.priceBand));
  head.append(meta);
  return head;
}

// Pool filter state lives in memory per render (not persisted) — filters
// are a transient browse aid, not a long-term preference. Each night has
// its own filter state because users may want different filters per night.
const poolFilters = new Map(); // night.date → { openOnly, walkable, tiers:Set }

function getNightFilters(night) {
  if (!poolFilters.has(night.date)) {
    poolFilters.set(night.date, { openOnly: true, walkable: false, tiers: new Set() });
  }
  return poolFilters.get(night.date);
}

function renderPoolBlock(dataset, night, state, rerender) {
  const pickedId = state.pickFor(night);
  // Pool always rendered open within an already-open night card. The night
  // <details> wrapper handles the collapse, so this is just a grouped list.
  const block = el('div', { class: 'tr-pool' });
  block.append(el('p', { class: 'tr-pool-summary' },
    pickedId ? 'All restaurants — swap in a different one anytime' : 'Browse the full lineup'));

  const wd = weekdayOf(night.date);
  // Use global filters (set in renderGlobalFilters) instead of per-night state.
  const filters = globalFilterState;

  // ---- Filtered + grouped lists ----
  const showAllTiers = filters.tiers.size === 0;
  const matches = (r) => {
    if (r.id === pickedId) return false; // hide already-picked
    if (filters.openOnly && !isOpenOn(r, wd)) return false;
    if (filters.walkable && !isWalkable(r)) return false;
    if (!showAllTiers && !filters.tiers.has(r.tier)) return false;
    return true;
  };

  const byTier = { refined: [], elevated: [], signature: [] };
  const tierOrder = ['refined', 'elevated', 'signature'];
  for (const r of dataset.restaurants) {
    if (byTier[r.tier] && matches(r)) byTier[r.tier].push(r);
  }
  const totalMatches = byTier.refined.length + byTier.elevated.length + byTier.signature.length;
  if (totalMatches === 0) {
    block.append(el('p', { class: 'tr-pool-empty' },
      'No restaurants match these filters. Clear filters or widen them above.'));
    return block;
  }

  for (const tierId of tierOrder) {
    const list = byTier[tierId];
    if (!list.length) continue;
    const def = dataset.tiers[tierId];
    const section = el('section', { class: `tr-pool-section tr-pool-${tierId}` });
    section.append(el('h4', { class: 'tr-pool-heading' },
      el('span', { class: 'tr-pool-band' }, def.priceBand),
      el('span', { class: 'tr-pool-label' }, def.label),
      def.blurb ? el('span', { class: 'tr-pool-blurb' }, def.blurb) : null,
    ));
    const grid = el('div', { class: 'tr-pool-grid' });
    for (const r of list) {
      grid.append(renderPoolCard(dataset, r, night, state, rerender, wd));
    }
    section.append(grid);
    block.append(section);
  }
  return block;
}

// Walkable = Plaza, Downtown, Canyon Road, Don Gaspar, Railyard, Guadalupe areas.
// Used by the 'Walkable to Plaza' filter chip.
const WALKABLE_NEIGHBORHOODS = [
  'plaza', 'downtown', 'canyon', 'don gaspar', 'railyard', 'guadalupe',
];
function isWalkable(r) {
  const n = (r.neighborhood || '').toLowerCase();
  return WALKABLE_NEIGHBORHOODS.some(k => n.includes(k));
}

function renderPoolCard(dataset, r, night, state, rerender, weekday) {
  const closed = !isOpenOn(r, weekday);
  const isPicked = state.pickFor(night) === r.id;
  const card = el('div', {
    class: `tr-pool-card tier-${r.tier} ${closed ? 'is-closed' : ''} ${isPicked ? 'is-picked' : ''}`,
    'data-id': r.id,
  });

  const top = el('div', { class: 'tr-pool-card-top' });
  top.append(el('p', { class: 'tr-pool-card-name' }, r.name));
  if (closed) {
    top.append(el('span', { class: 'tr-closed-chip' }, `Closed ${DAY_LABELS[weekday]}s`));
  }
  card.append(top);

  const meta = el('p', { class: 'tr-pool-card-meta' });
  if (r.cuisine) meta.append(el('span', {}, r.cuisine));
  if (r.neighborhood) meta.append(el('span', {}, ' · ' + r.neighborhood));
  card.append(meta);

  if (r.notes?.[0]) card.append(el('p', { class: 'tr-pool-card-note' }, r.notes[0]));

  const pickBtn = el('button', {
    type: 'button',
    class: `tr-pool-pick-btn ${isPicked ? 'is-picked' : ''}`,
  }, isPicked ? '✓ Picked' : 'Pick for this night');
  if (closed) pickBtn.setAttribute('aria-disabled', 'true');
  pickBtn.addEventListener('click', () => {
    if (isPicked) { state.setPick(night, null); state.setBooked(night, null); }
    else { state.setPick(night, r.id); }
    rerender();
  });
  card.append(pickBtn);
  return card;
}

function renderNoteBlock(night, state) {
  const wrap = el('div', { class: 'tr-night-note' });
  const label = el('label', { class: 'tr-night-note-label' }, 'Notes for this night');
  const ta = el('textarea', {
    class: 'tr-night-note-input',
    rows: '2',
    placeholder: 'Dietary requests, anniversary, dress code reminders…',
  });
  ta.value = state.noteFor(night);
  ta.addEventListener('blur', () => state.setNote(night, ta.value.trim()));
  wrap.append(label, ta);
  return wrap;
}

// ---------- render: booking button (with deep links) ----------

function renderBookingButton(r, night, state) {
  const b = r.booking || {};
  if (b.platform === 'walkin') {
    return el('span', { class: 'tr-btn-primary tr-btn-walkin' }, 'Walk-in only');
  }
  if (b.platform === 'phone' || !b.url) {
    return el('a', { class: 'tr-btn-primary', href: 'tel:' + (r.phone || '') }, 'Call to book ↗');
  }
  const labels = {
    opentable: 'Reserve on OpenTable ↗',
    resy: 'Reserve on Resy ↗',
    tock: 'Reserve on Tock ↗',
    sevenrooms: 'Reserve ↗',
    yelp: 'Reserve on Yelp ↗',
  };
  const url = buildBookingUrl(r, night, state.party) || b.url;
  return el('a', { class: 'tr-btn-primary', href: url, target: '_blank', rel: 'noopener' }, labels[b.platform] || 'Reserve ↗');
}

// ---------- render: reservation timeline ----------

function renderTimeline(dataset, state) {
  // Tight status summary — NOT a duplicate of the per-night list.
  // States: (a) no picks, (b) some picks, (c) all picked + some booked, (d) all booked.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const totalNights = dataset.nights.length;
  let picked = 0, booked = 0, urgentUnbooked = 0;
  let firstUnbookedNight = null;
  for (const night of dataset.nights) {
    const pickId = state.pickFor(night);
    if (!pickId) continue;
    picked += 1;
    const r = dataset.restaurants.find(x => x.id === pickId);
    if (!r) continue;
    const bk = state.bookingFor(night);
    if (bk) { booked += 1; continue; }
    if (!firstUnbookedNight) firstUnbookedNight = night;
    const deadline = bookDeadlineFor(r, night);
    const daysToBook = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
    if (daysToBook <= 7) urgentUnbooked += 1;
  }

  const wrap = el('div', { class: 'tr-timeline-wrap' });

  // (a) Nothing picked yet — short empty state, no scary banner
  if (picked === 0) {
    wrap.append(el('p', { class: 'tr-timeline-empty' },
      `Pick a restaurant for each of your ${totalNights} nights below. Top Santa Fe tables — especially on Canyon Road — book 4–6 weeks ahead in June.`,
    ));
    return wrap;
  }

  // (d) All booked
  if (booked === totalNights) {
    wrap.append(el('div', { class: 'tr-timeline-summary is-done' },
      el('strong', {}, `All ${totalNights} reservations booked.`),
      el('span', { class: 'tr-timeline-sub' }, ' Confirmation numbers saved on each night below.'),
    ));
    return wrap;
  }

  // (b)/(c) Some progress — one compact status line + optional urgency chip + optional jump CTA
  const summary = el('div', { class: 'tr-timeline-summary' });
  summary.append(el('strong', {}, `${picked} of ${totalNights} nights picked`));
  if (booked > 0) summary.append(el('span', { class: 'tr-timeline-sub' }, ` · ${booked} booked`));
  if (urgentUnbooked > 0) {
    summary.append(el('span', { class: 'tr-timeline-chip tr-urgency-high' },
      `${urgentUnbooked} to book this week`,
    ));
  }
  wrap.append(summary);

  if (firstUnbookedNight) {
    const jump = el('button', {
      type: 'button',
      class: 'tr-timeline-jump',
    }, `Jump to ${firstUnbookedNight.label || formatShortDate(new Date(firstUnbookedNight.date + 'T00:00:00'))} ↓`);
    jump.addEventListener('click', () => {
      const target = document.querySelector(`details.tr-night[data-date="${firstUnbookedNight.date}"]`);
      if (target) {
        if (target.tagName === 'DETAILS') target.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    wrap.append(jump);
  }

  return wrap;
}

// ---------- tiny DOM helpers ----------

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(k));
  }
  return e;
}
function formatPhone(p) {
  const m = String(p).match(/^\+?1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(p);
}
