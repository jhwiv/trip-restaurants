// Tests for the confirmationUrl field on bookings + the isValidHttpUrl helper.

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

function loadModule() {
  const localStorage = new MemStore();
  global.localStorage = localStorage;
  global.window = { addEventListener() {}, removeEventListener() {} };
  global.document = { createElement: () => ({}), createTextNode: () => ({}) };
  const ctx = { module: { exports: {} }, exports: {} };
  const fn = new Function('module', 'exports', 'localStorage',
    src + '\nmodule.exports.PickerState = PickerState;\nmodule.exports.isValidHttpUrl = isValidHttpUrl;');
  fn(ctx.module, ctx.exports, localStorage);
  return { ...ctx.module.exports, store: localStorage };
}

test('isValidHttpUrl accepts http and https', () => {
  const { isValidHttpUrl } = loadModule();
  assert.equal(isValidHttpUrl('https://example.com'), true);
  assert.equal(isValidHttpUrl('http://example.com/path?q=1'), true);
  assert.equal(isValidHttpUrl('https://opentable.com/r/anasazi'), true);
});

test('isValidHttpUrl rejects invalid, malicious, and empty inputs', () => {
  const { isValidHttpUrl } = loadModule();
  assert.equal(isValidHttpUrl(''), false);
  assert.equal(isValidHttpUrl(null), false);
  assert.equal(isValidHttpUrl(undefined), false);
  assert.equal(isValidHttpUrl('viator.com'), false, 'no protocol = invalid');
  assert.equal(isValidHttpUrl('javascript:alert(1)'), false, 'XSS vector blocked');
  assert.equal(isValidHttpUrl('ftp://example.com'), false);
  assert.equal(isValidHttpUrl('data:text/html,<script>'), false);
  assert.equal(isValidHttpUrl('  '), false);
  assert.equal(isValidHttpUrl(42), false);
});

test('booking with confirmationUrl round-trips through localStorage', () => {
  const { PickerState, store } = loadModule();
  // Mark migration done so it doesn't interfere
  store.setItem('test-mig-tierpicker-2026-05', '1');
  const state = new PickerState(dataset, 'test');
  const night = dataset.nights[0];
  state.setBooked(night, {
    confirmation: 'OT-12345',
    confirmationUrl: 'https://opentable.com/r/anasazi/conf-12345',
    bookedAt: '2026-05-31T00:00:00Z'
  });
  // Reload state from storage
  const state2 = new PickerState(dataset, 'test');
  const reloaded = state2.bookingFor(night);
  assert.equal(reloaded.confirmation, 'OT-12345');
  assert.equal(reloaded.confirmationUrl, 'https://opentable.com/r/anasazi/conf-12345');
  assert.equal(reloaded.bookedAt, '2026-05-31T00:00:00Z');
});

test('legacy booking (no confirmationUrl field) loads without errors', () => {
  const { PickerState, store } = loadModule();
  store.setItem('test-mig-tierpicker-2026-05', '1');
  // Pre-existing booking from before the URL feature shipped
  store.setItem('test-bookings', JSON.stringify({
    '2026-06-03': { confirmation: 'LEGACY-999', bookedAt: '2026-05-15T10:00:00Z' }
  }));
  const state = new PickerState(dataset, 'test');
  const booking = state.bookingFor({ date: '2026-06-03' });
  assert.equal(booking.confirmation, 'LEGACY-999');
  assert.equal(booking.confirmationUrl, undefined, 'no URL field on legacy bookings');
});

test('confirmationUrl can be added to existing booking without losing other fields', () => {
  const { PickerState, store } = loadModule();
  store.setItem('test-mig-tierpicker-2026-05', '1');
  const state = new PickerState(dataset, 'test');
  const night = dataset.nights[0];
  // Existing booking (no URL)
  state.setBooked(night, { confirmation: 'ABC', bookedAt: '2026-05-15T10:00:00Z' });
  const before = state.bookingFor(night);
  // Now add URL (simulating the "Add link" inline editor)
  state.setBooked(night, { ...before, confirmationUrl: 'https://example.com/conf' });
  const after = state.bookingFor(night);
  assert.equal(after.confirmation, 'ABC', 'confirmation # preserved');
  assert.equal(after.bookedAt, '2026-05-15T10:00:00Z', 'bookedAt preserved');
  assert.equal(after.confirmationUrl, 'https://example.com/conf');
});

test('confirmationUrl can be cleared (set to null) without un-booking', () => {
  const { PickerState, store } = loadModule();
  store.setItem('test-mig-tierpicker-2026-05', '1');
  const state = new PickerState(dataset, 'test');
  const night = dataset.nights[0];
  state.setBooked(night, {
    confirmation: 'XYZ',
    confirmationUrl: 'https://example.com/foo',
    bookedAt: '2026-05-15T10:00:00Z'
  });
  const before = state.bookingFor(night);
  state.setBooked(night, { ...before, confirmationUrl: null });
  const after = state.bookingFor(night);
  assert.ok(after, 'booking still exists');
  assert.equal(after.confirmation, 'XYZ', 'confirmation # preserved');
  assert.equal(after.confirmationUrl, null);
});
