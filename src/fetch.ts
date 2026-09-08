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
 * Downloads land in data/source/, alongside a manifest recording the URL, size
 * and SHA-256 of each file and the date it was fetched. build.ts reads that
 * manifest and stamps the checksums into its output, so any file this project
 * produces can be traced back to the exact bytes it came from.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(here, "..", "data", "source");

/**
 * Slug URLs on teararoa.org.nz, which 301 to the dated upload path. The slugs
 * survive a re-upload; the paths they point at do not.
 */
const DOWNLOADS = [
  {
    url: "https://www.teararoa.org.nz/te_araroa_2026-27_google_earth/",
    member: "Te_Araroa_2026-27_Google_Earth.kmz",
    note: "Google Earth KMZ - the file this build reads",
  },
  {
    url: "https://www.teararoa.org.nz/teararoatrail_2026_27/",
    member: "TeAraroaTrail_2026_27.gpx",
    note: "Official tracks GPX - used only to cross-check the result",
  },
];

interface ManifestEntry {
  file: string;
  note: string;
  url: string;
  resolvedUrl: string;
  bytes: number;
  sha256: string;
}

export interface SourceManifest {
  description: string;
  fetchedAt: string;
  files: ManifestEntry[];
}

/** Both downloads are a ZIP wrapping a single file; unwrap it. */
async function extract(zipBytes: Uint8Array, member: string) {
  const zip = await JSZip.loadAsync(zipBytes);
  const entry = zip.file(member);
  if (!entry) {
    const names = Object.keys(zip.files).join(", ");
    throw new Error(`${member} not in the downloaded archive (found: ${names})`);
  }
  return entry.async("uint8array");
}

async function main() {
  mkdirSync(sourceDir, { recursive: true });
  const files: ManifestEntry[] = [];

  for (const download of DOWNLOADS) {
    console.log(`Fetching ${download.url}`);
    const response = await fetch(download.url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`${download.url} returned ${response.status} ${response.statusText}`);
    }

    const zipBytes = new Uint8Array(await response.arrayBuffer());
    const bytes = await extract(zipBytes, download.member);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    writeFileSync(join(sourceDir, download.member), bytes);
    files.push({
      file: download.member,
      note: download.note,
      url: download.url,
      resolvedUrl: response.url,
      bytes: bytes.length,
      sha256,
    });
    console.log(`  ${download.member}  ${(bytes.length / 1e6).toFixed(1)} MB  sha256 ${sha256.slice(0, 16)}...`);
  }

  const manifestPath = join(sourceDir, "manifest.json");
  const previous = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as SourceManifest)
    : null;

  const manifest: SourceManifest = {
    description:
      "Official Te Araroa Trust files this build reads. Fetched by npm run fetch; not committed to the repository.",
    fetchedAt: new Date().toISOString().slice(0, 10),
    files,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  if (previous) {
    const changed = files.filter(
      (f) => previous.files.find((p) => p.file === f.file)?.sha256 !== f.sha256,
    );
    if (changed.length) {
      console.log(
        `\nThe trust has republished since ${previous.fetchedAt}: ${changed
          .map((c) => c.file)
          .join(", ")} changed. Re-run npm run build; the committed out/ is now stale.`,
      );
    } else {
      console.log(`\nUnchanged since ${previous.fetchedAt}.`);
    }
  }
  console.log(`\nWrote ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
