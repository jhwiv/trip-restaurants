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
    root.append(renderNights(dataset, state));
  };
  rerenderAll();
  mount.innerHTML = '';
  mount.append(root);
  return state;
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
    // Party overrides — start from dataset default, then merge stored
    this.party    = Object.assign(
      { size: 1, defaultTime: '19:00' },
      dataset.trip?.party || {},
      this._loadObj(this.keys.party),
    );
    this._subs = new Set();
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
  wrap.append(el('h2', {}, 'Dinners'));
  wrap.append(el('p', { class: 'tr-header-sub' },
    `Every night shows the full Santa Fe lineup, grouped by price. Pick what you want for each night — nothing is pre-selected. Same restaurant can appear on multiple nights. Restaurants closed on a given weekday are dimmed.`));

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
  const card = el('article', { class: 'tr-night', 'data-date': night.date });
  const rerender = () => {
    const fresh = renderNightCard(dataset, night, state);
    card.replaceWith(fresh);
  };

  card.append(renderNightHeader(night, state));
  card.append(renderPickedBlock(dataset, night, state, rerender));
  card.append(renderPoolBlock(dataset, night, state, rerender));
  card.append(renderNoteBlock(night, state));
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
    block.append(el('p', { class: 'tr-picked-empty' }, 'No restaurant chosen yet — pick from the pool below.'));
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
  // Always collapsed by default so the empty-state page isn't a 15-restaurant
  // firehose per night. User explicitly opens to browse.
  const block = el('details', { class: 'tr-pool' });
  const summaryLabel = pickedId
    ? 'Browse other options'
    : `Pick a restaurant for this night →`;
  block.append(el('summary', { class: 'tr-pool-summary' }, summaryLabel));

  const wd = weekdayOf(night.date);
  const filters = getNightFilters(night);

  // ---- Filter chips ----
  const chipBar = el('div', { class: 'tr-filter-bar' });
  const tierOrder = ['refined', 'elevated', 'signature'];

  const makeChip = (label, isActive, onClick, extraClass = '') => {
    const chip = el('button', {
      type: 'button',
      class: `tr-filter-chip ${isActive ? 'is-active' : ''} ${extraClass}`,
    }, label);
    chip.addEventListener('click', (e) => { e.preventDefault(); onClick(); rerender(); });
    return chip;
  };

  chipBar.append(
    makeChip(`Open ${DAY_LABELS[wd]}`, filters.openOnly,
      () => { filters.openOnly = !filters.openOnly; }, 'tr-filter-chip-open'),
    makeChip('Walkable to Plaza', filters.walkable,
      () => { filters.walkable = !filters.walkable; }, 'tr-filter-chip-walk'),
  );
  for (const tierId of tierOrder) {
    const def = dataset.tiers[tierId];
    chipBar.append(makeChip(`${def.priceBand} ${def.label}`, filters.tiers.has(tierId),
      () => { if (filters.tiers.has(tierId)) filters.tiers.delete(tierId); else filters.tiers.add(tierId); },
      `tr-filter-chip-tier tr-filter-chip-${tierId}`));
  }
  block.append(chipBar);

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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rows = [];
  for (const night of dataset.nights) {
    const pickId = state.pickFor(night);
    if (!pickId) continue;
    const r = dataset.restaurants.find(x => x.id === pickId);
    if (!r) continue;
    const booked = state.bookingFor(night);
    const deadline = bookDeadlineFor(r, night);
    const daysToBook = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
    rows.push({ night, r, booked, deadline, daysToBook });
  }
  // Sort: unbooked-urgent first, then booked
  rows.sort((a, b) => {
    if (!!a.booked !== !!b.booked) return a.booked ? 1 : -1;
    return a.daysToBook - b.daysToBook;
  });

  const wrap = el('div', { class: 'tr-timeline-wrap' });
  if (!rows.length) {
    wrap.append(el('p', { class: 'tr-timeline-empty' }, 'No restaurants picked yet. Choose from each night to build your reservation queue.'));
    return wrap;
  }
  // Urgency banner
  const urgent = rows.filter(r => !r.booked && r.daysToBook <= 7);
  if (urgent.length) {
    wrap.append(el('div', { class: 'tr-urgency-banner' },
      el('strong', {}, `${urgent.length} reservation${urgent.length > 1 ? 's' : ''} to book this week`),
      el('span', { class: 'tr-urgency-sub' }, ' — see deadlines below'),
    ));
  }
  const list = el('ol', { class: 'tr-timeline-list' });
  for (const { night, r, booked, deadline, daysToBook } of rows) {
    const li = el('li', { class: `tr-timeline-row ${booked ? 'is-booked' : ''}` });
    const badge = booked
      ? el('span', { class: 'tr-timeline-badge tr-urgency-done' }, '✓ Booked')
      : el('span', { class: `tr-timeline-badge tr-urgency-${daysToBook <= 7 ? 'high' : daysToBook <= 21 ? 'med' : 'low'}` },
          daysToBook <= 0 ? 'Book today' : `Book by ${formatShortDate(deadline)}`);
    li.append(badge);
    const body = el('div', { class: 'tr-timeline-body' });
    body.append(el('p', { class: 'tr-timeline-name' },
      `${r.name} · ${night.label || night.date}`,
    ));
    const note = booked?.confirmation ? `Confirmation #${booked.confirmation}` : (r.booking?.note || r.notes?.[0] || '');
    body.append(el('p', { class: 'tr-timeline-note' },
      note + ' ',
      r.phone ? el('a', { href: 'tel:' + r.phone }, formatPhone(r.phone)) : null,
    ));
    li.append(body);
    list.append(li);
  }
  wrap.append(list);
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
