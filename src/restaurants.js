/**
 * Trip-restaurants render module.
 *
 * Vanilla ES module — no React, no build step, no dependencies. Drop into any
 * trip itinerary site, point it at a dataset that matches /schema.json, and
 * call mountDiningTab() to render a full per-night tier-pickable dining tab.
 *
 *   import { mountDiningTab } from '@jhwiv/trip-restaurants';
 *   mountDiningTab({
 *     dataset: await (await fetch('santa-fe.json')).json(),
 *     mount:   document.querySelector('#dining'),
 *     storageKey: 'santafe-tier-choices', // optional: localStorage key for per-night tier picks
 *   });
 *
 * The module also exports primitives so a host app can render only parts
 * (e.g. just the reservation timeline) without the full tab.
 */

// ---------- public API ----------

export function mountDiningTab({ dataset, mount, storageKey = 'trip-restaurants-tier-choices' }) {
  const state = new TierState(dataset, storageKey);
  const root = el('div', { class: 'tr-dining' });
  root.append(renderHeaderBlurb(dataset));
  root.append(renderNights(dataset, state));
  mount.innerHTML = '';
  mount.append(root);
  return state;
}

/** Renders just the reservation timeline (urgent → less urgent) using the user's currently chosen tier per night. */
export function mountReservationTimeline({ dataset, mount, storageKey = 'trip-restaurants-tier-choices' }) {
  const state = new TierState(dataset, storageKey);
  const root = el('div', { class: 'tr-timeline' });
  root.append(renderTimeline(dataset, state));
  mount.innerHTML = '';
  mount.append(root);
  state.subscribe(() => {
    root.innerHTML = '';
    root.append(renderTimeline(dataset, state));
  });
  return state;
}

// ---------- state ----------

class TierState {
  constructor(dataset, storageKey) {
    this.dataset = dataset;
    this.storageKey = storageKey;
    this.choices = this._load();
    this._subs = new Set();
  }
  tierFor(night) {
    return this.choices[night.date] || night.defaultTier || firstAvailableTier(night);
  }
  setTier(night, tier) {
    if (!night.options[tier]) tier = nearestAvailableTier(night, tier);
    this.choices[night.date] = tier;
    this._save();
    for (const fn of this._subs) fn(this);
  }
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  _load() {
    if (typeof localStorage === 'undefined') return {};
    try { return JSON.parse(localStorage.getItem(this.storageKey)) || {}; }
    catch { return {}; }
  }
  _save() {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.choices)); } catch {}
  }
}

function firstAvailableTier(night) {
  for (const t of ['refined', 'elevated', 'signature']) {
    if (night.options[t]) return t;
  }
  return Object.keys(night.options)[0];
}
function nearestAvailableTier(night, wanted) {
  const order = ['refined', 'elevated', 'signature'];
  const idx = order.indexOf(wanted);
  for (let d = 0; d < order.length; d++) {
    for (const sign of [-1, 1]) {
      const t = order[idx + sign * d];
      if (t && night.options[t]) return t;
    }
  }
  return firstAvailableTier(night);
}

// ---------- render: header ----------

function renderHeaderBlurb(dataset) {
  const tierOrder = Object.entries(dataset.tiers || {});
  const wrap = el('div', { class: 'tr-header' });
  wrap.append(el('h2', {}, 'Dinners'));
  wrap.append(el('p', { class: 'tr-header-sub' },
    `Pick your tier per night. Tier choices save to this device so the rest of the app, including the reservation timeline, updates with you.`));
  const legend = el('div', { class: 'tr-legend' });
  for (const [id, t] of tierOrder) {
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
    const card = renderNightCard(dataset, night, state);
    wrap.append(card);
  }
  return wrap;
}

function renderNightCard(dataset, night, state) {
  const card = el('article', { class: 'tr-night', 'data-date': night.date });
  card.append(renderNightHeader(night));
  card.append(renderTierPicker(dataset, night, state, () => rerenderNight(card, dataset, night, state)));
  card.append(renderActivePick(dataset, night, state));
  return card;
}

function rerenderNight(card, dataset, night, state) {
  // Replace just the picker + active pick blocks
  card.querySelector('.tr-tier-picker')?.remove();
  card.querySelector('.tr-active-pick')?.remove();
  card.append(renderTierPicker(dataset, night, state, () => rerenderNight(card, dataset, night, state)));
  card.append(renderActivePick(dataset, night, state));
}

function renderNightHeader(night) {
  const h = el('header', { class: 'tr-night-head' });
  h.append(el('p', { class: 'tr-night-date' }, night.label || night.date));
  if (night.theme) h.append(el('p', { class: 'tr-night-theme' }, night.theme));
  return h;
}

function renderTierPicker(dataset, night, state, onChange) {
  const current = state.tierFor(night);
  const pick = el('div', { class: 'tr-tier-picker', role: 'tablist', 'aria-label': `Tier for ${night.label || night.date}` });
  for (const [tierId, tierDef] of Object.entries(dataset.tiers)) {
    const has = !!night.options[tierId];
    const isActive = current === tierId;
    const btn = el('button', {
      type: 'button',
      class: `tr-tier-btn ${isActive ? 'is-active' : ''} ${has ? '' : 'is-empty'}`,
      role: 'tab',
      'aria-selected': isActive ? 'true' : 'false',
      'data-tier': tierId,
    },
      el('span', { class: 'tr-tier-band' }, tierDef.priceBand),
      el('span', { class: 'tr-tier-label' }, tierDef.label),
    );
    if (!has) btn.setAttribute('aria-disabled', 'true');
    btn.addEventListener('click', () => {
      state.setTier(night, tierId);
      onChange();
    });
    pick.append(btn);
  }
  return pick;
}

function renderActivePick(dataset, night, state) {
  const tier = state.tierFor(night);
  const r = night.options[tier];
  const block = el('div', { class: 'tr-active-pick' });
  if (!r) {
    block.append(el('p', { class: 'tr-missing' }, 'No restaurant configured at this tier yet.'));
    return block;
  }
  // Fallback notice
  const requested = state.choices[night.date];
  if (requested && requested !== tier) {
    block.append(el('p', { class: 'tr-fallback-note' },
      `No ${dataset.tiers[requested]?.label || requested} option for this night — showing ${dataset.tiers[tier].label} instead.`));
  }
  block.append(renderRestaurantCard(r));
  return block;
}

function renderRestaurantCard(r) {
  const card = el('div', { class: 'tr-restaurant', 'data-id': r.id });
  card.append(el('h3', { class: 'tr-name' }, r.name));
  const meta = el('p', { class: 'tr-meta' });
  if (r.cuisine) meta.append(el('span', {}, r.cuisine));
  if (r.neighborhood) meta.append(el('span', {}, ' · ' + r.neighborhood));
  if (r.priceBand) meta.append(el('span', { class: 'tr-meta-price' }, ' · ' + r.priceBand));
  card.append(meta);

  if (r.notes?.length) {
    const ul = el('ul', { class: 'tr-notes' });
    for (const n of r.notes) ul.append(el('li', {}, n));
    card.append(ul);
  }

  const actions = el('div', { class: 'tr-actions' });
  actions.append(renderBookingButton(r));
  if (r.phone) actions.append(el('a', { class: 'tr-btn-secondary', href: 'tel:' + r.phone }, formatPhone(r.phone)));
  if (r.website) actions.append(el('a', { class: 'tr-btn-link', href: r.website, target: '_blank', rel: 'noopener' }, 'Website ↗'));
  card.append(actions);

  if (r.booking?.note) card.append(el('p', { class: 'tr-booking-note' }, r.booking.note));
  if (r.booking?.rooftopWalkInOnly) card.append(el('p', { class: 'tr-booking-note' }, 'Rooftop seating is walk-in only — OpenTable books the main floor.'));
  return card;
}

function renderBookingButton(r) {
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
  return el('a', { class: 'tr-btn-primary', href: b.url, target: '_blank', rel: 'noopener' }, labels[b.platform] || 'Reserve ↗');
}

// ---------- render: reservation timeline ----------

function renderTimeline(dataset, state) {
  const tierLead = dataset.tiers;
  const rows = [];
  for (const night of dataset.nights) {
    const tier = state.tierFor(night);
    const r = night.options[tier];
    if (!r) continue;
    const lead = r.booking?.leadTime || tierLead[tier]?.leadTime || '';
    rows.push({ night, r, tier, lead, urgency: urgencyScore(lead, r.booking?.platform) });
  }
  rows.sort((a, b) => b.urgency - a.urgency);

  const list = el('ol', { class: 'tr-timeline-list' });
  for (const { night, r, tier, lead } of rows) {
    const li = el('li', { class: 'tr-timeline-row' });
    li.append(el('span', { class: `tr-timeline-badge tr-urgency-${urgencyClass(lead)}` }, badgeFor(lead, r.booking?.platform)));
    const body = el('div', { class: 'tr-timeline-body' });
    body.append(el('p', { class: 'tr-timeline-name' },
      `${r.name} · ${night.label || night.date}${night.time ? ', ' + night.time : ''}`,
      el('span', { class: 'tr-timeline-tier-tag' }, ` · ${dataset.tiers[tier]?.label || tier}`),
    ));
    const note = r.booking?.note || (r.notes?.[0]) || '';
    body.append(el('p', { class: 'tr-timeline-note' },
      lead ? `Book ${lead}. ` : '',
      note + ' ',
      r.phone ? el('a', { href: 'tel:' + r.phone }, formatPhone(r.phone)) : null,
    ));
    li.append(body);
    list.append(li);
  }
  return list;
}

function urgencyScore(lead, platform) {
  if (platform === 'walkin') return 0;
  if (platform === 'phone') return 60;
  if (!lead) return 50;
  const l = lead.toLowerCase();
  if (l.includes('6')) return 100;
  if (l.includes('4')) return 90;
  if (l.includes('2 week') || l.includes('2-week')) return 70;
  if (l.includes('week')) return 65;
  if (l.includes('day') || l.includes('same')) return 30;
  return 50;
}
function urgencyClass(lead) {
  const s = urgencyScore(lead);
  if (s >= 90) return 'high';
  if (s >= 60) return 'med';
  return 'low';
}
function badgeFor(lead, platform) {
  if (platform === 'walkin') return 'Walk-in';
  if (urgencyScore(lead, platform) >= 90) return 'Book now';
  if (urgencyScore(lead, platform) >= 60) return 'Soon';
  return 'Day-of';
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
  // +15059821500 → (505) 982-1500
  const m = String(p).match(/^\+?1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(p);
}
