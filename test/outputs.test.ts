/**
 * The published data in out/, checked for the things a reader trusts it for.
 *
 * The scheduled refresh opens a pull request full of regenerated GPX and CSV
 * that nobody can review by eye. These are the invariants that make merging it
 * safe: chainage that covers the trail exactly once, two directions that are
 * genuine mirrors of each other, and files that actually contain what the
 * metadata claims. A refresh that breaks one of them should fail here rather
 * than reach someone planning a five-month walk.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Papa from "papaparse";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = (name: string) => join(root, "out", name);

const meta = JSON.parse(readFileSync(out("te-araroa.meta.json"), "utf8"));
const L: number = meta.officialLengthKm;

interface Position {
  lat: number;
  lon: number;
}

/** Everything published sits inside New Zealand. */
const NZ = { minLat: -47.5, maxLat: -34, minLon: 166, maxLon: 179 };

const csv = (name: string): Array<Record<string, string>> =>
  Papa.parse<Record<string, string>>(readFileSync(out(name), "utf8").trim(), {
    header: true,
    skipEmptyLines: true,
  }).data;

const total = (rows: Array<Record<string, string>>, column: string): number =>
  rows.reduce((sum, row) => sum + Number(row[column] || 0), 0);

/** Great-circle distance between two published positions, in km. */
const haversineKm = (
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number => {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};

test("the metadata describes a plausible Te Araroa", () => {
  assert.equal(meta.trail, "Te Araroa");
  assert.match(meta.season, /^\d{4}-\d{2}$/);
  assert.ok(meta.version, "the trust's own version stamp is missing");
  assert.match(meta.attribution, /Te Araroa Trust, CC BY 4\.0 NZ/);
  assert.equal(meta.chainage.direction, "SOBO");

  // A reroute moves the trail by kilometres, not by hundreds of them. A figure
  // outside this band means the build misread the file, not that the trail moved.
  assert.ok(L > 2800 && L < 3400, `official length ${L} km is not credible`);
  // Walked geometry is measured a stretch at a time, so it excludes the links
  // between them and lands close to the chainage from either side - the trust's
  // own numbering is a little generous against its own lines. What it must not
  // do is drift far, and it must never quietly grow by the size of the links.
  assert.ok(
    meta.walkedLengthKm > L * 0.97 && meta.walkedLengthKm < L * 1.05,
    `walked geometry ${meta.walkedLengthKm} km against ${L} km of chainage`
  );
  // The links are real distance and must be reported, just not as walking.
  assert.ok(meta.gapLengthKm > 0, "the route has no links between its stretches");
  assert.equal(meta.walkedStretches, meta.routeGaps.length + 1);
  assert.ok(meta.routePoints > 20000);
  assert.ok(meta.ascentMeters > 50000 && meta.descentMeters > 50000);

  // The build must record which bytes it read, or the season is only a claim.
  assert.ok(Array.isArray(meta.source.files) && meta.source.files.length === 2);
  for (const file of meta.source.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(file.bytes > 0);
  }
});

test("the cross-check against the trust's own km markers still holds", () => {
  const accuracy = meta.stats.accuracy;
  assert.ok(accuracy, "no cross-check ran - the official GPX was missing");
  assert.ok(accuracy.markers > 2500, `only ${accuracy.markers} markers checked`);
  // Interpolating chainage along the geometry lands within metres. Tens of
  // metres would mean segments are being chained in the wrong order.
  assert.ok(
    accuracy.meanErrorMeters <= 50,
    `mean chainage error ${accuracy.meanErrorMeters} m`
  );
  assert.ok(
    accuracy.worstErrorKm <= 5,
    `worst chainage error ${accuracy.worstErrorKm} km at km ${accuracy.worstAtKm}`
  );
});

test("sections tile the trail from end to end without a gap or an overlap", () => {
  const sections = meta.sections;
  assert.equal(sections.length, meta.stats.sections);
  assert.ok(sections.length > 50);
  assert.equal(sections[0]["Start km"], 0);
  assert.ok(Math.abs(sections.at(-1)["End km"] - L) < 0.05);

  let previousEnd = 0;
  for (const section of sections) {
    assert.ok(section.Section, "a section has no name");
    assert.ok(["North", "South"].includes(section.Island), section.Island);
    assert.ok(
      section["End km"] > section["Start km"],
      `${section.Section} does not advance`
    );
    assert.ok(
      Math.abs(section["Start km"] - previousEnd) < 0.05,
      `${section.Section} starts at ${section["Start km"]}, previous ended at ${previousEnd}`
    );
    previousEnd = section["End km"];
  }

  // The trail runs north to south, so every North Island section precedes every
  // South Island one.
  const islands = sections.map((s: { Island: string }) => s.Island);
  assert.equal(islands.lastIndexOf("North") < islands.indexOf("South"), true);
});

test("every site sits on the trail, in chainage order", () => {
  const sites = meta.sites;
  assert.equal(sites.length, meta.stats.planRows);

  for (const site of sites) {
    assert.ok(site.name, "a site has no name");
    assert.ok(["DOC", "Private", "Resupply"].includes(site.source), site.source);
    assert.ok(site.km >= 0 && site.km <= L, `${site.name} at km ${site.km}`);
    assert.ok(site.lat > NZ.minLat && site.lat < NZ.maxLat, `${site.name} lat`);
    assert.ok(site.lon > NZ.minLon && site.lon < NZ.maxLon, `${site.name} lon`);
    assert.ok(site.section, `${site.name} is in no section`);
  }

  for (let i = 1; i < sites.length; i++) {
    assert.ok(sites[i].km >= sites[i - 1].km, "sites are not in chainage order");
  }

  const count = (source: string) =>
    sites.filter((s: { source: string }) => s.source === source).length;
  assert.equal(count("DOC"), meta.stats.docSites);
  assert.equal(count("Private"), meta.stats.privateSites);

  // The hand-researched file is the only source of towns and shops, so its
  // points must all have made it onto the route.
  const resupply = JSON.parse(readFileSync(join(root, "data/resupply.json"), "utf8"));
  assert.equal(count("Resupply"), resupply.points.length);
  assert.equal(meta.stats.resupply.total, resupply.points.length);

  // How far off-trail the trust's own sites sit is a published figure, so the
  // list and the headline have to agree. A site projected onto the wrong part
  // of the route shows up here as a wildly larger number.
  const stranded = sites.filter(
    (s: { source: string; offTrailMeters: number }) =>
      s.source !== "Resupply" && s.offTrailMeters > 5000
  );
  assert.equal(stranded.length, meta.stats.strandedSites);
  const farthest = [...stranded].sort(
    (a, b) => b.offTrailMeters - a.offTrailMeters
  )[0];
  assert.equal(farthest.name, meta.stats.farthestSite.name);
  assert.ok(
    farthest.offTrailMeters / 1000 < 60,
    `${farthest.name} is ${(farthest.offTrailMeters / 1000).toFixed(1)} km off the trail`
  );
});

test("the gaps in the walking route are described, not silently bridged", () => {
  for (const gap of meta.routeGaps) {
    assert.ok(["ferry", "bypass", "unmapped"].includes(gap.kind), gap.kind);
    assert.ok(gap.km >= 0 && gap.km <= L);
    assert.ok(gap.straightLineKm > 0.2, "a gap under the threshold was recorded");
    assert.ok(gap.from && gap.to);
    assert.ok(gap.label && gap.crossing, `gap at km ${gap.km} has no description`);
    // A gap says what crosses it, or says that nothing does - never neither.
    if (gap.kind === "unmapped") assert.equal(gap.coveredBy.length, 0);
    else assert.ok(gap.coveredBy.length > 0, `${gap.kind} gap with nothing on it`);

    // The two positions are the point you walk to and the point you start
    // again from, so they must be the recorded distance apart.
    const separation = haversineKm(gap.endsAt, gap.resumesAt);
    assert.ok(
      Math.abs(separation - gap.straightLineKm) < 0.1,
      `${gap.label}: ends and resumes are ${separation.toFixed(2)} km apart, ` +
        `not the ${gap.straightLineKm} km recorded`
    );
  }
  // The Cook Strait crossing at least is always there.
  assert.ok(meta.routeGaps.length > 0, "no route gaps at all - is the route joined up?");
  assert.ok(meta.transportConnectors.length > 0);
});

test("every file the metadata advertises is on disk and not empty", () => {
  for (const direction of meta.directions) {
    assert.equal(direction.files.length, 6);
    for (const file of direction.files) {
      assert.ok(existsSync(out(file)), `out/${file} is missing`);
      assert.ok(statSync(out(file)).size > 1000, `out/${file} is suspiciously small`);
    }
  }
  assert.ok(existsSync(out("no-camping-areas.geojson")));

  // The dated release name and the stable link name are the same bytes.
  for (const id of ["sobo", "nobo"]) {
    assert.ok(
      readFileSync(out(`te-araroa-${id}.gpx`)).equals(
        readFileSync(out(`te-araroa-${meta.season}-${id}.gpx`))
      ),
      `te-araroa-${id}.gpx and the dated copy differ`
    );
  }
});

test("each GPX carries what the metadata says, walked the right way", () => {
  for (const direction of meta.directions) {
    const gpx = readFileSync(out(`te-araroa-${direction.id}.gpx`), "utf8");
    const label = direction.code;

    assert.match(gpx, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.ok(gpx.trimEnd().endsWith("</gpx>"), `${label} GPX is truncated`);
    assert.ok(gpx.includes(`<name>Te Araroa ${meta.season} (${label})</name>`));
    assert.ok(gpx.includes(meta.attribution), `${label} GPX drops the attribution`);

    assert.equal((gpx.match(/<trk>/g) ?? []).length, meta.stats.tracks);
    assert.equal((gpx.match(/<wpt /g) ?? []).length, meta.stats.waypoints);
    assert.ok((gpx.match(/<trkpt /g) ?? []).length > 20000);

    // The first waypoint is the first thing you walk past: Cape Reinga going
    // south, Bluff going north. This is the check that a direction is not
    // quietly written back to front.
    const first = gpx.match(/<wpt lat="(-?[\d.]+)"/);
    assert.ok(first);
    const startLat = Number(first[1]);
    if (direction.id === "sobo") assert.ok(startLat > -36, `SOBO starts at lat ${startLat}`);
    else assert.ok(startLat < -44, `NOBO starts at lat ${startLat}`);

    // Nothing has escaped New Zealand.
    for (const match of gpx.matchAll(/<(?:trkpt|wpt) lat="(-?[\d.]+)" lon="(-?[\d.]+)"/g)) {
      const lat = Number(match[1]);
      const lon = Number(match[2]);
      if (lat < NZ.minLat || lat > NZ.maxLat || lon < NZ.minLon || lon > NZ.maxLon) {
        assert.fail(`${label} GPX has a point at ${lat}, ${lon}`);
      }
    }
  }
});

test("no GPX track walks across a break in the route", () => {
  for (const direction of meta.directions) {
    const gpx = readFileSync(out(`te-araroa-${direction.id}.gpx`), "utf8");
    const label = direction.code;

    // Tracks, not track segments. A <trkseg> boundary is a hint most consumers
    // ignore - Garmin, Gaia, CalTopo and Leaflet all join a track's segments
    // into one line - so the main route is published as one <trk> per stretch,
    // and this is the check that it still is.
    const tracks = [...gpx.matchAll(/<trk>\s*<name>([^<]*)<\/name>([\s\S]*?)<\/trk>/g)].map(
      (match) => ({ name: match[1], body: match[2] })
    );
    assert.equal(tracks.length, meta.stats.tracks);

    const walking = tracks.filter((track) =>
      track.name.startsWith(`Te Araroa (${label}) `)
    );
    assert.equal(
      walking.length,
      meta.walkedStretches,
      `${label} publishes ${walking.length} walking tracks, not ${meta.walkedStretches}`
    );
    for (const track of walking) {
      assert.equal(
        (track.body.match(/<trkseg>/g) ?? []).length,
        1,
        `${track.name} is more than one segment, which most tools will join up`
      );
    }

    // Walked in this direction, each track has to stop where a break starts.
    const point = (xml: string, which: "first" | "last") => {
      const all = [...xml.matchAll(/<trkpt lat="(-?[\d.]+)" lon="(-?[\d.]+)"/g)];
      const match = which === "first" ? all[0] : all[all.length - 1];
      return { lat: Number(match[1]), lon: Number(match[2]) };
    };
    const nobo = direction.id === "nobo";
    const breaks = nobo ? [...meta.routeGaps].reverse() : meta.routeGaps;

    breaks.forEach((gap: { label: string; endsAt: Position; resumesAt: Position }, index: number) => {
      // Northbound you arrive at each break from the far side.
      const stops = nobo ? gap.resumesAt : gap.endsAt;
      const starts = nobo ? gap.endsAt : gap.resumesAt;
      assert.ok(
        haversineKm(point(walking[index].body, "last"), stops) < 0.01,
        `${label} track ${index + 1} does not stop at ${gap.label}`
      );
      assert.ok(
        haversineKm(point(walking[index + 1].body, "first"), starts) < 0.01,
        `${label} track ${index + 2} does not resume at ${gap.label}`
      );
    });

    // And both ends of every break are called out as waypoints, because a
    // track name is invisible on most of the devices these files end up on.
    const gapWaypoints = [...gpx.matchAll(/<wpt[\s\S]*?<\/wpt>/g)]
      .map((match) => match[0])
      .filter((wpt) => wpt.includes("<type>gap</type>"))
      .map((wpt) => wpt.match(/<name>([^<]*)<\/name>/)?.[1] ?? "");
    assert.equal(gapWaypoints.length, meta.routeGaps.length * 2);
    for (const gap of meta.routeGaps) {
      assert.ok(
        gapWaypoints.includes(`Trail ends - ${gap.label}`),
        `${label} GPX has no "trail ends" waypoint for ${gap.label}`
      );
      assert.ok(
        gapWaypoints.includes(`Trail resumes - ${gap.label}`),
        `${label} GPX has no "trail resumes" waypoint for ${gap.label}`
      );
    }
  }
});

test("the resupply plan says when a leg crosses a break", () => {
  for (const id of ["sobo", "nobo"]) {
    const rows = csv(`resupply-plan-${id}.csv`);
    const flagged = rows.filter((row) => row["Leg crosses"]);
    // Chainage runs straight through a break, so the leg either side of one
    // reads as an ordinary walk unless something says otherwise. Between
    // Queenstown and the far shore it reads 0.1 km, and 26.5 km of Lake
    // Wakatipu sit inside it.
    assert.equal(
      flagged.length,
      meta.routeGaps.length,
      `resupply-plan-${id}.csv flags ${flagged.length} of ${meta.routeGaps.length} breaks`
    );
    const labels = meta.routeGaps.map((gap: { label: string }) => gap.label);
    for (const row of flagged) {
      assert.ok(labels.includes(row["Leg crosses"]), row["Leg crosses"]);
      assert.ok(Number(row["Leg gap km"]) > 0.2, row.Name);
    }
    // The same six legs whichever way you walk them.
    assert.deepEqual(
      [...flagged.map((row) => row["Leg crosses"])].sort(),
      [...labels].sort()
    );
  }
});


test("every site the trail does not pass has a turnoff on the route", () => {
  const sites: Array<{
    name: string;
    km: number;
    lat: number;
    lon: number;
    offTrailMeters: number;
    accessLat: number | null;
    accessLon: number | null;
  }> = meta.sites;

  // The threshold is the datasheet's own waypoint-matching distance, which is
  // what makes the two mutually exclusive: a site nearer than that matches on
  // its own coordinates, one further away matches through its turnoff. Get this
  // wrong in either direction and a town either doubles up or vanishes.
  for (const site of sites) {
    const hasAccess = site.accessLat !== null && site.accessLon !== null;
    assert.equal(
      hasAccess,
      site.offTrailMeters >= 500,
      `${site.name} is ${site.offTrailMeters} m off trail and ${hasAccess ? "has" : "has no"} turnoff`
    );
  }

  const access = sites.filter((s) => s.accessLat !== null);
  assert.ok(access.length > 20, `only ${access.length} turnoffs`);

  // Where the off-trail figure is the build's own projection, it is the distance
  // to the nearest point on the route and the turnoff is the nearest vertex, so
  // the straight line back to the site is that distance or a little more - never
  // less, and never by more than the spacing between vertices. Where
  // data/resupply.json declares a road distance instead, the two are different
  // measurements and cannot be compared; the build warns about the ones that
  // contradict each other outright.
  const declared = new Set(
    JSON.parse(readFileSync(join(root, "data/resupply.json"), "utf8"))
      .points.filter((p: { accessFromKm?: number }) => p.accessFromKm !== undefined)
      .map((p: { name: string }) => p.name)
  );
  for (const site of access) {
    if (declared.has(site.name)) continue;
    const separation = haversineKm(
      { lat: site.accessLat!, lon: site.accessLon! },
      site
    );
    const offTrail = site.offTrailMeters / 1000;
    assert.ok(
      separation >= offTrail - 0.02,
      `${site.name}'s turnoff is ${separation.toFixed(2)} km from it, nearer than the ${offTrail.toFixed(2)} km it is recorded as being off trail`
    );
    assert.ok(
      separation <= offTrail + 1,
      `${site.name}'s turnoff is ${separation.toFixed(1)} km from it, but it is recorded as ${offTrail.toFixed(1)} km off trail`
    );
  }

  for (const direction of meta.directions) {
    const gpx = readFileSync(out(`te-araroa-${direction.id}.gpx`), "utf8");
    assert.equal(
      (gpx.match(/<type>[a-z-]+-access<\/type>/g) ?? []).length,
      access.length,
      `${direction.code} GPX is missing turnoff waypoints`
    );
    for (const site of access) {
      // Site names carry ampersands, which the GPX escapes and this does not.
      const name = site.name
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/'/g, "&apos;");
      assert.ok(
        gpx.includes(`<name>${name} turnoff</name>`),
        `${direction.code} GPX has no turnoff for ${site.name}`
      );
    }
  }

  // The whole point: a town the trail does not reach still earns a datasheet
  // row, at the km you leave the trail rather than not at all.
  const datasheet = csv("datasheet-nobo.csv");
  const rows = new Set(datasheet.map((row) => row["Location"]));
  for (const site of access) {
    assert.ok(
      rows.has(`${site.name} turnoff`),
      `${site.name} turnoff is not in datasheet-nobo.csv`
    );
  }
});

test("the northbound sheet is a true mirror of the southbound one", () => {
  const sobo = csv("resupply-plan-sobo.csv");
  const nobo = csv("resupply-plan-nobo.csv");

  assert.equal(sobo.length, meta.stats.planRows);
  assert.equal(nobo.length, sobo.length);
  // One schema, so anything reading one file can read the other.
  assert.deepEqual(Object.keys(nobo[0]), Object.keys(sobo[0]));

  // Same stops, walked the other way.
  assert.deepEqual(
    nobo.map((r) => r.Name),
    [...sobo].reverse().map((r) => r.Name)
  );

  for (const [i, row] of sobo.entries()) {
    const mirrored = nobo[nobo.length - 1 - i];
    // The trust's own chainage is carried in both sheets, unchanged.
    assert.equal(mirrored["Official km"], row["Official km"]);
    // Northbound progress counts down from the far end. Both columns are
    // rounded to 0.1 km, so allow for that and nothing more.
    const expected = L - Number(row["Official km"]);
    assert.ok(
      Math.abs(Number(mirrored.Km) - expected) <= 0.15,
      `${row.Name}: northbound km ${mirrored.Km}, expected ~${expected.toFixed(1)}`
    );
  }

  // What you climb walking north is what you descend walking south.
  assert.equal(total(nobo, "Leg ascent m"), total(sobo, "Leg descent m"));
  assert.equal(total(nobo, "Leg descent m"), total(sobo, "Leg ascent m"));
  assert.ok(total(sobo, "Leg ascent m") > 10000, "no climbing recorded at all");
});

test("the sections CSVs agree with the metadata in both directions", () => {
  for (const id of ["sobo", "nobo"]) {
    const rows = csv(`sections-${id}.csv`);
    assert.equal(rows.length, meta.sections.length);
    assert.equal(Number(rows[0]["Start km"]), 0);
    assert.ok(Math.abs(Number(rows.at(-1)!["End km"]) - L) < 0.05);

    // Whichever way it is read, it is the trust's chainage underneath. The CSV
    // rounds to 0.1 km where the metadata keeps 0.01, so compare within that.
    const official = rows
      .map((r) => Number(r["Official start km"]))
      .sort((a, b) => a - b);
    official.forEach((km, i) => {
      const expected = meta.sections[i]["Start km"];
      assert.ok(
        Math.abs(km - expected) <= 0.06,
        `sections-${id}.csv starts a section at ${km}, metadata says ${expected}`
      );
    });
  }
});

test("the datasheets gpx-tools produces are readable tables", () => {
  for (const id of ["sobo", "nobo"]) {
    const rows = csv(`datasheet-${id}.csv`);
    assert.ok(rows.length > 100, `datasheet-${id}.csv has ${rows.length} rows`);
    for (const column of ["Location", "Distance (km)", "Total Distance (km)"]) {
      assert.ok(column in rows[0], `datasheet-${id}.csv has no ${column} column`);
    }
    // Distances land on one decimal - the trust's chainage is not accurate to
    // the centimetre, and the extra digits are only noise.
    for (const row of rows) {
      const value = row["Total Distance (km)"];
      assert.ok(
        !value.includes(".") || value.split(".")[1].length <= 1,
        `un-tidied distance ${value} in datasheet-${id}.csv`
      );
    }
    // gpx-tools totals the walk including the step out to each waypoint, so
    // this runs a little past the route geometry - but only a little. What it
    // must never do again is include the links between the stretches: this file
    // once ended at 3,174 km, of which 102.7 km was straight lines over water.
    const walked = Number(rows.at(-1)!["Total Distance (km)"]);
    assert.ok(
      walked >= meta.walkedLengthKm * 0.98 &&
        walked < meta.walkedLengthKm * 1.03,
      `datasheet-${id}.csv ends at ${walked} km, walked geometry is ${meta.walkedLengthKm} km`
    );

    // The running totals must run: one walk, not one sheet per stretch.
    let previous = -1;
    for (const row of rows) {
      const running = Number(row["Total Distance (km)"]);
      assert.ok(
        running >= previous,
        `datasheet-${id}.csv resets to ${running} km at "${row.Location}"`
      );
      previous = running;
    }

    // And every break gets a row of its own, naming it.
    const breaks = rows.filter((row) => row.Location.startsWith("Trail ends -"));
    assert.equal(
      breaks.length,
      meta.routeGaps.length,
      `datasheet-${id}.csv marks ${breaks.length} of ${meta.routeGaps.length} breaks`
    );
    for (const row of breaks) {
      assert.match(row.Notes, /starts again [\d.]+ km away/, row.Location);
    }

    const resupply = csv(`datasheet-resupply-${id}.csv`);
    assert.ok(resupply.length > 0);
    assert.equal(
      resupply.filter((row) => row.Location.startsWith("Trail ends -")).length,
      meta.routeGaps.length
    );
  }
});

test("the project page's map data matches the build it came from", () => {
  const overview = JSON.parse(
    readFileSync(join(root, "docs/data/overview.geojson"), "utf8")
  );
  assert.equal(overview.type, "FeatureCollection");
  assert.equal(overview.properties.season, meta.season);
  assert.equal(overview.properties.officialLengthKm, L);
  // The route, one line per break in it, every site, and for each site the trail
  // does not pass, a turnoff marker plus the line tying it back to the place.
  const access = meta.sites.filter(
    (site: { accessLat: number | null }) => site.accessLat !== null
  );
  assert.equal(access.length, meta.stats.accessPoints);
  assert.equal(
    overview.features.length,
    meta.sites.length + access.length * 2 + meta.routeGaps.length + 1
  );

  // One line per walkable stretch, and nothing joining them. Drawn as a single
  // LineString, this file put a straight line across Cook Strait, the Rakaia,
  // the Rangitata and Lake Wakatipu on the front page of the project.
  const route = overview.features[0];
  assert.equal(route.properties.kind, "route");
  assert.equal(route.geometry.type, "MultiLineString");
  assert.equal(route.geometry.coordinates.length, meta.walkedStretches);

  // The page styles by kind, so nothing else may claim to be the route - the
  // gaps and the access links are lines too, and drawing either as trail would
  // put stretches across the country that nobody walks.
  const ofKind = (kind: string) =>
    overview.features.filter(
      (f: { properties: { kind: string } }) => f.properties.kind === kind
    ).length;
  assert.equal(ofKind("route"), 1);
  assert.equal(ofKind("gap"), meta.routeGaps.length);
  assert.equal(ofKind("access-link"), access.length);

  const points = route.geometry.coordinates.flat();
  // Simplified enough for a phone on one bar of signal, detailed enough to read.
  assert.ok(points.length > 2000);
  assert.ok(points.length < meta.routePoints / 2);
  for (const [lon, lat] of points) {
    if (lat < NZ.minLat || lat > NZ.maxLat || lon < NZ.minLon || lon > NZ.maxLon) {
      assert.fail(`overview.geojson has a point at ${lat}, ${lon}`);
    }
  }

  // Every line ends where a break begins and the next starts on its far side.
  // Simplification is free to leave a long straight where the trail really is
  // straight - Ninety Mile Beach comes out as 1.5 km hops - so what is checked
  // is not the length of the steps but that the cuts land on the breaks.
  const at = (point: number[]) => ({ lon: point[0], lat: point[1] });
  meta.routeGaps.forEach(
    (
      gap: { label: string; endsAt: { lat: number; lon: number }; resumesAt: { lat: number; lon: number } },
      index: number
    ) => {
      const before = route.geometry.coordinates[index];
      const after = route.geometry.coordinates[index + 1];
      assert.ok(
        haversineKm(at(before[before.length - 1]), gap.endsAt) < 0.01,
        `stretch ${index + 1} does not end where ${gap.label} does`
      );
      assert.ok(
        haversineKm(at(after[0]), gap.resumesAt) < 0.01,
        `stretch ${index + 2} does not start where ${gap.label} ends`
      );
    }
  );

  // The breaks are drawn, as their own dashed features.
  const gaps = overview.features.filter(
    (f: { properties: { kind: string } }) => f.properties.kind === "gap"
  );
  assert.equal(gaps.length, meta.routeGaps.length);
  for (const gap of gaps) {
    assert.equal(gap.geometry.type, "LineString");
    assert.equal(gap.geometry.coordinates.length, 2);
    assert.ok(gap.properties.name && gap.properties.crossing);
  }
});

test("the no-camping polygons are closed rings", () => {
  const areas = JSON.parse(readFileSync(out("no-camping-areas.geojson"), "utf8"));
  assert.equal(areas.features.length, meta.stats.noCampingAreas);
  assert.equal(areas.attribution, meta.attribution);
  for (const feature of areas.features) {
    assert.equal(feature.geometry.type, "Polygon");
    for (const ring of feature.geometry.coordinates) {
      assert.ok(ring.length >= 4, "a ring has too few points to close");
      assert.deepEqual(ring[0], ring.at(-1), "a ring is not closed");
    }
  }
});

test("the prose still describes the data it sits beside", () => {
  // README.md and docs/index.html are generated from the metadata. If a refresh
  // rebuilt the data without regenerating them, they are quietly lying.
  for (const path of ["README.md", "docs/index.html"]) {
    const text = readFileSync(join(root, path), "utf8");
    assert.ok(text.includes(meta.season), `${path} does not mention ${meta.season}`);
    assert.ok(
      text.includes(Math.round(L).toLocaleString("en-NZ")),
      `${path} does not quote the current trail length`
    );
    // Every generated region is still marked at both ends and still has a body,
    // so the next build can find it and nothing has quietly stopped updating.
    const regions = [...text.matchAll(/<!-- \/generated:([\w-]+) -->/g)].map(
      (m) => m[1]
    );
    assert.ok(regions.length >= 5, `${path} has only ${regions.length} generated regions`);
    for (const name of regions) {
      const body = text.match(
        new RegExp(`<!-- generated:${name} -->([\\s\\S]*?)<!-- /generated:${name} -->`)
      );
      assert.ok(body, `${path} never opens the ${name} region it closes`);
      assert.ok(body[1].trim().length > 0, `${path}'s ${name} region is empty`);
    }
  }
});
