/**
 * Compare two builds and describe the difference in prose.
 *
 *   npx tsx src/summary.ts <old meta.json> <new meta.json>
 *
 * The scheduled refresh opens a pull request whose diff is several megabytes of
 * regenerated GPX and GeoJSON - unreviewable by eye, and there is no point
 * pretending otherwise. What a reviewer actually needs to know is whether the
 * trail moved, by how much, and which huts appeared or vanished. That is what
 * this prints, as Markdown, for the pull request body.
 *
 * It is deliberately blunt about the things that should stop a merge: a chainage
 * error that got worse, a large change in length, sites disappearing in bulk.
 */

import { readFileSync } from "node:fs";

interface Meta {
  season: string;
  version: string;
  officialLengthKm: number;
  walkedLengthKm: number;
  gapLengthKm: number;
  ascentMeters: number;
  routeGaps: Array<{ km: number; straightLineKm: number; kind: string }>;
  sections: Array<Record<string, string | number>>;
  sites: Array<{ name: string; type: string; source: string; km: number }>;
  stats: {
    routePoints: number;
    waypoints: number;
    docSites: number;
    privateSites: number;
    accuracy: { meanErrorMeters: number; worstErrorKm: number } | null;
  };
}

const n = (value: number): string => value.toLocaleString("en-NZ");

/** A row only earns space in the table if it moved. */
function row(
  label: string,
  before: string | number,
  after: string | number,
  note = ""
): string | null {
  if (String(before) === String(after)) return null;
  return `| ${label} | ${before} | **${after}** | ${note} |`;
}

function names(meta: Meta, source: string): Set<string> {
  return new Set(
    meta.sites.filter((s) => s.source === source).map((s) => s.name)
  );
}

function listChanges(before: Set<string>, after: Set<string>) {
  return {
    added: [...after].filter((x) => !before.has(x)).sort(),
    removed: [...before].filter((x) => !after.has(x)).sort(),
  };
}

/** Cap a list so a wholesale renaming does not produce a 500-line PR body. */
function bullets(items: string[], limit = 20): string {
  if (items.length === 0) return "_none_";
  const shown = items.slice(0, limit).map((x) => `\`${x}\``).join(", ");
  return items.length > limit
    ? `${shown} … and ${items.length - limit} more`
    : shown;
}

function main(): void {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    console.error("usage: tsx src/summary.ts <old meta.json> <new meta.json>");
    process.exit(2);
  }

  const after = JSON.parse(readFileSync(newPath, "utf8")) as Meta;
  let before: Meta | null = null;
  try {
    before = JSON.parse(readFileSync(oldPath, "utf8")) as Meta;
  } catch {
    // No previous build to compare against - a first run, or out/ was empty.
  }

  const lines: string[] = [];

  if (!before) {
    lines.push(
      `First build of the **${after.season}** release (${after.version}). ` +
        `Nothing to compare it against.`
    );
    console.log(lines.join("\n"));
    return;
  }

  if (before.season !== after.season) {
    lines.push(
      `## New season: ${before.season} → **${after.season}**`,
      "",
      `The trust has published a new seasonal release. Expect the route to have ` +
        `moved in more than one place, and read the trust's own notes on what ` +
        `changed before merging.`,
      ""
    );
  } else {
    lines.push(
      `## ${after.season} republished (${before.version} → ${after.version})`,
      "",
      `Same season, new files. Usually a reroute or two.`,
      ""
    );
  }

  const b = before.stats;
  const a = after.stats;
  const changes = [
    row(
      "Official length",
      `${before.officialLengthKm.toFixed(1)} km`,
      `${after.officialLengthKm.toFixed(1)} km`,
      `${(after.officialLengthKm - before.officialLengthKm >= 0 ? "+" : "") + (after.officialLengthKm - before.officialLengthKm).toFixed(1)} km`
    ),
    row(
      "Walked geometry",
      `${before.walkedLengthKm.toFixed(1)} km`,
      `${after.walkedLengthKm.toFixed(1)} km`
    ),
    row(
      "Links you do not walk",
      `${before.gapLengthKm.toFixed(1)} km`,
      `${after.gapLengthKm.toFixed(1)} km`
    ),
    row("Route points", n(b.routePoints), n(a.routePoints)),
    row("Waypoints", n(b.waypoints), n(a.waypoints)),
    row("DOC sites", b.docSites, a.docSites),
    row("Private sites", b.privateSites, a.privateSites),
    row("Sections", before.sections.length, after.sections.length),
    row("Route gaps", before.routeGaps.length, after.routeGaps.length),
    row(
      "Chainage error",
      `${b.accuracy?.meanErrorMeters ?? "?"} m`,
      `${a.accuracy?.meanErrorMeters ?? "?"} m`,
      // The cross-check is the one number that says whether the build understood
      // the file. If it got worse, that is the thing to look at first.
      (a.accuracy?.meanErrorMeters ?? 0) > (b.accuracy?.meanErrorMeters ?? 0)
        ? "⚠️ worse than the previous build"
        : ""
    ),
  ].filter((line): line is string => line !== null);

  if (changes.length > 0) {
    lines.push(
      "| | before | after | |",
      "|---|---|---|---|",
      ...changes,
      ""
    );
  } else {
    lines.push("No change to any headline figure.", "");
  }

  for (const source of ["DOC", "Private"] as const) {
    const { added, removed } = listChanges(
      names(before, source),
      names(after, source)
    );
    if (added.length === 0 && removed.length === 0) continue;
    lines.push(
      `### ${source} sites`,
      "",
      `**Added (${added.length}):** ${bullets(added)}`,
      "",
      `**Removed (${removed.length}):** ${bullets(removed)}`,
      ""
    );
  }

  const sectionNames = (meta: Meta) =>
    new Set(meta.sections.map((s) => String(s["Section"])));
  const sections = listChanges(sectionNames(before), sectionNames(after));
  if (sections.added.length > 0 || sections.removed.length > 0) {
    lines.push(
      "### Sections",
      "",
      `**Added (${sections.added.length}):** ${bullets(sections.added)}`,
      "",
      `**Removed (${sections.removed.length}):** ${bullets(sections.removed)}`,
      ""
    );
  }

  lines.push(
    "---",
    "",
    "The resupply data in `data/resupply.json` is hand-researched and is **not** " +
      "updated by this pull request. If the route moved near a town, its " +
      "`accessFromKm` may now be wrong."
  );

  console.log(lines.join("\n"));
}

main();
