/**
 * Sanity tests for verify.js. Uses local fixtures + a mocked fetch so the
 * test runs offline and deterministically in CI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../scripts/verify.js', import.meta.url).pathname;

function makeFixture() {
  return {
    trip: { city: 'Testville', startDate: '2030-01-01', endDate: '2030-01-02' },
    tiers: {
      refined:   { label: 'Refined',   priceBand: '$$' },
      elevated:  { label: 'Elevated',  priceBand: '$$$' },
      signature: { label: 'Signature', priceBand: '$$$$' },
    },
    nights: [{
      date: '2030-01-01', label: 'Night 1', options: {
        // walk-in entries should always pass without a network call
        refined: {
          id: 'walkin-spot', name: 'Walk-In Spot', city: 'Testville',
          address: 'X', phone: '+10000000000', website: 'https://example.com',
          booking: { platform: 'walkin' }, verifiedAt: '2026-05-25',
        },
        // phone entries should also pass
        elevated: {
          id: 'phone-spot', name: 'Phone Spot', city: 'Testville',
          address: 'X', phone: '+10000000000', website: 'https://example.com',
          booking: { platform: 'phone' }, verifiedAt: '2026-05-25',
        },
        // bogus URL — verifier should flag this as failed
        signature: {
          id: 'broken-spot', name: 'Broken Spot', city: 'Testville',
          address: 'X', phone: '+10000000000', website: 'https://example.com',
          booking: { platform: 'opentable', url: 'https://opentable.invalid/does-not-exist' },
          verifiedAt: '2026-05-25',
        },
      }
    }]
  };
}

function makePoolFixture() {
  return {
    trip: { city: 'Testville', startDate: '2030-01-01', endDate: '2030-01-02' },
    tiers: {
      refined:   { label: 'Refined',   priceBand: '$$' },
      elevated:  { label: 'Elevated',  priceBand: '$$$' },
      signature: { label: 'Signature', priceBand: '$$$$' },
    },
    restaurants: [
      { id: 'walkin-spot', tier: 'refined', name: 'Walk-In Spot', city: 'Testville',
        address: 'X', phone: '+10000000000', website: 'https://example.com',
        booking: { platform: 'walkin' }, verifiedAt: '2026-05-25' },
      { id: 'phone-spot', tier: 'elevated', name: 'Phone Spot', city: 'Testville',
        address: 'X', phone: '+10000000000', website: 'https://example.com',
        booking: { platform: 'phone' }, verifiedAt: '2026-05-25' },
      { id: 'broken-spot', tier: 'signature', name: 'Broken Spot', city: 'Testville',
        address: 'X', phone: '+10000000000', website: 'https://example.com',
        booking: { platform: 'opentable', url: 'https://opentable.invalid/does-not-exist' },
        verifiedAt: '2026-05-25' },
    ],
    nights: [{ date: '2030-01-01', label: 'Night 1' }],
  };
}

test('verify.js (pool schema) passes walk-in/phone, fails bogus URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trip-rest-pool-'));
  const fix = join(dir, 'fixture.json');
  writeFileSync(fix, JSON.stringify(makePoolFixture()));
  const out = join(dir, 'report');

  const r = spawnSync('node', [SCRIPT, fix, '--out=' + out, '--quiet'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  const report = JSON.parse(readFileSync(out + '.json', 'utf8'));
  assert.equal(report.total, 3);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 1);
  assert.ok(report.results.find(x => x.id === 'broken-spot' && !x.passed));
});

test('verify.js (legacy schema) passes walk-in and phone, fails bogus URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trip-rest-'));
  const fix = join(dir, 'fixture.json');
  writeFileSync(fix, JSON.stringify(makeFixture()));
  const out = join(dir, 'report');

  const r = spawnSync('node', [SCRIPT, fix, '--out=' + out, '--quiet'], { encoding: 'utf8' });

  // Exit code should be 1 because the signature entry has a bogus URL
  assert.equal(r.status, 1, 'expected non-zero exit because one entry is broken');

  const report = JSON.parse(readFileSync(out + '.json', 'utf8'));
  assert.equal(report.total, 3);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 1);

  const broken = report.results.find(x => x.id === 'broken-spot');
  assert.ok(broken && !broken.passed, 'broken-spot must fail');
  assert.ok(broken.flags.length > 0, 'broken-spot must carry at least one flag');

  const walkin = report.results.find(x => x.id === 'walkin-spot');
  assert.ok(walkin.passed, 'walkin-spot must pass');

  const phone = report.results.find(x => x.id === 'phone-spot');
  assert.ok(phone.passed, 'phone-spot must pass');
});
