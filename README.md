# @jhwiv/trip-restaurants

Reusable per-night restaurant picker for trip itinerary apps. Currently powering [santafejune.com](https://santafejune.com); designed to drop into [zurich-weekend.com](https://zurich-weekend.com), [maritimesgrandloop.com](https://maritimesgrandloop.com), and any other future Grand Loop / Trip Optimizer property.

It gives a traveler this flow, per night:

1. Pick a **price tier** — Refined ($$), Elevated ($$$), or Signature ($$$$)
2. Pick a **restaurant** from a short list filtered to that tier, sorted by walk distance from the hotel
3. The picked card shows booking buttons (OpenTable / Resy / phone), hours, a "Mark as booked" confirmation form, and notes
4. A **backup** restaurant is suggested below the pick — same tier or lower, never higher
5. Picks sync to `localStorage` and bubble out to other parts of the host page (day tabs, condensed view, reservation timeline)

No build step, no framework, no dependencies. Drop in two `<div>` mounts and a 50-line script block.

## Quick start

```html
<!-- 1. Theme variables (optional, but recommended) -->
<style>
  :root {
    --tr-rust: #a44d2b;
    --tr-gold: #b8862c;
    --tr-green: #4a7a5c;
    --tr-ink: #1c1815;
    --tr-card: #fdfaf3;
    --tr-rule: #d9cdb2;
    --tr-muted: #4a4338;
  }
</style>

<!-- 2. Module styles -->
<link rel="stylesheet" href="./modules/restaurants/src/restaurants.css">

<!-- 3. Mount points -->
<div id="tr-timeline-mount"></div>
<div id="tr-dining-mount"></div>

<!-- 4. Script block -->
<script type="module">
  import { mountDiningTab, mountReservationTimeline }
    from './modules/restaurants/src/restaurants.js';

  const STORAGE_KEY = 'mytrip-restaurants';
  const dataset = await fetch('./my-trip.json').then(r => r.json());

  mountDiningTab({
    dataset,
    mount: document.getElementById('tr-dining-mount'),
    storageKey: STORAGE_KEY,
  });

  mountReservationTimeline({
    dataset,
    mount: document.getElementById('tr-timeline-mount'),
    storageKey: STORAGE_KEY,
  });
</script>
```

That's a fully functional Dining tab. See [`demo/index.html`](./demo/index.html) for a runnable example and the bottom of [santafejune.com's `index.html`](https://github.com/jhwiv/santafe-itinerary/blob/main/index.html) for a production integration that also syncs picks into per-day cards and a condensed view.

## Public API

The module exports three things:

### `mountDiningTab({ dataset, mount, storageKey })`

Renders the full Dining tab — heading, collapsed "Trip settings" disclosure (party size, default dinner time, tier legend), and one expandable card per night. Returns a `PickerState` instance you can ignore in most cases.

| arg | type | required | notes |
|---|---|---|---|
| `dataset` | object | yes | The trip JSON (schema below) |
| `mount` | `HTMLElement` | yes | An empty `<div>` to render into |
| `storageKey` | string | yes | Namespace for localStorage — derives `<key>-picks`, `-bookings`, `-notes`, `-party` |

### `mountReservationTimeline({ dataset, mount, storageKey })`

Renders a compact status line: *"3 of 7 nights picked · 1 booked"* with an urgency chip when reservations need to be made this week. Renders nothing when no picks exist yet. Same arg shape as `mountDiningTab` — pass the same `storageKey`.

### `buildBookingUrl(restaurant, night, party)`

Returns a deep-link URL with `dateTime` (OpenTable) or `date` (Resy) and `covers`/`seats` prefilled from `night.date`, `night.time`, and `party.size`. Returns the raw `booking.url` if no platform-specific prefill is supported. Useful if you want a "Book all my nights" outbound bundle (SMS, email, calendar) from the host page.

## Dataset shape

One JSON file per trip. Schema:

```jsonc
{
  "trip": {
    "slug": "santa-fe-june-2026",
    "name": "Santa Fe \u2014 June 2026",
    "hotel": {
      "name": "Inn on the Alameda",
      "address": "303 E Alameda St, Santa Fe, NM 87501",
      "lat": 35.6840,
      "lon": -105.9376
    },
    "party": { "size": 1, "defaultTime": "19:00" }
  },

  "tiers": {
    "refined":   { "label": "Refined",   "priceBand": "$$",   "blurb": "Local, lived-in, food-first." },
    "elevated":  { "label": "Elevated",  "priceBand": "$$$",  "blurb": "Polished, real night out." },
    "signature": { "label": "Signature", "priceBand": "$$$$", "blurb": "Special-occasion." }
  },

  "nights": [
    {
      "date": "2026-06-03",
      "label": "Wed Jun 3 \u2014 Arrival Dinner",
      "theme": "Near the Plaza, low-key after the flight.",
      "time": "7:00 PM",
      "backup": "alkeme-santa-fe"   // optional curated fallback
    }
  ],

  "restaurants": [
    {
      "id": "sazon-santa-fe",
      "name": "Saz\u00f3n",
      "tier": "signature",                 // matches a key in `tiers`
      "cuisine": "Contemporary Mexican",
      "neighborhood": "Plaza",
      "address": "221 Shelby St, Santa Fe, NM 87501",
      "lat": 35.6852, "lon": -105.9376,
      "phone": "(505) 983-8604",
      "website": "https://sazonsantafe.com",
      "priceRange": "$95\u2013145 pp",
      "booking": {
        "platform": "opentable",           // 'opentable' | 'resy' | 'phone' | null
        "url": "https://www.opentable.com/r/sazon-santa-fe"
      },
      "hours": {                            // 0=Sun \u2026 6=Sat; omit a day to mark closed
        "1": "17:00-21:00", "2": "17:00-21:00", "3": "17:00-21:00",
        "4": "17:00-21:00", "5": "17:00-22:00", "6": "17:00-22:00"
      },
      "travelFromHotel": {                  // populated by scripts/route.js
        "walkMinutes": 9,
        "miles": 0.4,
        "mode": "walk"                      // 'walk' | 'short-uber' | 'uber'
      },
      "notes": [
        "Chef Fernando Olea \u2014 2022 James Beard Best Chef Southwest",
        "#1 restaurant in Santa Fe on Tripadvisor"
      ],
      "leadTime": "3-4 weeks"               // used by reservation timeline
    }
  ]
}
```

**Required fields per restaurant:** `id`, `name`, `tier`, `address`, `booking.url` (or `phone` for phone-only spots). Everything else is optional but heavily affects how the card renders.

**Required fields per night:** `date` (ISO `YYYY-MM-DD`), `label`. `backup` is optional — if omitted, the module picks the closest-walking same-or-lower-tier restaurant automatically.

Validate any dataset with:

```bash
node scripts/verify.js templates/your-trip.json --quiet
```

## CSS variables you can override

Set these on `:root` (or any parent of the mount):

| Variable | Default | What it colors |
|---|---|---|
| `--tr-rust` | `#a44d2b` | Primary CTA buttons (Book Today, urgency chips), Uber-distance text |
| `--tr-gold` | `#b8862c` | Price-band dollar signs, "Picked" status, short-uber distance text |
| `--tr-green` | `#4a7a5c` | Walk distances, booked confirmations, Mark-as-booked button |
| `--tr-ink` | `#1c1815` | Body text, active filter chips |
| `--tr-card` | `#fdfaf3` | Card backgrounds, settings disclosure background |
| `--tr-rule` | `#d9cdb2` | Borders, dividers |
| `--tr-muted` | `#4a4338` | Secondary text, captions, eyebrow labels |

All other styling is scoped under `.tr-*` class names so the module cannot leak into your host page.

## Optional: build-time scripts

These run once per trip, not at page load.

```bash
# Geocode every restaurant (Nominatim, no API key)
node scripts/geocode.js templates/your-trip.json

# Compute walk distance + travel mode from hotel to each restaurant
node scripts/route.js templates/your-trip.json

# Validate the dataset (URLs reachable, phones formatted, hours parseable)
node scripts/verify.js templates/your-trip.json

# Run the unit tests
node --test test/verify.test.js
```

The verifier emits `verify-report-<timestamp>.csv` and `.json`. OpenTable / Resy WAF 403s are recorded as `SOFT_BLOCK_403` (warning), not failures.

## Two-way sync with the host page

The module writes picks to `localStorage[`<storageKey>-picks`]` — a flat object keyed by night date:

```js
{
  "2026-06-03": "sazon-santa-fe",
  "2026-06-04": "the-compound-restaurant"
}
```

The host page can read the same key to populate day-tab cards or a condensed view. See [santafejune.com's `syncDayCards()` and `syncCondensedDinners()`](https://github.com/jhwiv/santafe-itinerary/blob/main/index.html) for the pattern. Also listen for the cross-tab `storage` event to keep multiple open tabs in sync.

To force a re-render after manually touching localStorage (e.g., a reset button), dispatch a fake event:

```js
window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY + '-picks' }));
```

## When to update this module vs the host trip

Update **the module** (this repo) when you're changing:
- The picker UX (tier cards, list rows, picked card, backup logic)
- The dataset schema
- A bug in the booking-URL builder
- CSS that should apply to every trip

Update **the host trip repo** when you're changing:
- The trip's restaurant data (`templates/<trip>.json`)
- Page-level layout (day tabs, header, navigation)
- Trip-wide copy (the lede, the page title, the day themes)
- The host's CSS variables (`--tr-*`)

## Repo layout

```
trip-restaurants/
\u251c\u2500 src/
\u2502  \u251c\u2500 restaurants.js     # the module (mountDiningTab, mountReservationTimeline, buildBookingUrl)
\u2502  \u2514\u2500 restaurants.css    # all .tr-* styles
\u251c\u2500 templates/
\u2502  \u2514\u2500 santa-fe.json      # reference dataset (16 restaurants, 7 nights)
\u251c\u2500 scripts/
\u2502  \u251c\u2500 geocode.js         # Nominatim lookup \u2192 lat/lon per restaurant
\u2502  \u251c\u2500 route.js           # OSRM \u2192 walkMinutes + mode per restaurant
\u2502  \u2514\u2500 verify.js          # URL / phone / hours QA, emits CSV + JSON
\u251c\u2500 demo/
\u2502  \u2514\u2500 index.html         # standalone runnable demo
\u251c\u2500 test/
\u2502  \u2514\u2500 verify.test.js     # node:test suite
\u251c\u2500 schema.json            # JSON schema for the dataset
\u2514\u2500 .github/workflows/
   \u2514\u2500 verify-weekly.yml  # weekly cron \u2014 opens an issue if anything breaks
```

## Status

| | |
|---|---|
| Live integration | [santafejune.com](https://santafejune.com) |
| Module version | `0.x` \u2014 API is stable but unversioned; pin a commit SHA if reusing |
| Tested datasets | `templates/santa-fe.json` (16 restaurants, 7 nights, all geocoded + routed) |
| Browser support | Anything ES2020+ (Chrome 80+, Safari 14+, Firefox 75+) |
| Dependencies | None at runtime. Build scripts use Node 18+ |

## License

Personal use. No license granted for redistribution.
