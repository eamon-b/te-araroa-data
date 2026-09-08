# te-araroa-data

The Te Araroa Trust publishes its trail data as a KMZ and a GPX. This turns the
KMZ into files you can actually plan with: the trail in walking order, with
elevation, huts, campsites and a resupply plan the official data does not
contain.

**[Download the data](out/)** · **[Project page](https://eamon-b.github.io/te-araroa-data/)**

---

<!-- generated:snapshot -->
> ### What this is, and how current it is
>
> Built on **8 September 2026** from the trust's **2026-27 release (v45)**.
>
> A scheduled job checks the trust's download page every Monday and opens a pull
> request when the published files change, so this repository follows the trust
> rather than freezing at whatever it was built from. That check can only see
> what the trust publishes: **a pull request still needs a human to merge it**,
> and if the trust reroutes without republishing, nothing here will know.
>
> This is not official, and it is not endorsed by the Te Araroa Trust. It is one
> person's derived copy of their data. Before you walk, get the current files
> from **[teararoa.org.nz](https://www.teararoa.org.nz/trail-maps/)** and read
> the trust's own trail notes and closure notices.
>
> **The resupply data does not update itself.** It is hand-researched, last
> revised on **8 September 2026**, and it decays faster than the route does.
> Hut, water and resupply details are a starting point for your own checking,
> not something to rely on in the field.
>
> `out/te-araroa.meta.json` records the SHA-256 of the exact source files this
> was built from. `npm run fetch` re-downloads from the trust and tells you if
> they have changed.
<!-- /generated:snapshot -->

---

## Why this exists

Both official files are public, and the GPX is the weaker of the two - but it is
the one most tools reach for:

<!-- generated:comparison -->
| | official GPX | official KMZ |
|---|---|---|
| Track points | 28,027 | 35,987 |
| Elevation | none | on every vertex |
| Track order | alphabetical (`42 Traverse`, `Access Road No 3`, …) | chainage (`Fromkm`/`Tokm`) |
| Huts / campsites | none | 135 DOC + 49 private, with full attributes |
| Section names | none | on every segment and km marker |
| Bypasses, no-camping zones | none | 13 + 353 |
<!-- /generated:comparison -->

The KMZ has everything, and almost nothing consumes a KMZ. So this build reads
the KMZ, uses the GPX only to check its work, and writes ordinary GPX and CSV.

<!-- generated:resupplyGap -->
**The official data also contains no resupply at all** - no towns, shops or
supermarkets anywhere in the KMZ, and only 3 of its 184 sites classify as food.
`data/resupply.json` fills that gap with 82 resupply points researched by hand
from the trail guides credited in the file.
<!-- /generated:resupplyGap -->

## Use it without building anything

Everything in [`out/`](out/) is committed. If you just want the data, take it:

<!-- generated:files -->
Most files come in both directions, `-sobo` (Cape Reinga → Bluff) and `-nobo`
(Bluff → Cape Reinga):

| File | Contents |
|---|---|
| `te-araroa-{sobo,nobo}.gpx` | 15 tracks (main route, transport connectors, 13 bypasses), 574 waypoints typed `hut`/`campsite`/`town`/`resupply`/`food`/`accommodation`/`caravan-park`, all in walking order. The stable filenames - link to these |
| `te-araroa-2026-27-{sobo,nobo}.gpx` | the same bytes under this release's name |
| `resupply-plan-{sobo,nobo}.csv` | 266 sites in trail order: km, official km, section, trail elevation, leg distances, leg ascent/descent, bunks, water, booking, phone, address, hours, DOC link |
| `sections-{sobo,nobo}.csv` | 79 official sections with km ranges, counted in that direction and in the trust's chainage |
| `datasheet-{sobo,nobo}.csv`, `datasheet-resupply-{sobo,nobo}.csv` | the same route through `gpx-tools`' `processGpxTravelPlan` |
| `no-camping-areas.geojson` | 353 restricted-camping polygons. No chainage, so one file serves both |
| `te-araroa.meta.json` | every GIS attribute per site, plus sections, connectors, route gaps, the numbers this README quotes, and source checksums, always in official chainage |
<!-- /generated:files -->

## Which direction

The trust chains the trail southbound: km 0 is Cape Reinga, and every number it
publishes counts that way. Around a fifth of thru-hikers walk north from Bluff,
and for them the official chainage runs backwards.

**A northbound sheet is not the southbound sheet read from the bottom.** The
rows reverse, but so do the climbs — what you ascend walking north you descend
walking south — so `Leg ascent m` and `Leg descent m` genuinely differ between
the two files. Over the whole trail it is 83,916 m of climbing northbound
against 83,775 m southbound.

Two decisions worth knowing about:

- **The direction is in the filename, not in a folder.** A folder name does not
  survive a download; two files both called `datasheet.csv` become
  `datasheet.csv` and `datasheet (1).csv`, and a GPX copied onto a watch keeps
  nothing but its name.
- **Every sheet carries both numbers.** `Km` is progress in the direction you
  are walking, `Official km` is the trust's own. Without the second one, a
  northbound sheet cannot be lined up against the trust's trail notes, its km
  markers, or anything a southbound hiker tells you. In the southbound sheet the
  two columns coincide; they are both there so the files share one schema.

`te-araroa.meta.json` is deliberately not duplicated. It is the trust's data
with the trust's chainage on it; northbound km is `officialLengthKm - km`.

The project page carries a switch that drives both the map and the download
links, and it deep-links: [`#nobo`](https://eamon-b.github.io/te-araroa-data/#nobo).

## Building it yourself

```bash
npm install
npm run fetch      # downloads the trust's KMZ and GPX into data/source/
npm run build      # writes out/
```

The trust's own files are **not committed** to this repository. They are the
trust's to publish, and a mirror here would quietly serve a stale copy long
after they had rerouted. `npm run fetch` gets them from teararoa.org.nz and
records the URL, size and SHA-256 of each in `data/source/manifest.json`; run it
again later and it will tell you whether anything has changed.

Requires [`gpx-tools`](https://github.com/eamon-b/gpx-tools) for the KML/KMZ
reading, GPX writing and datasheet processing. It is an ordinary dependency;
`npm install` handles it.

## How it stays current

`.github/workflows/refresh.yml` runs `npm run fetch` every Monday. Nothing in
the fetcher is pinned to a season: the download URLs carry the season in their
slug, so it reads them off the trust's
[trail-maps page](https://www.teararoa.org.nz/trail-maps/) on every run. A
pinned URL would have kept serving the 2026-27 files for as long as that page
existed, and the weekly check would have reported "unchanged" every week while
the trust published a new release beside it - a check that passes for the wrong
reason is worse than no check at all. If the slugs cannot be found, the run
fails rather than falling back to whatever worked last time.

When the published bytes change, the workflow rebuilds and opens a pull request
whose body says what moved - length, route points, chainage error, and which
huts appeared or vanished - because the diff itself is several megabytes of
regenerated GPX and nobody can read that.

It stops there. **Nothing merges itself.** The build asserts continuous
chainage, known folder names and a cross-check against the trust's own km
markers, and those assertions are why the output is worth trusting; when one
fires, the run fails and opens an issue instead of publishing something plausible
and wrong. A run that succeeds still changes data people plan a five-month walk
with, so a person signs it off.

Two things the automation cannot do for you:

- **Resupply.** `data/resupply.json` is hand-researched. A reroute moves the
  trail under its `accessFromKm` values and nothing will say so.
- **A reroute the trust has not published.** The check can only see the files on
  teararoa.org.nz. The trail notes and closure notices are still the source of
  truth before you walk.

Run `npm run docs` on its own if you have edited the prose and want the
generated blocks refreshed; `npm run build` does it for you.

## What the build does

1. **Reads the KMZ.** The trust exports from ArcGIS, which writes each feature's
   attributes as an HTML table inside `<description>`; `parseDescriptionFields`
   recovers them as key/value pairs.
2. **Separates walking from transport.** Four segments have `Fromkm === Tokm` -
   the Cook Strait ferry, the Picton–Ship Cove water taxi, the Devonport ferry
   and the Whangarei Heads crossing. They contribute nothing to the official
   3,073 km and would inflate every distance downstream, so they are held out of
   the main route and emitted as their own track.
3. **Assembles the route.** The remaining 466 segments are sorted by `Fromkm` and
   oriented head-to-tail. Orientation is solved with a two-state dynamic program
   rather than greedily - a greedy pass invents an 11.9 km gap near Cape Reinga,
   because one wrong flip propagates down the chain.
4. **Interpolates official km onto every vertex**, proportionally within each
   segment's `Fromkm`→`Tokm` span. Chainage is asserted continuous; the build
   fails if it is not.
5. **Positions each hut and campsite** by projecting it onto the route, giving
   official km, section, island and off-trail distance.
6. **Writes** the GPX, a sidecar JSON with every GIS attribute, a GeoJSON of the
   no-camping polygons, and the planning CSVs.

### Accuracy check

<!-- generated:accuracy -->
The build finishes by projecting all 3,058 km-marker waypoints from the
official GPX onto the assembled route and comparing to the km each one declares:

```
cross-check against 3058 official km markers: mean error 8 m, worst 1.427 km
```

An 8 m mean error means the interpolated chainage reproduces the trust's own km
markers essentially exactly.
<!-- /generated:accuracy -->

## Known characteristics of the data

<!-- generated:gaps -->
**Official length is 3,073.2 km; the geometry measures 3,159.5 km.** The
difference is the six places where the walking route stops and starts again.
Three are covered by a published ferry route, three are links you arrange
yourself:

| km | Gap | Covered by |
|---|---|---|
| 407.3 | 1.1 km | Whangarei Heads crossing |
| 606.0 | 2.9 km | Devonport Ferry crossing |
| 1,739.0 | 52.7 km | Picton to Ship Cove - Water Taxi + Te Moana O Raukawa - Ferry Crossing |
| 2,298.3 | 12.6 km | *no published route* (Arboretum Track → Round Hill Route) |
| 2,367.8 | 7.0 km | *no published route* (Hakatere Station Route → Mesopotamia Station) |
| 2,733.8 | 26.5 km | *no published route* (Queenstown Waterfront → Greenstone Track) |
<!-- /generated:gaps -->

<!-- generated:resupply -->
**Resupply is hand-researched, not official.** 44 of the 82 points are
full-supermarket towns, 24 are limited stores or dairies, 14 are cafés or pubs;
13 accept resupply boxes. Some towns are reached from a named road end rather
than by the route's nearest approach, and for those the file declares
`accessFromKm` (the trail km you leave at) and `accessRoadKm` (the road
distance). Without it the build reports a straight line across country that
nobody walks - Geraldine came out 55 km off the Two Thumb Range, when in reality
you leave at the Rangitata.

The longest carries between resupply points come out as:

| km | Stretch | Through |
|---|---|---|
| 161.7 | Te Kūiti → Taumarunui | Te Kūiti to Pureora / Pureora Forest - The Timber Trail |
| 118.7 | St Arnaud → Boyle Village | Waiau Pass Track |
| 117.2 | Twizel → Lake Hāwea | Tekapo to Lake Ōhau / Breast Hill Track |
| 112.8 | Hanmer Springs → Arthur's Pass | Boyle to Arthur's Pass |
| 96.0 | Glenorchy → Te Anau | Mavora Walkway / Mararoa River Track |
<!-- /generated:resupply -->

That still leaves the long-tail POIs - individual supermarkets, post shops,
water taps - to OSM enrichment.

**Point features carry no elevation.** The trust publishes every hut, campsite
and km marker with `z=0`; only the line geometry has real heights. Waypoint
elevation is therefore read off the route at the site's km, which for a site far
off-trail is the height where you leave the trail - hence the column name
`Trail elevation m`.

<!-- generated:offtrail -->
**25 sites sit more than 5 km off the trail** - the Tongariro and Whanganui
River huts, the Nelson Lakes huts, and Peel Forest Campground at 34.7 km. They
are kept, with `Off trail m` recording the detour.
<!-- /generated:offtrail -->

## Layout

- `src/fetch.ts` — discovers this season's downloads on the trust's site,
  fetches them, records checksums.
- `src/route.ts` — chainage-driven route assembly. Trail-agnostic; would suit any
  trail published as GIS segments with a chainage.
- `src/te-araroa.ts` — the Te Araroa specifics: folder names, the DOC and private
  attribute vocabularies, the waypoint-type mapping.
- `src/build.ts` — orchestration and output; `writeDirection` is the only part
  that knows there is more than one way to walk the trail.
- `src/docs.ts` — regenerates the marked blocks in this README and the project
  page from `out/te-araroa.meta.json`, so no number here is typed by hand.
- `src/summary.ts` — diffs two builds into the prose the refresh PR carries.
- `.github/workflows/refresh.yml` — the weekly check. The route is assembled once in the
  trust's southbound chainage; `writeDirection` is the only part that knows
  there is more than one way to walk it, and is called once per direction.
- `docs/` — the project page.

The generic KML/KMZ reading lives in `gpx-tools` so the next trail that ships a
KMZ does not need it rewritten.

Blocks between `<!-- generated:name -->` markers are written by `src/docs.ts`
and will be overwritten. Everything else in this file is written by hand.

## Contributing

Corrections to the resupply data are the most useful thing anyone can send -
that file is hand-built and it decays. If a shop has closed, changed hours, or
stopped taking boxes, open an issue or a PR against `data/resupply.json`.

## Licence and attribution

Code MIT. The data is not mine to relicense and different files carry different
obligations - **see [DATA-LICENCE.md](DATA-LICENCE.md)**, which also documents an
ambiguity in the trust's own licence declaration worth knowing about before you
build anything commercial on this.

> Trail data © Te Araroa Trust. Hut and campsite data © NZ Department of
> Conservation (CC BY 4.0). Resupply coordinates © OpenStreetMap contributors
> (ODbL). Built by te-araroa-data.
