/**
 * The pull request body the scheduled refresh writes.
 *
 * This is the only part of a refresh a human actually reads - the diff itself
 * is megabytes of regenerated GPX - so it has to say what moved, and it has to
 * flag the things that should stop a merge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "te-araroa-summary-"));

/** A minimal meta.json, with only the fields the summary reads. */
function meta(overrides: Record<string, unknown> = {}) {
  return {
    season: "2026-27",
    version: "v45",
    officialLengthKm: 3073.204,
    geometricLengthKm: 3159.486,
    ascentMeters: 91000,
    routeGaps: [{ km: 1503, straightLineKm: 6.1, kind: "ferry" }],
    sections: [{ Section: "Cape Reinga to Ahipara" }, { Section: "Ahipara to Kaitaia" }],
    sites: [
      { name: "Twilight Campsite", type: "campsite", source: "DOC", km: 12.5 },
      { name: "Ngunguru", type: "resupply", source: "Resupply", km: 347.6 },
    ],
    stats: {
      routePoints: 35441,
      waypoints: 574,
      docSites: 135,
      privateSites: 49,
      accuracy: { meanErrorMeters: 8, worstErrorKm: 1.427 },
    },
    ...overrides,
  };
}

function summarise(before: unknown, after: unknown): string {
  const beforePath = join(scratch, `before-${Math.random()}.json`);
  const afterPath = join(scratch, `after-${Math.random()}.json`);
  if (before !== null) writeFileSync(beforePath, JSON.stringify(before));
  writeFileSync(afterPath, JSON.stringify(after));
  return execFileSync(
    process.execPath,
    ["--import", "tsx", join(root, "src/summary.ts"), beforePath, afterPath],
    { encoding: "utf8" }
  );
}

test("a first build says there is nothing to compare against", () => {
  const output = summarise(null, meta());
  assert.match(output, /First build of the \*\*2026-27\*\* release \(v45\)/);
});

test("a republished season reports the version and the figures that moved", () => {
  const output = summarise(
    meta(),
    meta({
      version: "v46",
      officialLengthKm: 3081.204,
      stats: { ...meta().stats, docSites: 136 },
    })
  );

  assert.match(output, /## 2026-27 republished \(v45 → v46\)/);
  assert.match(output, /\| Official length \| 3073\.2 km \| \*\*3081\.2 km\*\* \| \+8\.0 km \|/);
  assert.match(output, /\| DOC sites \| 135 \| \*\*136\*\* \|/);
  // Untouched figures stay out of the table.
  assert.doesNotMatch(output, /Private sites/);
  // And the hand-researched resupply data is always called out as not updated.
  assert.match(output, /data\/resupply\.json/);
});

test("a new season is announced as one", () => {
  const output = summarise(meta(), meta({ season: "2027-28", version: "v1" }));
  assert.match(output, /## New season: 2026-27 → \*\*2027-28\*\*/);
});

test("a worse chainage cross-check is flagged, a better one is not", () => {
  const worse = summarise(
    meta(),
    meta({ stats: { ...meta().stats, accuracy: { meanErrorMeters: 41, worstErrorKm: 3 } } })
  );
  assert.match(worse, /\| Chainage error \| 8 m \| \*\*41 m\*\* \| ⚠️ worse than the previous build \|/);

  const better = summarise(
    meta(),
    meta({ stats: { ...meta().stats, accuracy: { meanErrorMeters: 4, worstErrorKm: 1 } } })
  );
  assert.match(better, /\| Chainage error \| 8 m \| \*\*4 m\*\* \|\s*\|/);
  assert.doesNotMatch(better, /⚠️/);
});

test("sites and sections that appeared or vanished are named", () => {
  const after = meta({
    sites: [
      { name: "Twilight Campsite", type: "campsite", source: "DOC", km: 12.5 },
      { name: "Pandora Hut", type: "hut", source: "DOC", km: 40 },
      { name: "Ngunguru", type: "resupply", source: "Resupply", km: 347.6 },
    ],
    sections: [{ Section: "Cape Reinga to Ahipara" }, { Section: "Ahipara to Kerikeri" }],
  });
  const output = summarise(meta(), after);

  assert.match(output, /### DOC sites/);
  assert.match(output, /\*\*Added \(1\):\*\* `Pandora Hut`/);
  assert.match(output, /\*\*Removed \(0\):\*\* _none_/);
  assert.match(output, /### Sections[\s\S]*`Ahipara to Kerikeri`[\s\S]*`Ahipara to Kaitaia`/);
  // A source with no change to its sites gets no section of its own.
  assert.doesNotMatch(output, /### Private sites/);
});

test("an identical rebuild says so plainly", () => {
  const output = summarise(meta(), meta());
  assert.match(output, /No change to any headline figure\./);
});

test("it refuses to run without both files", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ["--import", "tsx", join(root, "src/summary.ts")], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    /Command failed/
  );
});
