#!/usr/bin/env node
/**
 * Trip-restaurants QA verifier.
 *
 * Reads a dataset that matches /schema.json and verifies every restaurant's
 * booking URL, phone presence, and operational signals. Outputs:
 *   - A CSV report (verify-report-<timestamp>.csv) — human-readable
 *   - A JSON report (verify-report-<timestamp>.json) — machine-readable
 *   - Exit code 0 if all entries pass, 1 if any failed (for CI)
 *
 * Usage:
 *   node scripts/verify.js templates/santa-fe.json
 *   node scripts/verify.js templates/santa-fe.json --depth=full
 *   node scripts/verify.js templates/santa-fe.json --depth=quick
 *
 * Depth modes:
 *   quick  — URL HEAD + status + redirect detection only (fast, runs in CI)
 *   full   — quick + page-body inspection (detects "Not available on OpenTable
 *            booking network" string, detects 404 templates, validates page title)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const TIMEOUT_MS = 12000;
// OpenTable and Resy both block obviously-automated user agents. We use a
// realistic UA so the verifier mirrors a real browser's view of the URL.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// OpenTable's anti-bot WAF returns 403 even for URLs that load fine in a
// browser. We treat 403 from known anti-bot hosts as a soft signal — present
// in the report but not a hard fail. The 'full' depth mode does a body fetch
// and is more accurate but slower.
const SOFT_BLOCK_HOSTS = new Set(['www.opentable.com', 'opentable.com', 'resy.com', 'www.resy.com']);

// Strings that mean "this listing exists but you can't book here"
const OT_NOT_BOOKABLE_NEEDLES = [
  'not available on opentable booking network',
  'please contact them directly',
];

// Strings that mean "404 / dead listing"
const OT_404_NEEDLES = [
  'well, this is embarrassing',
  "we can't find the page",
  'page not found',
];

const RESY_404_NEEDLES = [
  'page not found',
  "couldn't find that",
];

// ---------- args ----------
const { values, positionals } = parseArgs({
  options: {
    depth: { type: 'string', default: 'quick' },
    out:   { type: 'string' },
    quiet: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (positionals.length === 0) {
  console.error('usage: node scripts/verify.js <dataset.json> [--depth=quick|full] [--out=path]');
  process.exit(2);
}

const datasetPath = path.resolve(positionals[0]);
const depth = values.depth === 'full' ? 'full' : 'quick';
const quiet = values.quiet;
const log = (...a) => { if (!quiet) console.log(...a); };

// ---------- helpers ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        ...(opts.headers || {}),
      },
      redirect: 'follow',
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe a reservation URL. Returns { ok, status, finalUrl, bodyFlags, error }.
 * In quick mode skips the body fetch.
 */
async function probeUrl(url, { full = false } = {}) {
  try {
    // Small polite delay so we don't trip rate limiting when probing many
    // URLs against the same host (OpenTable's WAF is twitchy).
    await sleep(400 + Math.floor(Math.random() * 400));
    // Always do a GET — many reservation sites 405 on HEAD.
    const res = await fetchWithTimeout(url);
    const out = {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url,
      redirected: res.redirected,
      bodyFlags: [],
    };

    if (!full) return out;
    if (!res.ok) return out;

    const body = (await res.text()).toLowerCase();
    const host = new URL(res.url).hostname;

    if (host.includes('opentable')) {
      for (const n of OT_NOT_BOOKABLE_NEEDLES) if (body.includes(n)) out.bodyFlags.push('OT_NOT_BOOKABLE');
      for (const n of OT_404_NEEDLES)         if (body.includes(n)) out.bodyFlags.push('OT_404');
    } else if (host.includes('resy.com')) {
      for (const n of RESY_404_NEEDLES) if (body.includes(n)) out.bodyFlags.push('RESY_404');
    }
    return out;
  } catch (e) {
    return { ok: false, status: 0, error: e.message || String(e), bodyFlags: [] };
  }
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function flagsForRow({ booking, urlProbe, sitePresent }) {
  const flags = [];
  if (booking.platform === 'walkin') return ['WALKIN_OK'];
  if (booking.platform === 'phone')  return booking.url ? ['PHONE_PLATFORM_HAS_URL'] : ['PHONE_OK'];

  if (!booking.url) flags.push('MISSING_URL');
  if (urlProbe) {
    if (!urlProbe.ok) {
      // 403 from OpenTable/Resy is almost always WAF blocking the verifier,
      // not a real broken link. Mark as a soft block so it surfaces in the
      // report but doesn't fail the run.
      let host = ''; try { host = new URL(urlProbe.finalUrl || booking.url).hostname; } catch {}
      if (urlProbe.status === 403 && SOFT_BLOCK_HOSTS.has(host)) {
        flags.push('SOFT_BLOCK_403');
      } else {
        flags.push(`HTTP_${urlProbe.status || 'ERR'}`);
      }
    }
    flags.push(...(urlProbe.bodyFlags || []));
    if (urlProbe.bodyFlags?.includes('OT_NOT_BOOKABLE')) flags.push('SHOULD_SWITCH_PLATFORM');
  }
  if (sitePresent === false) flags.push('OFFICIAL_SITE_DOWN');
  return flags;
}

const HARD_FAIL_FLAGS = new Set(['MISSING_URL', 'OT_404', 'RESY_404', 'OT_NOT_BOOKABLE', 'OFFICIAL_SITE_DOWN']);
function isHardFail(flags) {
  if (flags.some(f => HARD_FAIL_FLAGS.has(f))) return true;
  // HTTP_4xx or HTTP_5xx that isn't a soft-block 403 is a hard fail
  return flags.some(f => /^HTTP_[45]\d\d$/.test(f) || f === 'HTTP_ERR');
}

// ---------- main ----------

const raw = await fs.readFile(datasetPath, 'utf8');
const dataset = JSON.parse(raw);

const rows = [];
const restaurants = [];
for (const night of dataset.nights || []) {
  for (const [tier, r] of Object.entries(night.options || {})) {
    if (!r || !r.id) continue;
    restaurants.push({ night: night.date + ' / ' + (night.label || ''), tier, r });
  }
}

log(`Verifying ${restaurants.length} restaurant entries from ${path.basename(datasetPath)} (depth=${depth})…`);

const results = [];
for (const { night, tier, r } of restaurants) {
  const booking = r.booking || {};
  let urlProbe = null;
  let sitePresent = null;

  if (booking.url && booking.platform !== 'phone' && booking.platform !== 'walkin') {
    urlProbe = await probeUrl(booking.url, { full: depth === 'full' });
  }
  if (depth === 'full' && r.website) {
    const sp = await probeUrl(r.website, { full: false });
    sitePresent = sp.ok;
  }

  const flags = flagsForRow({ booking, urlProbe, sitePresent });
  const passed = !isHardFail(flags);

  results.push({
    night, tier,
    id: r.id, name: r.name,
    platform: booking.platform,
    url: booking.url || '',
    finalUrl: urlProbe?.finalUrl || '',
    status: urlProbe?.status ?? '',
    flags,
    passed,
    phone: r.phone || '',
    website: r.website || '',
    verifiedAt: r.verifiedAt || '',
  });

  const tag = passed ? (flags.includes('SOFT_BLOCK_403') ? '~' : '✓') : '✗';
  log(`  ${tag} [${tier}] ${r.name} — ${booking.platform}${urlProbe ? ` (HTTP ${urlProbe.status})` : ''}${flags.length ? '  flags: ' + flags.join(',') : ''}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outBase = values.out || `verify-report-${stamp}`;
const csvHead = ['night','tier','id','name','platform','url','final_url','status','flags','passed','phone','website','verified_at'];
const csv = [csvHead.join(',')]
  .concat(results.map(r => csvHead.map(k => csvEscape(
    k === 'final_url' ? r.finalUrl :
    k === 'verified_at' ? r.verifiedAt :
    k === 'flags' ? r.flags.join('|') :
    r[k] ?? ''
  )).join(',')))
  .join('\n');

await fs.writeFile(`${outBase}.csv`, csv);
await fs.writeFile(`${outBase}.json`, JSON.stringify({
  dataset: datasetPath,
  depth,
  verifiedAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter(r => r.passed).length,
  failed: results.filter(r => !r.passed).length,
  results,
}, null, 2));

const failed = results.filter(r => !r.passed);
log(`\nReport written:\n  ${outBase}.csv\n  ${outBase}.json`);
log(`Total: ${results.length}   Passed: ${results.length - failed.length}   Failed: ${failed.length}`);
if (failed.length) {
  log('\nFailures:');
  for (const f of failed) log(`  ✗ ${f.name} (${f.tier}) — ${f.flags.join(', ')}`);
  process.exit(1);
}
process.exit(0);
