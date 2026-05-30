// Defensive-fix regression tests for PickerState
// Covers the May 30 fix that prevented the curated-seed migration from
// wiping users' real picks (Pia bug), the orphan-pick self-heal, and
// idempotency of the migration flag.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemStore {
  constructor() { this.data = {}; }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; }
  setItem(k, v) { this.data[k] = String(v); }
  removeItem(k) { delete this.data[k]; }
}

const src = readFileSync(new URL('../src/restaurants.js', import.meta.url), 'utf8')
  .replace(/^export\s+/gm, '');
const dataset = JSON.parse(readFileSync(new URL('../templates/santa-fe.json', import.meta.url), 'utf8'));

const CURATED_SEED = [
  'anasazi-restaurant', 'the-compound-restaurant',
  'geronimo-canyon', 'luminaria-loretto', 'coyote-cafe-rooftop',
  'josephs-culinary-pub', 'restaurant-martin-farewell-tasting',
];

function buildSeedPicks() {
  const obj = {};
  dataset.nights.forEach((n, i) => { obj[n.date] = CURATED_SEED[i]; });
  return obj;
}

function buildState(setup) {
  const localStorage = new MemStore();
  setup(localStorage);
  global.localStorage = localStorage;
  global.window = { addEventListener() {}, removeEventListener() {} };
  global.document = { createElement: () => ({}), createTextNode: () => ({}) };
  const ctx = { module: { exports: {} }, exports: {} };
  const fn = new Function('module', 'exports', 'localStorage',
    src + '\nmodule.exports.PickerState = PickerState;');
  fn(ctx.module, ctx.exports, localStorage);
  return { state: new ctx.module.exports.PickerState(dataset, 'test'), store: localStorage };
}

test('migration wipes pristine seed picks (no other engagement)', () => {
  const { state, store } = buildState(s =>
    s.setItem('test-picks', JSON.stringify(buildSeedPicks())));
  assert.deepEqual(state.picks, {});
  assert.equal(store.getItem('test-mig-tierpicker-2026-05'), '1');
});

test('migration preserves picks when user has notes', () => {
  const { state } = buildState(s => {
    s.setItem('test-picks', JSON.stringify(buildSeedPicks()));
    s.setItem('test-notes', JSON.stringify({ '2026-06-03': 'birthday dinner' }));
  });
  assert.equal(Object.keys(state.picks).length, 7);
});

test('migration preserves picks when user has bookings', () => {
  const { state } = buildState(s => {
    s.setItem('test-picks', JSON.stringify(buildSeedPicks()));
    s.setItem('test-bookings', JSON.stringify({ '2026-06-03': { confirmation: 'ABC' } }));
  });
  assert.equal(Object.keys(state.picks).length, 7);
});

test('migration preserves picks when party is overridden', () => {
  const { state } = buildState(s => {
    s.setItem('test-picks', JSON.stringify(buildSeedPicks()));
    s.setItem('test-party', JSON.stringify({ size: 4, defaultTime: '20:00' }));
  });
  assert.equal(Object.keys(state.picks).length, 7);
});

test('migration preserves user picks that do not match curated seed (Pia bug)', () => {
  const customPicks = {};
  const otherIds = ['the-shed-santa-fe', 'sazon-santa-fe', 'la-boca-santa-fe', 'wolf-and-roadrunner',
                    'zacatlan-santa-fe', 'izanami-ten-thousand-waves', 'cafe-pasquals'];
  dataset.nights.forEach((n, i) => { customPicks[n.date] = otherIds[i]; });
  const { state } = buildState(s => s.setItem('test-picks', JSON.stringify(customPicks)));
  assert.equal(Object.keys(state.picks).length, 7);
});

test('orphan picks (deleted restaurant IDs) are self-healed on load', () => {
  const { state } = buildState(s => {
    s.setItem('test-picks', JSON.stringify({
      '2026-06-03': 'restaurant-that-does-not-exist',
      '2026-06-04': 'the-shed-santa-fe',
    }));
    s.setItem('test-mig-tierpicker-2026-05', '1');
  });
  assert.equal(state.picks['2026-06-03'], undefined, 'Orphan dropped');
  assert.equal(state.picks['2026-06-04'], 'the-shed-santa-fe', 'Valid kept');
});

test('migration flag is idempotent (only runs once)', () => {
  const { state } = buildState(s => {
    s.setItem('test-picks', JSON.stringify(buildSeedPicks()));
    s.setItem('test-mig-tierpicker-2026-05', '1');
  });
  assert.equal(Object.keys(state.picks).length, 7);
});
