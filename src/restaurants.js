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
    // Global cross-night filter chips were removed — tier selection now happens
    // inside each night card, so a trip-level filter row was redundant.
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
      customs:  `${baseKey}-customs`,  // { 'YYYY-MM-DD': { name, time, url, neighborhood } }
    };
    this.picks    = this._loadObj(this.keys.picks);
    this.bookings = this._loadObj(this.keys.bookings);
    this.notes    = this._loadObj(this.keys.notes);
    this.customs  = this._loadObj(this.keys.customs);

    // ----- Fix A: soften one-time "clear curated seeds" migration -----
    // The tier-picker release no longer pre-seeds curated picks. Earlier
    // sessions saved 7 default picks to localStorage, and the original
    // migration nuked anything that LOOKED like a seed: 7 valid picks +
    // no bookings. That's wrong — a user can have 7 real picks and zero
    // bookings (they haven't booked yet). We now ONLY nuke when there is
    // ZERO evidence of user engagement: no notes, no bookings, no party
    // overrides, AND the 7 picks exactly match the historical curated
    // seed restaurants. If any of those signals exist, treat the picks
    // as real and leave them alone.
    if (typeof localStorage !== 'undefined') {
      const migKey = `${baseKey}-mig-tierpicker-2026-05`;
      try {
        if (!localStorage.getItem(migKey)) {
          const partyOverridden = !!localStorage.getItem(this.keys.party);
          const hasNotes = Object.keys(this.notes || {}).length > 0;
          const hasBookings = Object.keys(this.bookings || {}).length > 0;
          const validIds = new Set((dataset.restaurants || []).map(r => r.id));
          const nightDates = new Set((dataset.nights || []).map(n => n.date));
          const pickEntries = Object.entries(this.picks);
          const allOnTripNights = pickEntries.every(([d]) => nightDates.has(d));
          const allValidIds = pickEntries.every(([, id]) => validIds.has(id));
          // Historical curated seed IDs (Santa Fe trip). If the pick set is
          // EXACTLY this set, we know it's the old seed and can drop it.
          // If even one pick differs, we treat the data as user-modified.
          const CURATED_SEED_IDS = new Set([
            'anasazi-restaurant', 'the-compound-restaurant',
            'geronimo-canyon', 'luminaria-loretto', 'coyote-cafe-rooftop',
            'josephs-culinary-pub', 'restaurant-martin-farewell-tasting',
          ]);
          const pickedIds = pickEntries.map(([, id]) => id);
          const matchesCuratedSeed =
            pickedIds.length === CURATED_SEED_IDS.size &&
            pickedIds.every(id => CURATED_SEED_IDS.has(id));
          const looksLikeSeed =
            pickEntries.length === (dataset.nights || []).length &&
            pickEntries.length > 0 &&
            allOnTripNights && allValidIds &&
            !hasBookings && !hasNotes && !partyOverridden &&
            matchesCuratedSeed;
          if (looksLikeSeed) {
            this.picks = {};
            this._save(this.keys.picks, this.picks);
          }
          localStorage.setItem(migKey, '1');
        }
      } catch {}
    }

    // ----- Fix B: self-heal stale picks that reference deleted restaurants.
    // If the dataset has been edited (restaurant ID renamed or removed),
    // a saved pick can dangle forever, showing a confusing 'no pool match'
    // empty card on Day N. Drop those orphan entries on load so the night
    // re-enters the tier-picker flow cleanly.
    {
      const validIds = new Set((dataset.restaurants || []).map(r => r.id));
      let removedAny = false;
      for (const [date, id] of Object.entries(this.picks)) {
        if (!validIds.has(id)) { delete this.picks[date]; removedAny = true; }
      }
      if (removedAny) this._save(this.keys.picks, this.picks);
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
    this.customs = {};
    this._save(this.keys.picks, this.picks);
    this._save(this.keys.bookings, this.bookings);
    this._save(this.keys.notes, this.notes);
    this._save(this.keys.customs, this.customs);
    if (typeof localStorage !== 'undefined') {
      try { localStorage.removeItem(`${this.keys.picks}-seeded`); } catch {}
    }
    this._notify();
  }
  pickFor(night)            { return this.picks[night.date] || null; }
  setPick(night, restId)    { if (restId) this.picks[night.date] = restId; else delete this.picks[night.date]; this._save(this.keys.picks, this.picks); this._notify(); }
  bookingFor(night)         { return this.bookings[night.date] || null; }
  setBooked(night, info)    { if (info) this.bookings[night.date] = info; else delete this.bookings[night.date]; this._save(this.keys.bookings, this.bookings); this._notify(); }
  // Custom (off-list) restaurant for a night. When set, it overrides the
  // curated pick flow — the night renders the custom card instead.
  customFor(night)          { return this.customs[night.date] || null; }
  setCustom(night, info)    {
    if (info) this.customs[night.date] = info; else delete this.customs[night.date];
    this._save(this.keys.customs, this.customs);
    // A custom overrides any curated pick — clear the pick to avoid ambiguity.
    if (info && this.picks[night.date]) { delete this.picks[night.date]; this._save(this.keys.picks, this.picks); }
    this._notify();
  }
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

function isValidHttpUrl(s) {
  if (!s || typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

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
    isValidHttpUrl(booking?.confirmationUrl) ? `Confirmation link: ${booking.confirmationUrl}` : '',
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

  // Trip-wide settings live inside a single collapsed disclosure so they
  // don't push the first night card below the fold on mobile.
  const settings = el('details', { class: 'tr-trip-settings' });
  settings.append(el('summary', { class: 'tr-trip-settings-summary' }, 'Trip settings'));
  const settingsBody = el('div', { class: 'tr-trip-settings-body' });

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
  settingsBody.append(config);

  const legend = el('div', { class: 'tr-legend' });
  for (const [id, t] of Object.entries(dataset.tiers || {})) {
    legend.append(el('div', { class: `tr-legend-item tr-legend-${id}` },
      el('span', { class: 'tr-legend-label' }, t.label),
      el('span', { class: 'tr-legend-band' }, t.priceBand),
      t.blurb ? el('span', { class: 'tr-legend-blurb' }, t.blurb) : null,
    ));
  }
  settingsBody.append(legend);
  settings.append(settingsBody);
  wrap.append(settings);

  // Top-of-tab browse chips — always visible so users can find new spots without
  // expanding a specific night first. Passes night=null so OpenTable doesn't
  // pre-pin a single date.
  wrap.append(renderBrowseChips(null, state, 'top'));
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
  // has already picked a restaurant for it (curated or custom).
  let pickId = state.pickFor(night);
  const custom = state.customFor(night);
  // ----- Fix C: defensive recovery from orphan picks.
  // Fix B drops orphans on load, but if the dataset is somehow swapped
  // mid-session (or the pick was written by a different module version),
  // a stale pickId can sneak through. Detect it here and clear so the
  // user isn't stranded on a 'pick exists but restaurant unknown' card.
  if (pickId && !dataset.restaurants.find(r => r.id === pickId)) {
    state.setPick(night, null);
    state.setBooked(night, null);
    pickId = null;
  }
  const isPicked = !!(pickId || custom);
  const card = el('details', {
    class: 'tr-night' + (custom ? ' is-custom' : ''),
    'data-date': night.date,
    ...(isPicked ? { open: 'open' } : {}),
  });
  // Show inline add-custom form when this night is in 'adding' state.
  const showAddForm = nightAddingCustom.has(night.date);
  const rerender = () => {
    const fresh = renderNightCard(dataset, night, state);
    // Preserve open state on re-render
    if (card.open) fresh.setAttribute('open', 'open');
    card.replaceWith(fresh);
  };

  card.append(renderNightSummary(dataset, night, state));
  const body = el('div', { class: 'tr-night-body' });
  if (custom) {
    // User added their own restaurant for this night.
    body.append(renderCustomBlock(dataset, night, state, rerender));
  } else if (pickId) {
    // User has chosen from the curated pool — show picked card + backup + note
    body.append(renderPickedBlock(dataset, night, state, rerender));
    body.append(renderBackupBlock(dataset, night, state, rerender));
  } else {
    // No pick yet. Two sub-states:
    //   1. No tier chosen → show 3-tier picker ($$ / $$$ / $$$$)
    //   2. Tier chosen   → show compact list of restaurants in that tier
    const tier = nightTierSelection.get(night.date);
    if (showAddForm) {
      body.append(renderCustomForm(night, state, rerender, null));
    } else if (!tier) {
      body.append(renderTierPicker(dataset, night, state, rerender));
      body.append(renderAddCustomCta(night, rerender));
      body.append(renderBrowseChips(night, state, 'in-picker'));
    } else {
      body.append(renderTierList(dataset, night, state, tier, rerender));
    }
  }
  body.append(renderNoteBlock(night, state));
  card.append(body);
  return card;
}

// Per-night flag: night.date is in this Set when the user is filling in the
// 'add my own reservation' form. Cleared on save or cancel.
const nightAddingCustom = new Set();

// ---------- 'Add my own reservation' CTA + form ----------
function renderAddCustomCta(night, rerender) {
  const wrap = el('div', { class: 'tr-add-custom-cta' });
  const btn = el('button', { type: 'button', class: 'tr-btn-add-custom' },
    el('span', { class: 'tr-btn-add-custom-icon', 'aria-hidden': 'true' }, '+'),
    el('span', {}, 'Add my own reservation'),
  );
  btn.setAttribute('aria-label', 'Add a reservation you booked yourself for this night');
  btn.addEventListener('click', () => {
    nightAddingCustom.add(night.date);
    rerender();
  });
  wrap.append(btn);
  wrap.append(el('p', { class: 'tr-add-custom-hint' },
    'Booked somewhere not on the list? Add it here so it shows up in your itinerary.'));
  return wrap;
}

// Render the OpenTable / Yelp Santa Fe browse chips.
// `placement` is 'top' (top of dining tab) or 'in-picker' (inside a night picker).
function renderBrowseChips(night, state, placement) {
  const wrap = el('div', { class: 'tr-browse-chips tr-browse-chips--' + placement });
  if (placement === 'in-picker') {
    wrap.append(el('p', { class: 'tr-browse-chips-label' }, 'Or browse Santa Fe restaurants'));
  } else {
    wrap.append(el('p', { class: 'tr-browse-chips-label' }, 'Browse Santa Fe restaurants'));
  }
  // OpenTable: pre-fill date + party size when invoked from a specific night.
  const otBase = 'https://www.opentable.com/s';
  const otParams = new URLSearchParams({
    term: 'Santa Fe, NM',
    covers: String(state.party?.size || 2),
  });
  if (night) {
    otParams.set('dateTime', `${night.date}T${toHHMM(state.party?.defaultTime || '19:00')}:00`);
  }
  const otUrl = `${otBase}?${otParams.toString()}`;
  const yelpUrl = 'https://www.yelp.com/search?find_desc=Restaurants&find_loc=Santa+Fe%2C+NM';
  const resyUrl = 'https://resy.com/cities/santa-fe-nm';
  const otChip = el('a', {
    class: 'tr-browse-chip tr-browse-chip-opentable',
    href: otUrl, target: '_blank', rel: 'noopener',
    'aria-label': 'Search OpenTable Santa Fe (opens in new tab)',
  },
    el('span', { class: 'tr-browse-chip-mark' }, 'OT'),
    el('span', { class: 'tr-browse-chip-label' }, 'OpenTable'),
    el('span', { class: 'tr-browse-chip-arrow', 'aria-hidden': 'true' }, '\u2197'),
  );
  const resyChip = el('a', {
    class: 'tr-browse-chip tr-browse-chip-resy',
    href: resyUrl, target: '_blank', rel: 'noopener',
    'aria-label': 'Browse Resy Santa Fe (opens in new tab)',
  },
    el('span', { class: 'tr-browse-chip-mark' }, 'R'),
    el('span', { class: 'tr-browse-chip-label' }, 'Resy'),
    el('span', { class: 'tr-browse-chip-arrow', 'aria-hidden': 'true' }, '\u2197'),
  );
  const yelpChip = el('a', {
    class: 'tr-browse-chip tr-browse-chip-yelp',
    href: yelpUrl, target: '_blank', rel: 'noopener',
    'aria-label': 'Search Yelp Santa Fe (opens in new tab)',
  },
    el('span', { class: 'tr-browse-chip-mark' }, 'Y'),
    el('span', { class: 'tr-browse-chip-label' }, 'Yelp'),
    el('span', { class: 'tr-browse-chip-arrow', 'aria-hidden': 'true' }, '\u2197'),
  );
  const row = el('div', { class: 'tr-browse-chips-row' });
  row.append(otChip, resyChip, yelpChip);
  wrap.append(row);
  return wrap;
}

// Form for capturing a user's own reservation. `editing` is null for new,
// or the existing custom record when editing.
function renderCustomForm(night, state, rerender, editing) {
  const wrap = el('form', { class: 'tr-custom-form', 'aria-label': 'Add reservation' });
  wrap.addEventListener('submit', (e) => e.preventDefault());
  wrap.append(el('p', { class: 'tr-custom-form-title' },
    editing ? 'Edit your reservation' : 'Add your reservation'));

  const grid = el('div', { class: 'tr-custom-form-grid' });

  // Name (required)
  const nameLabel = el('label', { class: 'tr-custom-form-label', for: 'tr-cf-name-' + night.date }, 'Restaurant name');
  const nameInput = el('input', {
    id: 'tr-cf-name-' + night.date,
    type: 'text', required: 'required',
    class: 'tr-custom-form-input',
    placeholder: 'e.g. Sazon',
    autocomplete: 'off',
  });
  if (editing?.name) nameInput.value = editing.name;
  grid.append(el('div', { class: 'tr-custom-form-field tr-cf-field-name' }, nameLabel, nameInput));

  // Time
  const timeLabel = el('label', { class: 'tr-custom-form-label', for: 'tr-cf-time-' + night.date }, 'Time');
  const timeInput = el('input', {
    id: 'tr-cf-time-' + night.date,
    type: 'time', class: 'tr-custom-form-input',
  });
  timeInput.value = editing?.time || toHHMM(state.party?.defaultTime || '19:00');
  grid.append(el('div', { class: 'tr-custom-form-field tr-cf-field-time' }, timeLabel, timeInput));

  // Reservation/confirmation URL (optional)
  const urlLabel = el('label', { class: 'tr-custom-form-label', for: 'tr-cf-url-' + night.date }, 'Confirmation or listing link (optional)');
  const urlInput = el('input', {
    id: 'tr-cf-url-' + night.date,
    type: 'url',
    class: 'tr-custom-form-input',
    placeholder: 'https://www.opentable.com/r/…',
    autocomplete: 'off',
  });
  if (editing?.url) urlInput.value = editing.url;
  grid.append(el('div', { class: 'tr-custom-form-field tr-cf-field-url' }, urlLabel, urlInput));

  // Confirmation # (optional)
  const confLabel = el('label', { class: 'tr-custom-form-label', for: 'tr-cf-conf-' + night.date }, 'Confirmation # (optional)');
  const confInput = el('input', {
    id: 'tr-cf-conf-' + night.date,
    type: 'text', class: 'tr-custom-form-input',
    placeholder: 'e.g. 12345678',
    autocomplete: 'off',
  });
  if (editing?.confirmation) confInput.value = editing.confirmation;
  grid.append(el('div', { class: 'tr-custom-form-field tr-cf-field-conf' }, confLabel, confInput));

  wrap.append(grid);

  const err = el('p', { class: 'tr-custom-form-error', role: 'alert' }, '');
  err.hidden = true;
  wrap.append(err);

  const showErr = (msg, focusEl) => {
    err.textContent = msg; err.hidden = false;
    if (focusEl) { focusEl.classList.add('is-invalid'); focusEl.focus(); }
  };
  const clearErr = () => {
    err.hidden = true;
    [nameInput, urlInput].forEach(i => i.classList.remove('is-invalid'));
  };
  nameInput.addEventListener('input', clearErr);
  urlInput.addEventListener('input', clearErr);

  const actions = el('div', { class: 'tr-custom-form-actions' });
  const saveBtn = el('button', { type: 'submit', class: 'tr-btn-primary' },
    editing ? 'Save changes' : 'Add reservation');
  saveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const time = (timeInput.value || '').trim();
    const url = urlInput.value.trim();
    const confirmation = confInput.value.trim();
    if (!name) { showErr('Restaurant name is required.', nameInput); return; }
    if (url && !isValidHttpUrl(url)) { showErr('Link needs https:// (or http://) at the start.', urlInput); return; }
    state.setCustom(night, {
      name, time: time || null,
      url: url || null,
      confirmation: confirmation || null,
      addedAt: editing?.addedAt || new Date().toISOString(),
    });
    nightAddingCustom.delete(night.date);
    rerender();
  });
  const cancelBtn = el('button', { type: 'button', class: 'tr-btn-secondary' }, 'Cancel');
  cancelBtn.addEventListener('click', () => {
    nightAddingCustom.delete(night.date);
    rerender();
  });
  actions.append(saveBtn, cancelBtn);
  wrap.append(actions);

  // Helper row — browse chips inside the form for convenience
  wrap.append(renderBrowseChips(night, state, 'in-form'));

  // Focus name field on first render
  setTimeout(() => nameInput.focus(), 30);

  return wrap;
}

// Render the picked-state card for a user's own custom restaurant.
function renderCustomBlock(dataset, night, state, rerender) {
  const custom = state.customFor(night);
  const block = el('div', { class: 'tr-picked-block tr-custom-block' });
  if (!custom) return block;
  block.append(el('p', { class: 'tr-picked-label tr-custom-label' },
    el('span', { class: 'tr-custom-label-pill' }, 'Added by you'),
  ));
  block.append(renderCustomCard(night, state, custom, rerender));
  return block;
}

function hostLabelForUrl(url){
  try {
    const h = new URL(url).hostname.replace(/^www\./,'');
    const parts = h.split('.');
    const reg = parts.length >= 2 ? parts.slice(-2).join('.') : h;
    return reg.toUpperCase();
  } catch(e){ return 'LINK'; }
}

function renderCustomCard(night, state, custom, rerender) {
  const card = el('div', { class: 'tr-restaurant tr-restaurant-custom' });
  // Head: name + 'your reservation' chip
  const head = el('div', { class: 'tr-restaurant-head' });
  const top = el('div', { class: 'tr-restaurant-top' });
  top.append(el('h3', { class: 'tr-name' }, custom.name));
  head.append(top);
  if (custom.time) {
    head.append(el('p', { class: 'tr-meta' },
      el('span', { class: 'tr-meta-time' }, formatTimeLabel(custom.time))));
  }
  card.append(head);

  // Boarding-pass style reservation card when URL is present
  if (isValidHttpUrl(custom.url)) {
    const linkCard = el('a', {
      class: 'tr-resv-card',
      href: custom.url, target: '_blank', rel: 'noopener',
      'aria-label': 'Open reservation' + (custom.confirmation ? ' #' + custom.confirmation : '') + ' (opens in new tab)',
    });
    linkCard.append(el('span', { class: 'tr-resv-card-stub' }, hostLabelForUrl(custom.url)));
    linkCard.append(el('span', { class: 'tr-resv-card-notch', 'aria-hidden': 'true' }));
    const body = el('span', { class: 'tr-resv-card-body' });
    body.append(el('span', { class: 'tr-resv-card-eyebrow' }, 'Reservation'));
    body.append(el('span', { class: 'tr-resv-card-code' },
      custom.confirmation ? '#' + custom.confirmation : 'View listing'));
    body.append(el('span', { class: 'tr-resv-card-cta' }, 'Open \u2197'));
    linkCard.append(body);
    card.append(linkCard);
  } else if (custom.confirmation) {
    card.append(el('p', { class: 'tr-custom-conf-only' },
      el('span', { class: 'tr-custom-conf-label' }, 'Confirmation #'),
      el('span', { class: 'tr-custom-conf-num' }, custom.confirmation),
    ));
  }

  // Actions: edit / remove
  const actions = el('div', { class: 'tr-actions tr-custom-actions' });
  const editBtn = el('button', { type: 'button', class: 'tr-btn-secondary' }, 'Edit');
  editBtn.addEventListener('click', () => {
    nightAddingCustom.add(night.date);
    // Render form in edit mode — we re-render the whole card and the body
    // takes a different path because nightAddingCustom is set AND custom is set.
    // Special-case: clear the custom temporarily? No — form prefills from editing arg.
    // Easier: directly mount the form by replacing this block.
    const formWrap = el('div', { class: 'tr-night-body' });
    formWrap.append(renderCustomForm(night, state, rerender, custom));
    card.parentElement.replaceWith(formWrap);
  });
  const removeBtn = el('button', { type: 'button', class: 'tr-btn-secondary tr-custom-remove' }, 'Remove');
  removeBtn.addEventListener('click', () => {
    const ok = (typeof confirm !== 'function') || confirm(`Remove ${custom.name} from this night?`);
    if (!ok) return;
    state.setCustom(night, null);
    state.setBooked(night, null);
    rerender();
  });
  actions.append(editBtn, removeBtn);
  card.append(actions);

  return card;
}

function formatTimeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m||0).padStart(2,'0')} ${period}`;
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
  const custom = state.customFor(night);
  const pickedR = pickId ? dataset.restaurants.find(x => x.id === pickId) : null;
  if (custom) {
    // User-added reservation gets its own subtle treatment.
    right.append(el('span', { class: 'tr-night-status is-custom' }, 'Your pick'));
    right.append(el('span', { class: 'tr-night-pick-name' }, custom.name));
  } else if (pickId && pickedR) {
    const label = booking ? '✓ Booked' : 'Picked';
    right.append(el('span', { class: `tr-night-status ${booking ? 'is-booked' : 'is-picked'}` }, label));
    right.append(el('span', { class: 'tr-night-pick-name' }, pickedR.name));
  } else {
    // Either no pick OR orphan pick — in both cases show the actionable prompt.
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

const TIER_RANK = { refined: 1, elevated: 2, signature: 3 };

function pickBackupRestaurant(dataset, night, pickedRestaurant) {
  // Choose a backup that NEVER exceeds the user's picked tier. Strategy:
  //   1. Curated night.backup if it satisfies the cap, is open, and isn't
  //      the user's pick.
  //   2. Closest-walking restaurant in the SAME tier as the pick.
  //   3. Closest-walking restaurant in a LOWER tier.
  //   4. null — hide the backup block entirely.
  if (!pickedRestaurant) return null;
  const pickTier = pickedRestaurant.tier;
  const pickRank = TIER_RANK[pickTier] ?? 3;
  const weekday = weekdayOf(night.date);
  const candidates = (dataset.restaurants || []).filter(r => {
    if (r.id === pickedRestaurant.id) return false;
    if (!isOpenOn(r, weekday)) return false;
    const rRank = TIER_RANK[r.tier] ?? 99;
    return rRank <= pickRank;
  });
  if (!candidates.length) return null;

  // 1. Curated backup, if it passes the cap + still on the candidate list.
  if (night.backup) {
    const curated = candidates.find(r => r.id === night.backup);
    if (curated) return curated;
  }

  // 2/3. Walkable-first, by tier (same tier preferred, then descending).
  for (let r = pickRank; r >= 1; r--) {
    const inRank = candidates.filter(c => (TIER_RANK[c.tier] ?? 99) === r);
    if (!inRank.length) continue;
    inRank.sort((a, b) => {
      const ta = a.travelFromHotel, tb = b.travelFromHotel;
      const aw = ta?.mode === 'walk' ? 0 : 1;
      const bw = tb?.mode === 'walk' ? 0 : 1;
      if (aw !== bw) return aw - bw;
      const am = ta?.walkMinutes ?? ta?.driveMinutes ?? 999;
      const bm = tb?.walkMinutes ?? tb?.driveMinutes ?? 999;
      if (am !== bm) return am - bm;
      return a.name.localeCompare(b.name);
    });
    return inRank[0];
  }
  return null;
}

function renderBackupBlock(dataset, night, state, rerender) {
  // Show a backup ONLY when it fits the user's chosen price tier or below.
  // Hidden when no pick yet, or when no suitable backup exists.
  const pickId = state.pickFor(night);
  if (!pickId) return el('div', { class: 'tr-backup-empty' });
  const pickedR = dataset.restaurants.find(x => x.id === pickId);
  if (!pickedR) return el('div', { class: 'tr-backup-empty' });
  const r = pickBackupRestaurant(dataset, night, pickedR);
  if (!r) return el('div', { class: 'tr-backup-empty' });
  const sameTier = r.tier === pickedR.tier;
  const note = sameTier
    ? ` · In case ${pickedR.name} is fully booked`
    : ` · Easier-to-book option at the same or lower price`;
  const block = el('div', { class: 'tr-backup-block' });
  block.append(el('p', { class: 'tr-backup-label' },
    el('span', { class: 'tr-backup-chip' }, 'Backup pick'),
    el('span', { class: 'tr-backup-label-text' }, note),
  ));
  block.append(el('p', { class: 'tr-backup-hint' },
    `Book ${pickedR.name} first. If they can't seat you, the card below is our recommended fallback — same neighborhood, similar style.`));
  block.append(renderBackupCard(dataset, r, night, state, rerender, pickedR));
  return block;
}

function renderBackupCard(dataset, r, night, state, rerender, pickedR) {
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
  // Promote backup to be the primary pick. The label spells out the consequence
  // so users understand they are SWAPPING their main pick, not adding a second one.
  const promoteRow = el('div', { class: 'tr-promote-row' });
  const promote = el('button', { type: 'button', class: 'tr-btn-promote' },
    el('span', { class: 'tr-btn-promote-icon', 'aria-hidden': 'true' }, '⇄'),
    el('span', {}, `Swap — make ${r.name} my pick instead`),
  );
  promote.setAttribute('aria-label', `Swap your pick: replace ${pickedR ? pickedR.name : 'your current pick'} with ${r.name}`);
  promote.addEventListener('click', () => {
    const prompt = pickedR
      ? `Replace ${pickedR.name} with ${r.name} for this night?`
      : `Make ${r.name} your pick for this night?`;
    if (typeof confirm === 'function' && !confirm(prompt)) return;
    state.setPick(night, r.id);
    state.setBooked(night, null);
    rerender();
  });
  promoteRow.append(promote);
  if (pickedR) {
    promoteRow.append(el('p', { class: 'tr-promote-hint' },
      `This replaces ${pickedR.name} as your main pick for this night.`));
  }
  card.append(promoteRow);
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
    // Confirmation URL link — only render if a valid URL is stored
    if (isValidHttpUrl(booking.confirmationUrl)) {
      actionsRow.append(el('a', {
        class: 'tr-btn-link tr-booked-conf',
        href: booking.confirmationUrl,
        target: '_blank',
        rel: 'noopener',
        title: 'Open booking confirmation'
      }, '📄 Confirmation ↗'));
    }
    const icsBtn = el('button', { type: 'button', class: 'tr-btn-link tr-booked-ics', title: 'Download .ics calendar file' }, '📅 Add to Calendar');
    icsBtn.addEventListener('click', () => downloadIcs(r, night, state, booking));
    actionsRow.append(icsBtn);
    // Edit-link control: lets user add/update/clear the confirmation URL without un-booking.
    // Uses an inline editor (no native prompt/alert) so it works gracefully on mobile.
    const editLinkBtn = el('button', { type: 'button', class: 'tr-btn-link tr-booked-edit-link' },
      booking.confirmationUrl ? 'Edit link' : '+ Add link');
    editLinkBtn.addEventListener('click', () => {
      // Replace the actions row with an inline editor for the URL.
      const editor = el('div', { class: 'tr-conf-editor' });
      const input = el('input', {
        type: 'url',
        class: 'tr-confirmation-input tr-confirmation-url',
        placeholder: 'Paste confirmation URL (https://...)',
        'aria-label': 'Confirmation URL'
      });
      input.value = booking.confirmationUrl || '';
      const err = el('span', { class: 'tr-conf-error', role: 'alert' },
        'Needs https:// (or http://) at the start');
      err.hidden = true;
      function showErr(){ err.hidden = false; input.classList.add('is-invalid'); input.setAttribute('aria-invalid','true'); input.focus(); }
      function clearErr(){ err.hidden = true; input.classList.remove('is-invalid'); input.removeAttribute('aria-invalid'); }
      input.addEventListener('input', clearErr);
      function commit(val) {
        const trimmed = (val || '').trim();
        if (trimmed && !isValidHttpUrl(trimmed)) { showErr(); return; }
        state.setBooked(night, { ...booking, confirmationUrl: trimmed || null });
        rerender();
      }
      const saveBtn = el('button', { type: 'button', class: 'tr-btn-link' }, 'Save');
      saveBtn.addEventListener('click', () => commit(input.value));
      const cancelBtn = el('button', { type: 'button', class: 'tr-btn-link' }, 'Cancel');
      cancelBtn.addEventListener('click', () => rerender());
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(input.value); }
        if (e.key === 'Escape') { e.preventDefault(); rerender(); }
      });
      editor.append(input, saveBtn, cancelBtn);
      if (booking.confirmationUrl) {
        const clearBtnInline = el('button', { type: 'button', class: 'tr-btn-link' }, 'Clear');
        clearBtnInline.addEventListener('click', () => commit(''));
        editor.append(clearBtnInline);
      }
      editor.append(err);
      // Replace the banner contents with the editor for clarity
      booked.innerHTML = '';
      booked.append(el('span', { class: 'tr-booked-text' },
        booking.confirmationUrl ? 'Edit confirmation link' : 'Add a confirmation link'));
      booked.append(editor);
      input.focus();
      if (booking.confirmationUrl) input.select();
    });
    actionsRow.append(editLinkBtn);
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
    const urlInput = el('input', { type: 'url', class: 'tr-confirmation-input tr-confirmation-url', placeholder: 'Confirmation URL (optional)', 'aria-label': 'Confirmation URL' });
    const err = el('span', { class: 'tr-conf-error', role: 'alert' },
      'Confirmation URL needs https:// (or http://) at the start');
    err.hidden = true;
    urlInput.addEventListener('input', () => {
      err.hidden = true;
      urlInput.classList.remove('is-invalid');
      urlInput.removeAttribute('aria-invalid');
    });
    const btn = el('button', { type: 'button', class: 'tr-btn-mark' }, 'Mark as booked');
    btn.addEventListener('click', () => {
      const urlVal = urlInput.value.trim();
      if (urlVal && !isValidHttpUrl(urlVal)) {
        err.hidden = false;
        urlInput.classList.add('is-invalid');
        urlInput.setAttribute('aria-invalid', 'true');
        urlInput.focus();
        return;
      }
      state.setBooked(night, {
        confirmation: input.value.trim() || null,
        confirmationUrl: urlVal || null,
        bookedAt: new Date().toISOString()
      });
      rerender();
    });
    mark.append(input, urlInput, btn, err);
    card.append(mark);
  }

  // Closed-day warning (shouldn't happen if pool was filtered, but defensive)
  const wd = weekdayOf(night.date);
  if (!isOpenOn(r, wd)) {
    card.append(el('p', { class: 'tr-closed-warning' },
      `⚠ ${r.name} is closed ${DAY_LABELS[wd]}s — call to confirm or pick another.`));
  }

  if (r.booking?.note) card.append(el('p', { class: 'tr-booking-note' }, r.booking.note));

  // Footer actions: change pick, move to another night, or replace with your own.
  // Three explicit affordances so the user never feels boxed in by a booked pick
  // (real-world example: Pia had Geronimo booked on Mon but her confirmation was
  // actually for Tue, and she had no way to fix it from the booked card).
  const footerActions = el('div', { class: 'tr-picked-actions' });

  const change = el('button', { type: 'button', class: 'tr-btn-picked-action' },
    el('span', { class: 'tr-btn-picked-action-icon', 'aria-hidden': 'true' }, '\u21BB'),
    el('span', {}, 'Change pick'),
  );
  change.addEventListener('click', () => {
    state.setPick(night, null);
    state.setBooked(night, null);
    rerender();
  });
  footerActions.append(change);

  // Move to another night — only show if there's at least one other trip night.
  if ((dataset.nights || []).length > 1) {
    const move = el('button', { type: 'button', class: 'tr-btn-picked-action' },
      el('span', { class: 'tr-btn-picked-action-icon', 'aria-hidden': 'true' }, '\u2194'),
      el('span', {}, 'Move to another night'),
    );
    move.addEventListener('click', () => {
      openMoveNightPicker(dataset, night, state, r, rerender);
    });
    footerActions.append(move);
  }

  const replace = el('button', { type: 'button', class: 'tr-btn-picked-action' },
    el('span', { class: 'tr-btn-picked-action-icon', 'aria-hidden': 'true' }, '+'),
    el('span', {}, 'Replace with my own reservation'),
  );
  replace.addEventListener('click', () => {
    state.setPick(night, null);
    state.setBooked(night, null);
    nightAddingCustom.add(night.date);
    rerender();
  });
  footerActions.append(replace);

  card.append(footerActions);

  return card;
}

// ---------- Move-night picker ----------
// Lightweight inline picker shown when the user taps "Move to another night"
// on a picked card. Lists every other trip night with a tap target. Tapping
// a target moves the pick + booking (+ notes) to the chosen night and clears
// the current one. If the target night already has a pick, the user is asked
// to confirm before overwriting.
function openMoveNightPicker(dataset, fromNight, state, restaurant, rerender) {
  const overlay = el('div', { class: 'tr-move-overlay', role: 'dialog', 'aria-modal': 'true' });
  const sheet = el('div', { class: 'tr-move-sheet' });
  sheet.append(el('h3', { class: 'tr-move-title' }, `Move ${restaurant.name} to\u2026`));
  sheet.append(el('p', { class: 'tr-move-sub' },
    `Currently on ${fromNight.label || fromNight.date}. Pick the night that matches your confirmation.`));

  const list = el('div', { class: 'tr-move-list' });
  for (const target of dataset.nights) {
    if (target.date === fromNight.date) continue;
    const existingPickId = state.pickFor(target);
    const existingCustom = state.customFor(target);
    const existingName = existingCustom?.name
      || (existingPickId ? (dataset.restaurants.find(r => r.id === existingPickId)?.name || existingPickId) : null);
    const row = el('button', { type: 'button', class: 'tr-move-row' });
    row.append(el('span', { class: 'tr-move-row-date' }, target.label || target.date));
    if (existingName) {
      row.append(el('span', { class: 'tr-move-row-existing' }, `Currently: ${existingName} \u2014 will be replaced`));
    } else {
      row.append(el('span', { class: 'tr-move-row-empty' }, 'No pick yet'));
    }
    row.addEventListener('click', () => {
      if (existingName && !confirm(`${target.label || target.date} already has "${existingName}". Replace it with ${restaurant.name}?`)) return;
      // Move pick
      const booking = state.bookingFor(fromNight);
      const note = state.notes?.[fromNight.date];
      state.setPick(fromNight, null);
      state.setBooked(fromNight, null);
      if (existingCustom) state.setCustom(target, null);
      state.setPick(target, restaurant.id);
      if (booking) state.setBooked(target, booking);
      if (note && state.notes) {
        state.notes[target.date] = note;
        delete state.notes[fromNight.date];
        state._save(state.keys.notes, state.notes);
        state._notify();
      }
      overlay.remove();
      rerender();
    });
    list.append(row);
  }
  sheet.append(list);

  const cancel = el('button', { type: 'button', class: 'tr-move-cancel' }, 'Cancel');
  cancel.addEventListener('click', () => overlay.remove());
  sheet.append(cancel);

  overlay.append(sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.append(overlay);
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
    const custom = state.customFor(night);
    if (custom) {
      // Custom reservations count as both picked and booked — the user
      // already arranged it themselves.
      picked += 1; booked += 1;
      continue;
    }
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

  // (a) Nothing picked yet — render nothing. The Dining tab's lede already
  // tells the user to pick a restaurant; a duplicate pill here was redundant.
  if (picked === 0) {
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
