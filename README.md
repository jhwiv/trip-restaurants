# @jhwiv/trip-restaurants

Reusable per-night restaurant tier picker for the trip itinerary apps (santafejune.com, zurich-weekend.com, maritimesgrandloop.com, …).

Lets the traveler pick one of three tiers **per night**:

- **Refined** ($$) — neighborhood favorites, no jacket required
- **Elevated** ($$$) — destination tables, chef-driven menus
- **Signature** ($$$$) — flagship rooms, reservations weeks ahead

The choice persists in `localStorage` so it survives reloads.

## Why a module

Across builds I kept hand-rolling restaurant cards, hand-checking OpenTable / Resy links, and missing the URL drift OpenTable does every few months (`/r/<slug>-santa-fe` → `/<slug>-santa-fe`). This bundles:

1. A **JSON schema** for trip restaurant data
2. A **render module** that drops a Dining tab and a Reservation Timeline into any trip page
3. A **verify script** that QAs every link + phone on a schedule (weekly cron in this repo, or wire into the host trip repo)

## Install (as a submodule for now)

```bash
git submodule add https://github.com/jhwiv/trip-restaurants.git modules/restaurants
```

Then in the host page:

```html
<link rel="stylesheet" href="modules/restaurants/src/restaurants.css">
<script type="module">
  import { mountDiningTab, mountReservationTimeline } from './modules/restaurants/src/restaurants.js';
  const data = await fetch('./restaurants.json').then(r => r.json());
  mountDiningTab(document.getElementById('dining'), data);
  mountReservationTimeline(document.getElementById('timeline'), data);
</script>
```

See `demo/index.html` for a working example.

## Data shape

See `schema.json`. Minimum:

```json
{
  "trip": { "slug": "santa-fe", "name": "Santa Fe – June 2026" },
  "tiers": [
    { "id": "refined",   "label": "Refined",   "priceBand": "$$" },
    { "id": "elevated",  "label": "Elevated",  "priceBand": "$$$" },
    { "id": "signature", "label": "Signature", "priceBand": "$$$$" }
  ],
  "nights": [
    {
      "date": "2026-06-12",
      "label": "Night 1 · Friday",
      "defaultTier": "signature",
      "picks": {
        "refined":   { "restaurantId": "the-shed" },
        "elevated":  { "restaurantId": "joseph-s" },
        "signature": { "restaurantId": "geronimo" }
      }
    }
  ],
  "restaurants": [
    {
      "id": "geronimo",
      "name": "Geronimo",
      "priceBand": "$$$$",
      "address": "724 Canyon Rd, Santa Fe, NM",
      "phone": "(505) 982-1500",
      "booking": { "platform": "opentable", "url": "https://www.opentable.com/geronimo-santa-fe" },
      "verificationStatus": "verified",
      "lastVerifiedAt": "2026-05-25"
    }
  ]
}
```

`verificationStatus` is one of `verified | candidate | broken | retired`. The weekly verifier promotes / demotes entries.

## Scripts

```bash
npm run verify          # quick check (HEAD requests, OT/Resy reachability)
npm run verify:full     # full check including phone format validation
npm test                # unit tests
```

The verifier emits `verify-report-<timestamp>.csv` and `.json`. OpenTable / Resy WAF 403s are recorded as `SOFT_BLOCK_403` (warning), not failures — real failures are `MISSING_URL`, `HTTP_404`, `OT_NOT_BOOKABLE`, or `OFFICIAL_SITE_DOWN`.

## Weekly cron

`.github/workflows/verify-weekly.yml` runs every Monday 14:00 UTC and opens an issue if anything fails.

## Status of `templates/santa-fe.json`

| Tier | Entries | Status |
|---|---|---|
| Signature | 6 | ✅ Verified May 25, 2026 (Anasazi, Compound/Resy, Geronimo, Luminaria, Coyote, Luminaria farewell) |
| Elevated | 5 | 🟡 Candidate — needs QA pass before use |
| Refined | 7 | 🟡 Candidate — needs QA pass before use |

The Signature tier is what's currently live on santafejune.com. Refined and Elevated are placeholders that render correctly but their URLs / phones / hours have **not** been independently checked. Run the same QA pass we did for Signature before relying on them.
