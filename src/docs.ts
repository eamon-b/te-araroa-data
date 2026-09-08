/**
 * Rewrite the parts of README.md and docs/index.html that describe the data.
 *
 *   npm run docs        (build.ts runs it for you)
 *
 * Every number those two files quote - the release, the build date, the track
 * point counts, the accuracy figure, the gap table, the longest carries - is
 * a fact about a particular build. Hand-typed, they are correct exactly once.
 * That was tolerable while a human ran the build and edited the prose in the
 * same sitting; it stops being tolerable the moment the build runs on a
 * schedule, because then the files would keep refreshing under prose that
 * still described the release before them. Text that confidently describes
 * the wrong release is worse than text that admits it might be old.
 *
 * So they are generated from out/te-araroa.meta.json into marked regions:
 *
 *   <!-- generated:name -->  ...replaced...  <!-- /generated:name -->
 *
 * Everything outside those markers is written by hand and never touched. A
 * missing marker is an error rather than a skip - a region that silently
 * stopped updating is the failure this file exists to prevent.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const REPO = "https://github.com/eamon-b/te-araroa-data";

interface Meta {
  season: string;
  version: string;
  generatedAt: string;
  officialLengthKm: number;
  geometricLengthKm: number;
  ascentMeters: number;
  descentMeters: number;
  source?: { fetchedAt?: string };
  routeGaps: Array<{
    km: number;
    straightLineKm: number;
    from: string;
    to: string;
    coveredBy: string[];
    kind: "ferry" | "unmapped";
  }>;
  stats: {
    officialGpxTrackPoints: number | null;
    kmzTrackPoints: number;
    routePoints: number;
    tracks: number;
    waypoints: number;
    sections: number;
    docSites: number;
    privateSites: number;
    officialSites: number;
    officialFoodSites: number;
    bypasses: number;
    noCampingAreas: number;
    planRows: number;
    resupply: {
      total: number;
      byType: Record<string, number>;
      acceptsBoxes: number;
      researchedAt: string;
    };
    longestCarries: Array<{
      from: string;
      to: string;
      distanceKm: number;
      sections: string[];
    }>;
    strandedSites: number;
    farthestSite: { name: string; offTrailKm: number } | null;
    accuracy: {
      markers: number;
      meanErrorMeters: number;
      worstErrorKm: number;
      worstAtKm: number;
    } | null;
  };
}

const n = (value: number): string => value.toLocaleString("en-NZ");

/** One decimal place, with a thousands separator: 3073.15 -> "3,073.2". */
const km = (value: number): string =>
  value.toLocaleString("en-NZ", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

/** Small counts read better as words in a sentence. */
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (value: number): string => WORDS[value] ?? n(value);

/** "2026-09-08" or an ISO timestamp -> "8 September 2026". */
function longDate(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return new Intl.DateTimeFormat("en-NZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Swap the body of every marked region, leaving the markers in place.
 *
 * Regions the caller did not supply are left alone; regions the caller supplied
 * but the file does not have are an error, because that means a block of prose
 * has quietly stopped being maintained.
 */
function applyRegions(
  path: string,
  regions: Record<string, string>
): { changed: boolean } {
  const full = join(root, path);
  const before = readFileSync(full, "utf8");
  let after = before;

  for (const [name, body] of Object.entries(regions)) {
    const pattern = new RegExp(
      `(<!-- generated:${name} -->)[\\s\\S]*?(<!-- /generated:${name} -->)`
    );
    if (!pattern.test(after)) {
      throw new Error(
        `${path} has no <!-- generated:${name} --> region. Add the markers ` +
          `back, or drop the region from src/docs.ts - but do not leave the ` +
          `text to drift.`
      );
    }
    // Strip surrounding blank lines but not leading indentation - the HTML
    // regions sit inside indented blocks and should keep their shape.
    const trimmed = body.replace(/^\n+/, "").replace(/\s+$/, "");
    after = after.replace(pattern, `$1\n${trimmed}\n$2`);
  }

  if (after !== before) writeFileSync(full, after);
  return { changed: after !== before };
}

function readme(meta: Meta): Record<string, string> {
  const s = meta.stats;
  const built = longDate(meta.generatedAt);
  const gpxPoints = s.officialGpxTrackPoints;

  const gaps = meta.routeGaps
    .map((gap) => {
      // For a gap nobody has mapped, the segments either side are the only
      // useful description of where you are left standing.
      const covered =
        gap.kind === "ferry"
          ? gap.coveredBy.join(" + ")
          : `*no published route* (${gap.from} → ${gap.to})`;
      return `| ${km(gap.km)} | ${gap.straightLineKm.toFixed(1)} km | ${covered} |`;
    })
    .join("\n");
  const ferries = meta.routeGaps.filter((g) => g.kind === "ferry").length;
  const unmapped = meta.routeGaps.length - ferries;

  const carries = s.longestCarries
    .map(
      (c) =>
        `| ${km(c.distanceKm)} | ${c.from} → ${c.to} | ${c.sections.join(" / ")} |`
    )
    .join("\n");

  const accuracy = s.accuracy
    ? `The build finishes by projecting all ${n(s.accuracy.markers)} km-marker waypoints from the
official GPX onto the assembled route and comparing to the km each one declares:

\`\`\`
cross-check against ${s.accuracy.markers} official km markers: mean error ${s.accuracy.meanErrorMeters} m, worst ${s.accuracy.worstErrorKm.toFixed(3)} km
\`\`\`

An ${s.accuracy.meanErrorMeters} m mean error means the interpolated chainage reproduces the trust's own km
markers essentially exactly.`
    : "The cross-check did not run for this build.";

  return {
    snapshot: `
> ### What this is, and how current it is
>
> Built on **${built}** from the trust's **${meta.season} release (${meta.version})**.
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
> revised on **${longDate(s.resupply.researchedAt)}**, and it decays faster than the route does.
> Hut, water and resupply details are a starting point for your own checking,
> not something to rely on in the field.
>
> \`out/te-araroa.meta.json\` records the SHA-256 of the exact source files this
> was built from. \`npm run fetch\` re-downloads from the trust and tells you if
> they have changed.
`,

    comparison: `
| | official GPX | official KMZ |
|---|---|---|
| Track points | ${gpxPoints === null ? "n/a" : n(gpxPoints)} | ${n(s.kmzTrackPoints)} |
| Elevation | none | on every vertex |
| Track order | alphabetical (\`42 Traverse\`, \`Access Road No 3\`, …) | chainage (\`Fromkm\`/\`Tokm\`) |
| Huts / campsites | none | ${n(s.docSites)} DOC + ${n(s.privateSites)} private, with full attributes |
| Section names | none | on every segment and km marker |
| Bypasses, no-camping zones | none | ${s.bypasses} + ${n(s.noCampingAreas)} |
`,

    resupplyGap: `
**The official data also contains no resupply at all** - no towns, shops or
supermarkets anywhere in the KMZ, and only ${s.officialFoodSites} of its ${n(s.officialSites)} sites classify as food.
\`data/resupply.json\` fills that gap with ${s.resupply.total} resupply points researched by hand
from the trail guides credited in the file.
`,

    files: `
Most files come in both directions, \`-sobo\` (Cape Reinga → Bluff) and \`-nobo\`
(Bluff → Cape Reinga):

| File | Contents |
|---|---|
| \`te-araroa-{sobo,nobo}.gpx\` | ${s.tracks} tracks (main route, transport connectors, ${s.bypasses} bypasses), ${n(s.waypoints)} waypoints typed \`hut\`/\`campsite\`/\`town\`/\`resupply\`/\`food\`/\`accommodation\`/\`caravan-park\`, all in walking order. The stable filenames - link to these |
| \`te-araroa-${meta.season}-{sobo,nobo}.gpx\` | the same bytes under this release's name |
| \`resupply-plan-{sobo,nobo}.csv\` | ${n(s.planRows)} sites in trail order: km, official km, section, trail elevation, leg distances, leg ascent/descent, bunks, water, booking, phone, address, hours, DOC link |
| \`sections-{sobo,nobo}.csv\` | ${s.sections} official sections with km ranges, counted in that direction and in the trust's chainage |
| \`datasheet-{sobo,nobo}.csv\`, \`datasheet-resupply-{sobo,nobo}.csv\` | the same route through \`gpx-tools\`' \`processGpxTravelPlan\` |
| \`no-camping-areas.geojson\` | ${n(s.noCampingAreas)} restricted-camping polygons. No chainage, so one file serves both |
| \`te-araroa.meta.json\` | every GIS attribute per site, plus sections, connectors, route gaps, the numbers this README quotes, and source checksums, always in official chainage |
`,

    accuracy: `\n${accuracy}\n`,

    gaps: `
**Official length is ${km(meta.officialLengthKm)} km; the geometry measures ${km(meta.geometricLengthKm)} km.** The
difference is the ${count(meta.routeGaps.length)} places where the walking route stops and starts again.
${count(ferries)[0].toUpperCase()}${count(ferries).slice(1)} are covered by a published ferry route, ${count(unmapped)} are links you arrange
yourself:

| km | Gap | Covered by |
|---|---|---|
${gaps}
`,

    resupply: `
**Resupply is hand-researched, not official.** ${s.resupply.byType["town"] ?? 0} of the ${s.resupply.total} points are
full-supermarket towns, ${s.resupply.byType["resupply"] ?? 0} are limited stores or dairies, ${s.resupply.byType["food"] ?? 0} are cafés or pubs;
${s.resupply.acceptsBoxes} accept resupply boxes. Some towns are reached from a named road end rather
than by the route's nearest approach, and for those the file declares
\`accessFromKm\` (the trail km you leave at) and \`accessRoadKm\` (the road
distance). Without it the build reports a straight line across country that
nobody walks - Geraldine came out 55 km off the Two Thumb Range, when in reality
you leave at the Rangitata.

The longest carries between resupply points come out as:

| km | Stretch | Through |
|---|---|---|
${carries}
`,

    offtrail: `
**${s.strandedSites} sites sit more than 5 km off the trail** - the Tongariro and Whanganui
River huts, the Nelson Lakes huts, and ${s.farthestSite?.name ?? "the farthest"} at ${s.farthestSite?.offTrailKm.toFixed(1) ?? "?"} km. They
are kept, with \`Off trail m\` recording the detour.
`,
  };
}

function projectPage(meta: Meta): Record<string, string> {
  const s = meta.stats;
  const built = longDate(meta.generatedAt);

  // The page's map draws a simplified route, and says so. How far it was
  // simplified is decided by the build, so read it back rather than restate it.
  const overview = JSON.parse(
    readFileSync(join(root, "docs", "data", "overview.geojson"), "utf8")
  ) as { properties: { routePoints: number } };

  const files: Array<[string, string]> = [
    [
      // The stable name, not the dated one: this page is a permanent URL and
      // its links should not break when the trust publishes a new season.
      "te-araroa-{dir}.gpx",
      `${s.tracks} tracks (main route, ferry connectors, ${s.bypasses} bypasses) and ${n(s.waypoints)} typed waypoints, in walking order. Elevation throughout.`,
    ],
    [
      "resupply-plan-{dir}.csv",
      `${n(s.planRows)} sites in trail order: km, official km, section, elevation, leg distances and ascent, bunks, water, booking, phone, hours.`,
    ],
    [
      "datasheet-{dir}.csv",
      "The route through <code>gpx-tools</code>' datasheet: every waypoint with running distance, ascent and descent.",
    ],
    [
      "datasheet-resupply-{dir}.csv",
      "The same datasheet cut down to the points where you can resupply.",
    ],
    [
      "sections-{dir}.csv",
      `The ${s.sections} official sections with their km ranges, counted in this direction and in the trust's own chainage.`,
    ],
    [
      "no-camping-areas.geojson",
      `${n(s.noCampingAreas)} restricted-camping polygons. No chainage, so the same file either way.`,
    ],
    [
      "te-araroa.meta.json",
      "Every GIS attribute per site, plus sections, ferry connectors, route gaps, and the SHA-256 of the source files this was built from. Always in the trust's southbound chainage; northbound km is <code>officialLengthKm - km</code>.",
    ],
  ];

  return {
    badges: `
  <span class="badge">${meta.season} release (${meta.version})</span>
  <span class="badge">built ${built}</span>
  <span class="badge"><a href="${REPO}">Source on GitHub</a></span>
`,

    warning: `
  <p><strong>This follows the trust, but it is not the trust.</strong></p>
  <p>
    A scheduled job checks the trust's download page every Monday and rebuilds
    when the published files change, so this is not a frozen snapshot. But a
    rebuild still needs a person to merge it, and nothing here can see a reroute
    the trust has not published yet. This is not official and not endorsed by
    the Te Araroa Trust.
  </p>
  <p>
    The resupply data is the exception: it is researched by hand, last revised
    ${longDate(s.resupply.researchedAt)}, and it does not update itself at all.
  </p>
  <p>
    Before you walk, get the current files from
    <a href="https://www.teararoa.org.nz/trail-maps/">teararoa.org.nz</a> and read
    the trust's own trail notes and closure notices. Hut, water and resupply
    details decay faster than the route does, so you might want to double check
    them against more recent data and reports.
  </p>
`,

    mapnote: `
  Simplified for the web to ${n(overview.properties.routePoints)} points. Huts and campsites in green, resupply
  in orange, and the ringed markers are where this direction starts and finishes.
  The published GPX has the full ${n(s.routePoints)}-point geometry.
`,

    stats: `
  <div class="stat"><b>${n(Math.round(meta.officialLengthKm))} km</b><span>Official length</span></div>
  <div class="stat"><b>${n(s.routePoints)}</b><span>Route points</span></div>
  <div class="stat"><b>${n(s.waypoints)}</b><span>Waypoints</span></div>
  <div class="stat"><b>${s.sections}</b><span>Sections</span></div>
  <div class="stat"><b>${s.accuracy?.meanErrorMeters ?? "?"} m</b><span>Chainage error</span></div>
`,

    comparison: `
  <tr><th></th><th>official GPX</th><th>official KMZ</th></tr>
  <tr><td>Track points</td><td>${s.officialGpxTrackPoints === null ? "n/a" : n(s.officialGpxTrackPoints)}</td><td class="yes">${n(s.kmzTrackPoints)}</td></tr>
  <tr><td>Elevation</td><td>none</td><td class="yes">every vertex</td></tr>
  <tr><td>Track order</td><td>alphabetical</td><td class="yes">chainage</td></tr>
  <tr><td>Huts / campsites</td><td>none</td><td class="yes">${n(s.officialSites)}, with attributes</td></tr>
  <tr><td>Section names</td><td>none</td><td class="yes">every segment</td></tr>
  <tr><td>Bypasses / no-camping</td><td>none</td><td class="yes">${s.bypasses} + ${n(s.noCampingAreas)}</td></tr>
`,

    accuracy: `
  So the build reads the KMZ, uses the GPX only to check its work, and writes
  ordinary GPX and CSV. It then projects all ${n(s.accuracy?.markers ?? 0)} official km markers onto the
  assembled route: <strong>mean error ${s.accuracy?.meanErrorMeters ?? "?"} m</strong>, which is to say the
  interpolated chainage reproduces the trust's own markers essentially exactly.
`,

    resupplyGap: `
  The official data also contains <strong>no resupply at all</strong> — no towns,
  shops or supermarkets anywhere in the KMZ. ${s.resupply.total} resupply points were researched
  by hand to fill that gap.
`,

    // href and link text are filled in by the page's direction switch, so the
    // generated markup carries only the template and the prose.
    downloads: files
      .map(
        ([file, description]) => `  <tr>
    <td><a data-file="${file}"></a></td>
    <td>${description}</td>
  </tr>`
      )
      .join("\n"),
  };
}

export function writeDocs(): void {
  const metaPath = join(root, "out", "te-araroa.meta.json");
  let meta: Meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as Meta;
  } catch {
    throw new Error(
      `${metaPath} is not here. Run \`npm run build\` first - the docs are ` +
        `generated from it.`
    );
  }
  if (!meta.stats) {
    throw new Error(
      `${metaPath} predates the generated docs and has no stats block. ` +
        `Re-run \`npm run build\`.`
    );
  }

  for (const [path, regions] of [
    ["README.md", readme(meta)],
    ["docs/index.html", projectPage(meta)],
  ] as const) {
    const { changed } = applyRegions(path, regions);
    console.log(`  ${changed ? "updated" : "unchanged"} ${path}`);
  }
}

// Run directly as `npm run docs`; build.ts imports writeDocs and calls it at
// the end of a build, so a rebuild can never leave the prose behind.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  writeDocs();
}
