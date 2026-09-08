/**
 * Download the official Te Araroa release from the trust.
 *
 *   npm run fetch
 *
 * The trust's own files are deliberately not committed to this repository. Two
 * reasons: they are theirs to publish, and mirroring them would quietly serve a
 * stale copy long after the trust has rerouted. Fetching means a clone always
 * builds against whatever the trust is publishing today - and if that is no
 * longer the release this repository's out/ was built from, the manifest below
 * makes the difference obvious rather than silent.
 *
 * Nothing here is pinned to a season. The download URLs carry the season in
 * their slug (`te_araroa_2026-27_google_earth`), so a pinned URL would keep
 * serving the 2026-27 files for as long as that page exists - and this script
 * would cheerfully report "unchanged" every week while the trust published a
 * new release next to it. That failure is worse than not checking at all,
 * because it looks like a check that passed. So the slugs are discovered from
 * the trust's own trail-maps page on every run, and a run that cannot find them
 * fails loudly instead of falling back to whatever worked last time.
 *
 * Downloads land in data/source/, alongside a manifest recording the URL, size
 * and SHA-256 of each file and the date it was fetched. build.ts reads that
 * manifest and stamps the checksums into its output, so any file this project
 * produces can be traced back to the exact bytes it came from.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  appendFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(here, "..", "data", "source");

/** The trust's index of downloads. Every release is linked from here. */
const TRAIL_MAPS = "https://www.teararoa.org.nz/trail-maps/";

export type SourceRole = "kmz" | "gpx";

interface Wanted {
  role: SourceRole;
  /**
   * The season-bearing slug, as the trail-maps page links it.
   *
   * Deliberately narrow. `teararoatrail_2026_27` is the tracks GPX, but the
   * page also links `teararoatrail_askmpt_2026_27` (km points only) and
   * `teararoatrail_section_routes_2026_27_gpx` (per-section routes); matching
   * loosely would pick up whichever came first in the HTML.
   */
  slug: RegExp;
  extension: string;
  note: string;
}

const WANTED: Wanted[] = [
  {
    role: "kmz",
    slug: /^te_araroa_[0-9]{4}-[0-9]{2}_google_earth$/,
    extension: ".kmz",
    note: "Google Earth KMZ - the file this build reads",
  },
  {
    role: "gpx",
    slug: /^teararoatrail_[0-9]{4}_[0-9]{2}$/,
    extension: ".gpx",
    note: "Official tracks GPX - used only to cross-check the result",
  },
];

interface ManifestEntry {
  role: SourceRole;
  file: string;
  note: string;
  url: string;
  resolvedUrl: string;
  bytes: number;
  sha256: string;
}

export interface SourceManifest {
  description: string;
  /** e.g. "2026-27", read off the filenames the trust publishes. */
  season: string;
  fetchedAt: string;
  files: ManifestEntry[];
}

/**
 * Find this season's download pages on the trail-maps index.
 *
 * Throws rather than guessing. If the trust restructures that page, a loud
 * failure asks a human to look; a silent fallback to last season's URL would
 * publish stale data under a fresh build date.
 */
async function discover(): Promise<Array<Wanted & { url: string }>> {
  const response = await fetch(TRAIL_MAPS, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `${TRAIL_MAPS} returned ${response.status} ${response.statusText}`,
    );
  }
  const html = await response.text();

  const links = new Set<string>();
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    try {
      links.add(new URL(match[1], TRAIL_MAPS).href);
    } catch {
      // Not a URL we can resolve - a `mailto:`, a bare fragment. Ignore it.
    }
  }

  return WANTED.map((wanted) => {
    const matches = [...links].filter((link) => {
      const slug = new URL(link).pathname.replace(/^\/|\/$/g, "");
      return wanted.slug.test(slug);
    });

    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one ${wanted.role.toUpperCase()} download on ${TRAIL_MAPS} ` +
          `matching ${wanted.slug}, found ${matches.length}` +
          (matches.length > 1 ? `: ${matches.join(", ")}` : "") +
          `. The trust has probably restructured the page - check it by hand ` +
          `and update the slug pattern in src/fetch.ts.`,
      );
    }
    return { ...wanted, url: matches[0] };
  });
}

/**
 * Both downloads are a ZIP wrapping a single file. Take the sole member with
 * the extension we want rather than a hardcoded name, because the name carries
 * the season and changes every release.
 */
async function extract(zipBytes: Uint8Array, wanted: Wanted) {
  const zip = await JSZip.loadAsync(zipBytes);
  const entries = Object.values(zip.files).filter(
    (entry) =>
      !entry.dir &&
      entry.name.toLowerCase().endsWith(wanted.extension) &&
      // Zips made on a Mac carry a parallel __MACOSX/ tree of resource forks.
      !entry.name.startsWith("__MACOSX/"),
  );

  if (entries.length !== 1) {
    const names = Object.keys(zip.files).join(", ");
    throw new Error(
      `Expected exactly one ${wanted.extension} in the ${wanted.role} archive, ` +
        `found ${entries.length} (archive holds: ${names})`,
    );
  }

  const entry = entries[0];
  return {
    // Flatten any directory the trust wraps it in; we want the bare filename.
    name: entry.name.split("/").pop() as string,
    bytes: await entry.async("uint8array"),
  };
}

/**
 * Read the season off a published filename.
 *
 * The trust writes it two ways - `Te_Araroa_2026-27_Google_Earth.kmz` and
 * `TeAraroaTrail_2026_27.gpx` - so both separators are accepted and normalised.
 */
function seasonOf(filename: string): string {
  const match = filename.match(/(\d{4})[-_](\d{2})(?!\d)/);
  if (!match) {
    throw new Error(
      `Cannot read a season from ${JSON.stringify(filename)}. The trust has ` +
        `changed how it names releases; src/fetch.ts needs updating.`,
    );
  }
  return `${match[1]}-${match[2]}`;
}

/** Drop previous seasons' downloads, so data/source/ holds one release only. */
function pruneOldSources(keep: string[]): void {
  for (const name of readdirSync(sourceDir)) {
    if (name === "manifest.json" || keep.includes(name)) continue;
    if (/\.(kmz|gpx)$/i.test(name)) {
      unlinkSync(join(sourceDir, name));
      console.log(`  removed superseded ${name}`);
    }
  }
}

/** Hand the result to a GitHub Actions step, when running as one. */
function reportToActions(fields: Record<string, string>): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  for (const [key, value] of Object.entries(fields)) {
    appendFileSync(output, `${key}=${value}\n`);
  }
}

async function main() {
  mkdirSync(sourceDir, { recursive: true });
  const files: ManifestEntry[] = [];

  console.log(`Discovering downloads on ${TRAIL_MAPS}`);
  const downloads = await discover();
  for (const download of downloads) {
    console.log(`  ${download.role}: ${download.url}`);
  }

  for (const download of downloads) {
    const response = await fetch(download.url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(
        `${download.url} returned ${response.status} ${response.statusText}`,
      );
    }

    const zipBytes = new Uint8Array(await response.arrayBuffer());
    const { name, bytes } = await extract(zipBytes, download);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    writeFileSync(join(sourceDir, name), bytes);
    files.push({
      role: download.role,
      file: name,
      note: download.note,
      url: download.url,
      resolvedUrl: response.url,
      bytes: bytes.length,
      sha256,
    });
    console.log(
      `  ${name}  ${(bytes.length / 1e6).toFixed(1)} MB  sha256 ${sha256.slice(0, 16)}...`,
    );
  }

  // Both files should describe the same release. If they disagree the trust is
  // mid-publish, and building from a KMZ of one season cross-checked against a
  // GPX of another would report a fake accuracy figure.
  const seasons = [...new Set(files.map((f) => seasonOf(f.file)))];
  if (seasons.length !== 1) {
    throw new Error(
      `The published files disagree about the season (${files
        .map((f) => `${f.file} -> ${seasonOf(f.file)}`)
        .join(", ")}). The trust is probably part-way through publishing a new ` +
        `release; try again later.`,
    );
  }
  const season = seasons[0];

  pruneOldSources(files.map((f) => f.file));

  const manifestPath = join(sourceDir, "manifest.json");
  const previous = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as SourceManifest)
    : null;

  const manifest: SourceManifest = {
    description:
      "Official Te Araroa Trust files this build reads. Fetched by npm run fetch; not committed to the repository.",
    season,
    fetchedAt: new Date().toISOString().slice(0, 10),
    files,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  let changed = true;
  if (previous) {
    // Match on role, not filename: at a season rollover every filename changes,
    // and matching on those would report the new release as two unrelated files
    // rather than as a change to the ones we already had.
    const differing = files.filter((f) => {
      // `role` was added after the first manifests were written; fall back to
      // the filename so upgrading does not look like a republish.
      const before =
        previous.files.find((p) => p.role === f.role) ??
        previous.files.find((p) => p.file === f.file);
      return before?.sha256 !== f.sha256;
    });
    changed = differing.length > 0;

    if (previous.season && previous.season !== season) {
      console.log(
        `\nNew season: ${previous.season} -> ${season}. Re-run npm run build; ` +
          `the committed out/ is a season behind.`,
      );
    } else if (changed) {
      console.log(
        `\nThe trust has republished since ${previous.fetchedAt}: ${differing
          .map((c) => c.file)
          .join(", ")} changed. Re-run npm run build; the committed out/ is now stale.`,
      );
    } else {
      console.log(`\nUnchanged since ${previous.fetchedAt}.`);
    }
  }

  reportToActions({
    changed: String(changed),
    season,
    previous_season: previous?.season ?? "",
  });

  console.log(`\nWrote ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
