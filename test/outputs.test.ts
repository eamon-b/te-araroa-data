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

/** Everything published sits inside New Zealand. */
const NZ = { minLat: -47.5, maxLat: -34, minLon: 166, maxLon: 179 };

const csv = (name: string): Array<Record<string, string>> =>
  Papa.parse<Record<string, string>>(readFileSync(out(name), "utf8").trim(), {
    header: true,
    skipEmptyLines: true,
  }).data;

const total = (rows: Array<Record<string, string>>, column: string): number =>
  rows.reduce((sum, row) => sum + Number(row[column] || 0), 0);

test("the metadata describes a plausible Te Araroa", () => {
  assert.equal(meta.trail, "Te Araroa");
  assert.match(meta.season, /^\d{4}-\d{2}$/);
  assert.ok(meta.version, "the trust's own version stamp is missing");
  assert.match(meta.attribution, /Te Araroa Trust, CC BY 4\.0 NZ/);
  assert.equal(meta.chainage.direction, "SOBO");

  // A reroute moves the trail by kilometres, not by hundreds of them. A figure
  // outside this band means the build misread the file, not that the trail moved.
  assert.ok(L > 2800 && L < 3400, `official length ${L} km is not credible`);
  // Geometry is always a little longer than the chainage: it follows every bend.
  assert.ok(meta.geometricLengthKm >= L, "geometry is shorter than the chainage");
  assert.ok(meta.geometricLengthKm < L * 1.15, "geometry is implausibly long");
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
    assert.ok(["ferry", "unmapped"].includes(gap.kind), gap.kind);
    assert.ok(gap.km >= 0 && gap.km <= L);
    assert.ok(gap.straightLineKm > 0.2, "a gap under the threshold was recorded");
    assert.ok(gap.from && gap.to);
    if (gap.kind === "ferry") assert.ok(gap.coveredBy.length > 0);
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
    // this runs a little past the route geometry - but only a little.
    const walked = Number(rows.at(-1)!["Total Distance (km)"]);
    assert.ok(
      walked >= meta.geometricLengthKm &&
        walked < meta.geometricLengthKm * 1.03,
      `datasheet-${id}.csv ends at ${walked} km, route geometry is ${meta.geometricLengthKm} km`
    );
    assert.ok(csv(`datasheet-resupply-${id}.csv`).length > 0);
  }
});

test("the project page's map data matches the build it came from", () => {
  const overview = JSON.parse(
    readFileSync(join(root, "docs/data/overview.geojson"), "utf8")
  );
  assert.equal(overview.type, "FeatureCollection");
  assert.equal(overview.properties.season, meta.season);
  assert.equal(overview.properties.officialLengthKm, L);
  assert.equal(overview.features.length, meta.sites.length + 1);

  const route = overview.features[0];
  assert.equal(route.geometry.type, "LineString");
  // Simplified enough for a phone on one bar of signal, detailed enough to read.
  assert.ok(route.geometry.coordinates.length > 2000);
  assert.ok(route.geometry.coordinates.length < meta.routePoints / 2);
  for (const [lon, lat] of route.geometry.coordinates) {
    if (lat < NZ.minLat || lat > NZ.maxLat || lon < NZ.minLon || lon > NZ.maxLon) {
      assert.fail(`overview.geojson has a point at ${lat}, ${lon}`);
    }
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
