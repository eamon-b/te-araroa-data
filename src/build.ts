/**
 * Build Te Araroa planning data from the official KMZ.
 *
 * The trust publishes both a GPX and a KMZ. The GPX holds only geometry and km
 * markers - no elevation, no huts, and its tracks are in alphabetical order. The
 * KMZ holds everything: elevation on every vertex, the huts and campsites with
 * their DOC attributes, the private campsites with phone numbers and opening
 * hours, and the chainage that puts all of it in trail order. So this build
 * reads the KMZ and treats the GPX purely as a cross-check.
 *
 * The route is assembled once, in the trust's own southbound chainage, and then
 * written twice - once for each direction in `DIRECTIONS`. A northbound sheet
 * is not a southbound sheet read from the bottom: the leg ascent and descent
 * swap over, so the climbing figures genuinely differ.
 *
 *   npm run build
 *
 * Outputs land in out/, with `-sobo` and `-nobo` variants of each:
 *   te-araroa-*.gpx            the trail, for gpx-tools and trail-maps
 *   te-araroa-<season>-*.gpx   the same bytes under the release name
 *   resupply-plan-*.csv        the planning sheet
 *   datasheet-*.csv            the same route through gpx-tools' datasheet
 *   sections-*.csv             section boundaries with km ranges
 *
 * and two files that carry no direction of their own:
 *   te-araroa.meta.json        every GIS attribute, in official chainage
 *   no-camping-areas.geojson   the 353 restricted-camping polygons
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import Papa from "papaparse";

// jsdom supplies the DOMParser that gpx-tools' browser-first parsers expect.
const jsdomWindow = new JSDOM("", { contentType: "text/html" }).window;
(globalThis as { DOMParser?: typeof jsdomWindow.DOMParser }).DOMParser =
  jsdomWindow.DOMParser;

// Imported by subpath rather than from the package index: the index barrel also
// pulls in the browser-side modules (Leaflet, Chart.js, the API client), which a
// Node build has no use for and which expect a `window`.
import { parseKmz } from "gpx-tools/lib/kml-parser";
import type { KmlPlacemark } from "gpx-tools/lib/kml-parser";
import { writeGpx } from "gpx-tools/lib/gpx-parser";
import { processGpxTravelPlan } from "gpx-tools/lib/gpx-datasheet";
import { douglasPeucker } from "gpx-tools/lib/gpx-optimizer";
import type { GpxWaypoint, GpxTrack } from "gpx-tools/lib/types";

import {
  assembleRoute,
  elevationStats,
  geometricLengthKm,
  projectOntoRoute,
  type ChainedSegment,
  type Coord,
  type RoutePoint,
} from "./route.ts";
import {
  FOLDERS,
  bunkCount,
  describeDocSite,
  describePrivateSite,
  docSiteType,
  folderOf,
  hasWater,
  isTransportConnector,
  privateSiteType,
} from "./te-araroa.ts";
import type { SourceManifest, SourceRole } from "./fetch.ts";
import { writeDocs } from "./docs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "out");
const sourceDir = join(root, "data", "source");
const docsDataDir = join(root, "docs", "data");

const SOURCE_MANIFEST = join(sourceDir, "manifest.json");
const TRAIL_NAME = "Te Araroa";

/**
 * Which files to build from, and which release they are.
 *
 * All of it comes from the manifest `npm run fetch` wrote, so that a new season
 * needs no edit here: the trust names its files with the season in them, fetch
 * records those names, and everything downstream - the output filenames, the
 * attribution string, the GPX track names - follows from this one lookup.
 */
function resolveSource(): {
  kmz: string;
  officialGpx: string;
  season: string;
  manifest: SourceManifest | null;
} {
  if (!existsSync(SOURCE_MANIFEST)) {
    throw new Error(
      `${SOURCE_MANIFEST} is not here. The trust's own files are not committed ` +
        `to this repository - run \`npm run fetch\` to download them first.`
    );
  }
  const manifest = JSON.parse(
    readFileSync(SOURCE_MANIFEST, "utf8")
  ) as SourceManifest;

  const pathFor = (role: SourceRole): string => {
    const entry = manifest.files.find((f) => f.role === role);
    if (!entry) {
      throw new Error(
        `The source manifest has no ${role} entry. Re-run \`npm run fetch\`.`
      );
    }
    const path = join(sourceDir, entry.file);
    if (!existsSync(path)) {
      throw new Error(
        `${path} is named in the manifest but is not on disk. The trust's own ` +
          `files are not committed - run \`npm run fetch\` to download them.`
      );
    }
    return path;
  };

  return {
    kmz: pathFor("kmz"),
    officialGpx: pathFor("gpx"),
    season: manifest.season,
    manifest,
  };
}

/**
 * Delete dated GPX files from previous seasons.
 *
 * out/ is committed, and without this every release would leave its dated files
 * behind - the repository would accumulate a copy of every season it ever built
 * and quietly offer stale ones for download beside the current one.
 */
function pruneSupersededGpx(keep: string[]): void {
  for (const name of readdirSync(outDir)) {
    if (keep.includes(name)) continue;
    if (/^te-araroa-\d{4}-\d{2}-(sobo|nobo)\.gpx$/.test(name)) {
      unlinkSync(join(outDir, name));
      console.log(`  removed superseded ${name}`);
    }
  }
}

/**
 * The two ways to walk the trail.
 *
 * The trust chains the trail southbound - km 0 is Cape Reinga - and every
 * number it publishes counts that way. Roughly a fifth of thru-hikers walk the
 * other way, and for them the official chainage counts down, which makes a
 * southbound sheet awkward to plan from and its leg ascent figures simply
 * wrong: what you climb walking north is what you descend walking south.
 *
 * So the route is assembled once, southbound, and the *outputs* are written
 * twice. Nothing here reverses `route.points`: the km on a route vertex stays
 * the trust's own, which keeps `indexAtKm`'s binary search and every projection
 * working against ascending chainage. Direction is applied at the edge.
 */
interface DirectionSpec {
  id: "sobo" | "nobo";
  /** The abbreviation hikers actually use. */
  code: "SOBO" | "NOBO";
  label: string;
  from: string;
  to: string;
}

const DIRECTIONS: DirectionSpec[] = [
  {
    id: "sobo",
    code: "SOBO",
    label: "Southbound",
    from: "Cape Reinga",
    to: "Bluff",
  },
  {
    id: "nobo",
    code: "NOBO",
    label: "Northbound",
    from: "Bluff",
    to: "Cape Reinga",
  },
];

/**
 * Where each direction's files land.
 *
 * The direction is in the filename rather than in a containing directory
 * because a directory name does not survive the download. Two files both called
 * `datasheet.csv` become `datasheet.csv` and `datasheet (1).csv` in a downloads
 * folder, and a GPX copied onto a watch keeps nothing but its name.
 */
function directionFiles(direction: DirectionSpec, season: string) {
  const d = direction.id;
  return {
    // The dated name is what a person wants once the file is in their downloads
    // folder - it says what they have got. The stable name is what a link can
    // point at: this build runs unattended now, and a URL that changed every
    // season would break every bookmark, script and README referencing it.
    gpx: `te-araroa-${season}-${d}.gpx`,
    stableGpx: `te-araroa-${d}.gpx`,
    plan: `resupply-plan-${d}.csv`,
    sections: `sections-${d}.csv`,
    datasheet: `datasheet-${d}.csv`,
    datasheetResupply: `datasheet-resupply-${d}.csv`,
  };
}

/** A named stretch of trail, in the trust's chainage. */
interface SectionSpan {
  section: string;
  island: string;
  fromKm: number;
  toKm: number;
}

/** Everything `writeDirection` needs, all of it in official chainage terms. */
interface DirectionContext {
  season: string;
  attribution: string;
  sites: SiteRecord[];
  connectors: ChainedSegment[];
  mainSegments: RoutePoint[][];
  bypasses: Array<{
    name: string;
    coordinates: Coord[];
    startKm: number;
    endKm: number;
  }>;
  kmMarkers: Array<{ km: number; section: string; coord: Coord }>;
  baseSections: SectionSpan[];
  officialKm: number;
  geometricKm: number;
  routePointCount: number;
  elevationAt: (km: number) => number;
  cumulativeAscentAt: (km: number) => { ascent: number; descent: number };
}

/** A hut or campsite, positioned on the route. */
interface SiteRecord {
  name: string;
  type: string;
  lat: number;
  lon: number;
  ele: number;
  km: number;
  offTrailMeters: number;
  section: string;
  island: string;
  source: "DOC" | "Private" | "Resupply";
  bunks: number | null;
  water: boolean;
  bookingRequired: boolean;
  trailPass: string;
  description: string;
  link: string;
  fields: Record<string, string>;
}

/** data/resupply.json - hand-researched, because the KMZ has no shops in it. */
interface ResupplyFile {
  description: string;
  sources: string[];
  researchedAt: string;
  points: Array<{
    name: string;
    type: string;
    lat: number;
    lon: number;
    acceptsBoxes: boolean;
    notes: string;
    osm: string | null;
    /** Trail km you leave the route at, when that is not the nearest approach. */
    accessFromKm?: number;
    /** Road distance from that access point to the town, in km. */
    accessRoadKm?: number;
  }>;
}

function lineCoords(placemark: KmlPlacemark) {
  return placemark.geometries
    .filter((g) => g.type === "line")
    .flatMap((g) => (g.type === "line" ? g.coordinates : []));
}

function pointCoord(placemark: KmlPlacemark) {
  const point = placemark.geometries.find((g) => g.type === "point");
  return point && point.type === "point" ? point.coordinates : null;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Cosmetic pass over anything on its way to a CSV.
 *
 * Distances land on one decimal and elevations on whole metres - the trust's
 * own chainage is not accurate to the centimetre, so the extra digits are only
 * noise - and the long free-text columns move to the end, where they can run on
 * without pushing the numbers off the right of the screen.
 */
const CSV_KM_COLUMN = /\(km\)|\bkm\b/i;
const CSV_METRE_COLUMN = /\(m\)|\bm\b/i;
const CSV_LONG_TEXT_COLUMNS = new Set(["Notes", "Detail", "Description"]);

function tidyCsvRows(
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const keys = Object.keys(row);
    const tidied: Record<string, unknown> = {};
    for (const key of [
      ...keys.filter((k) => !CSV_LONG_TEXT_COLUMNS.has(k)),
      ...keys.filter((k) => CSV_LONG_TEXT_COLUMNS.has(k)),
    ]) {
      tidied[key] = tidyCsvValue(key, row[key]);
    }
    return tidied;
  });
}

function tidyCsvValue(column: string, value: unknown): unknown {
  if (typeof value !== "number" && typeof value !== "string") return value;
  if (typeof value === "string" && value.trim() === "") return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  if (CSV_KM_COLUMN.test(column)) return round(numeric, 1);
  if (CSV_METRE_COLUMN.test(column)) return Math.round(numeric);
  return value;
}

/** The same pass for tables gpx-tools hands back already rendered as CSV. */
function tidyCsvText(csv: string): string {
  const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
    header: true,
    skipEmptyLines: true,
  });
  return Papa.unparse(tidyCsvRows(parsed.data), { quotes: true });
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(docsDataDir, { recursive: true });

  const {
    kmz: KMZ,
    officialGpx: OFFICIAL_GPX,
    season,
    manifest: sourceManifest,
  } = resolveSource();

  console.log(`Reading ${KMZ}  (${season} release)`);
  const kml = await parseKmz(readFileSync(KMZ));
  console.log(
    `  ${kml.placemarks.length} placemarks across ${kml.folders.length} folders`
  );

  const byFolder = new Map<string, KmlPlacemark[]>();
  for (const placemark of kml.placemarks) {
    const folder = folderOf(placemark);
    const list = byFolder.get(folder);
    if (list) list.push(placemark);
    else byFolder.set(folder, [placemark]);
  }
  const folder = (name: string): KmlPlacemark[] => {
    const list = byFolder.get(name);
    if (!list)
      throw new Error(`KMZ has no folder named ${JSON.stringify(name)}`);
    return list;
  };

  // The trust stamps a version on every trail segment. Read it rather than
  // carrying it in a constant here, where it would silently describe the wrong
  // release the first time the build ran unattended.
  const version = folder(FOLDERS.mainTrail)[0].fields["Version"] ?? "";
  const versionLabel = /^\d/.test(version) ? `v${version}` : version;
  const ATTRIBUTION =
    `Te Araroa Trust, CC BY 4.0 NZ - ${season} trail data` +
    (versionLabel ? ` (${versionLabel})` : "");

  // ---------------------------------------------------------------- the route

  const allSegments: ChainedSegment[] = folder(FOLDERS.mainTrail).map(
    (placemark) => ({
      name: placemark.fields["NAME"] ?? placemark.name,
      section: placemark.fields["Section"] ?? "",
      fromKm: Number(placemark.fields["Fromkm"]),
      toKm: Number(placemark.fields["Tokm"]),
      status: placemark.fields["STATUS"] ?? "",
      island: placemark.fields["ISLAND"] ?? "",
      coordinates: lineCoords(placemark),
    })
  );

  const connectors = allSegments.filter((s) =>
    isTransportConnector(s.fromKm, s.toKm)
  );
  const walking = allSegments
    .filter((s) => !isTransportConnector(s.fromKm, s.toKm))
    .sort((a, b) => a.fromKm - b.fromKm || a.toKm - b.toKm);

  console.log(
    `  ${walking.length} walking segments, ${connectors.length} transport connectors`
  );

  const route = assembleRoute(walking);
  const officialKm = walking[walking.length - 1].toKm;
  const geometricKm = geometricLengthKm(route.points);
  const { ascent, descent } = elevationStats(route.points);

  console.log(
    `  route: ${route.points.length} points, official ${officialKm.toFixed(1)} km, ` +
      `geometry ${geometricKm.toFixed(1)} km`
  );
  console.log(`  ${route.breaks.length} gaps in the walking route:`);
  for (const gap of route.breaks) {
    const covering = connectors.filter(
      (c) => Math.abs(c.fromKm - gap.km) < 0.01
    );
    const label =
      covering.length > 0
        ? covering.map((c) => c.name).join(" / ")
        : "no published route";
    console.log(
      `    km ${gap.km.toFixed(1).padStart(7)}  ${(gap.distanceMeters / 1000).toFixed(1).padStart(5)} km  ` +
        `${gap.fromSegment} -> ${gap.toSegment}  [${label}]`
    );
  }

  // Chainage must be continuous or every distance downstream is wrong.
  const holes = walking
    .slice(1)
    .map((segment, i) => ({ gap: segment.fromKm - walking[i].toKm, segment }))
    .filter((entry) => Math.abs(entry.gap) > 0.002);
  if (holes.length > 0) {
    throw new Error(
      `Chainage is not continuous: ${holes.length} discontinuities, first at ` +
        `${holes[0].segment.name} (${holes[0].gap.toFixed(3)} km)`
    );
  }

  // ------------------------------------------------------------ hut/camp data

  const sectionAtKm = (km: number): { section: string; island: string } => {
    // Segments are chainage-ordered and contiguous, so a scan settles it.
    for (const segment of route.segments) {
      if (km >= segment.fromKm && km <= segment.toKm) {
        return { section: segment.section, island: segment.island };
      }
    }
    const last = route.segments[route.segments.length - 1];
    return { section: last.section, island: last.island };
  };

  /**
   * Trail elevation at a given km.
   *
   * The KMZ puts elevation on the line geometry only - every point feature is
   * published with z=0 - so a hut's height has to be read off the route. For a
   * site a long way off-trail this is the height where you leave the trail, not
   * the height of the site, which is why the column says "Trail elevation".
   */
  const elevationAt = (km: number): number =>
    route.points[indexAtKm(route.points, km)].ele;

  const sites: SiteRecord[] = [];

  for (const placemark of folder(FOLDERS.docSites)) {
    const coord = pointCoord(placemark);
    if (!coord) continue;
    const projection = projectOntoRoute(coord, route.points);
    const { section, island } = sectionAtKm(projection.km);
    sites.push({
      name: placemark.fields["Name of site"] || placemark.name,
      type: docSiteType(placemark.fields),
      lat: coord.lat,
      lon: coord.lon,
      ele: coord.ele || elevationAt(projection.km),
      km: projection.km,
      offTrailMeters: projection.offTrailMeters,
      section,
      island,
      source: "DOC",
      bunks: bunkCount(placemark.fields),
      water: hasWater(placemark.fields),
      bookingRequired: placemark.fields["Booking Required"] === "Yes",
      trailPass: placemark.fields["Te Araroa Pass"] ?? "",
      description: describeDocSite(placemark.fields),
      link: placemark.fields["URL to webpage"] ?? "",
      fields: placemark.fields,
    });
  }

  for (const placemark of folder(FOLDERS.privateCampsites)) {
    const coord = pointCoord(placemark);
    if (!coord) continue;
    const projection = projectOntoRoute(coord, route.points);
    const { section, island } = sectionAtKm(projection.km);
    sites.push({
      name: placemark.fields["name"] || placemark.name,
      type: privateSiteType(placemark.fields),
      lat: coord.lat,
      lon: coord.lon,
      ele: coord.ele || elevationAt(projection.km),
      km: projection.km,
      offTrailMeters: projection.offTrailMeters,
      section,
      island,
      source: "Private",
      bunks: null,
      water: false,
      bookingRequired: false,
      trailPass: "",
      description: describePrivateSite(placemark.fields),
      link: placemark.fields["website"] ?? "",
      fields: placemark.fields,
    });
  }

  // The KMZ contains no towns or shops at all - only 3 of its 184 sites sell
  // food - so a resupply sheet built from it alone is unusable. These are
  // researched by hand (see data/resupply.json for the sources) and positioned
  // the same way as everything else: projected onto the route, so the km is
  // where you leave the trail for the town, and offTrailMeters is how far.
  const resupply = JSON.parse(
    readFileSync(join(root, "data/resupply.json"), "utf8")
  ) as ResupplyFile;

  for (const point of resupply.points) {
    // An inland town's nearest approach is a straight line across country that
    // nobody walks - Geraldine's is 55 km over the Two Thumb Range, when the
    // real access is the Rangitata road end. Prefer a declared access point.
    const projection = projectOntoRoute(point, route.points);
    const km = point.accessFromKm ?? projection.km;
    const offTrailMeters =
      point.accessRoadKm !== undefined
        ? point.accessRoadKm * 1000
        : projection.offTrailMeters;
    const { section, island } = sectionAtKm(km);
    sites.push({
      name: point.name,
      type: point.type,
      lat: point.lat,
      lon: point.lon,
      ele: elevationAt(km),
      km,
      offTrailMeters,
      section,
      island,
      source: "Resupply",
      bunks: null,
      water: false,
      bookingRequired: false,
      trailPass: "",
      description: point.acceptsBoxes
        ? `${point.notes} Accepts resupply boxes.`
        : point.notes,
      link: "",
      fields: point.osm ? { osm: point.osm } : {},
    });
  }

  sites.sort((a, b) => a.km - b.km);
  console.log(
    `  ${sites.length} sites positioned on the route ` +
      `(${sites.filter((s) => s.source === "DOC").length} DOC, ` +
      `${sites.filter((s) => s.source === "Private").length} private, ` +
      `${sites.filter((s) => s.source === "Resupply").length} researched resupply)`
  );

  const stranded = sites.filter((s) => s.offTrailMeters > 5000);
  if (stranded.length > 0) {
    console.log(`  ${stranded.length} sites sit more than 5 km off the trail:`);
    for (const site of stranded) {
      console.log(
        `    ${(site.offTrailMeters / 1000).toFixed(1)} km  ${site.name}`
      );
    }
  }

  // ------------------------------------------- pieces both directions build on

  // The main route is one track. trail-maps concatenates a track's segments, so
  // splitting at the transport gaps would not change its distances; the split is
  // here because it is the honest GPX for a route with unwalked links in it.
  const mainSegments: RoutePoint[][] = [];
  let current: RoutePoint[] = [];
  const breakIndices = new Set(route.breaks.map((b) => b.index));
  route.points.forEach((point, index) => {
    current.push(point);
    if (breakIndices.has(index)) {
      mainSegments.push(current);
      current = [];
    }
  });
  if (current.length > 0) mainSegments.push(current);

  // Bypasses are published as bare lines with no chainage of their own, and the
  // trust does not draw them all the same way round. Projecting each one's two
  // endpoints onto the route gives it a km span, which is what lets
  // `writeDirection` lay it down pointing the way you are walking.
  const bypasses = folder(FOLDERS.bypasses)
    .map((placemark) => {
      const coordinates = lineCoords(placemark);
      const ends =
        coordinates.length > 0
          ? {
              startKm: projectOntoRoute(coordinates[0], route.points).km,
              endKm: projectOntoRoute(
                coordinates[coordinates.length - 1],
                route.points
              ).km,
            }
          : { startKm: 0, endKm: 0 };
      return {
        name: `Bypass: ${placemark.fields["Name"] ?? placemark.name}`,
        coordinates,
        ...ends,
      };
    })
    .filter((bypass) => bypass.coordinates.length > 0)
    .sort(
      (a, b) => Math.min(a.startKm, a.endKm) - Math.min(b.startKm, b.endKm)
    );

  const misdrawn = bypasses.filter((b) => b.endKm < b.startKm).length;
  if (misdrawn > 0) {
    console.log(
      `  ${misdrawn} of ${bypasses.length} bypasses are drawn against the trust's ` +
        `chainage; each is oriented to the direction being written`
    );
  }

  // Km markers every 10 km: enough to read position off the map, few enough not
  // to bury the huts. All 3,073 would swamp any waypoint list.
  const kmMarkers = folder(FOLDERS.kmMarkers)
    .map((placemark) => ({
      km: Number(placemark.fields["KM"]),
      section: placemark.fields["Section"] ?? "",
      coord: pointCoord(placemark),
    }))
    .filter(
      (marker): marker is { km: number; section: string; coord: Coord } =>
        Number.isFinite(marker.km) &&
        marker.km % 10 === 0 &&
        marker.coord !== null
    )
    .sort((a, b) => a.km - b.km);

  // ------------------------------------------------------- no-camping polygons

  const noCampingFeatures = folder(FOLDERS.noCamping).flatMap((placemark) =>
    placemark.geometries
      .filter((g) => g.type === "polygon")
      .map((geometry) => {
        if (geometry.type !== "polygon") throw new Error("unreachable");
        return {
          type: "Feature" as const,
          properties: {
            name: placemark.fields["Name"] ?? placemark.name,
            ...placemark.fields,
          },
          geometry: {
            type: "Polygon" as const,
            coordinates: [geometry.outer, ...geometry.inner].map((ring) =>
              ring.map((c) => [round(c.lon, 6), round(c.lat, 6)])
            ),
          },
        };
      })
  );
  writeFileSync(
    join(outDir, "no-camping-areas.geojson"),
    JSON.stringify(
      {
        type: "FeatureCollection",
        attribution: ATTRIBUTION,
        features: noCampingFeatures,
      },
      null,
      2
    )
  );
  console.log(
    `  wrote no-camping-areas.geojson (${noCampingFeatures.length} polygons)`
  );

  // Section boundaries in the trust's own chainage order. The spans belong to
  // the route, not to the direction you walk it, so they are found once and
  // mirrored per direction.
  const baseSections: SectionSpan[] = [];
  let sectionStart = route.segments[0];
  for (let i = 1; i <= route.segments.length; i++) {
    const segment = route.segments[i];
    const previous = route.segments[i - 1];
    if (!segment || segment.section !== sectionStart.section) {
      baseSections.push({
        section: sectionStart.section,
        island: sectionStart.island,
        fromKm: sectionStart.fromKm,
        toKm: previous.toKm,
      });
      if (segment) sectionStart = segment;
    }
  }

  const cumulativeAscentAt = buildCumulativeAscent(route.points);

  // ---------------------------------------------- one output set per direction

  const context: DirectionContext = {
    season,
    attribution: ATTRIBUTION,
    sites,
    connectors,
    mainSegments,
    bypasses,
    kmMarkers,
    baseSections,
    officialKm,
    geometricKm,
    routePointCount: route.points.length,
    elevationAt,
    cumulativeAscentAt,
  };

  const written = DIRECTIONS.map((direction) =>
    writeDirection(direction, context)
  );
  pruneSupersededGpx(
    DIRECTIONS.flatMap((direction) => {
      const files = directionFiles(direction, season);
      return [files.gpx, files.stableGpx];
    })
  );

  // ------------------------------------------------------- accuracy and stats

  // Run the cross-check before the metadata is assembled rather than after, so
  // its numbers land in the file. The project page and the README quote them,
  // and a figure quoted from a build log is a figure nobody can regenerate.
  const accuracy = crossCheckAgainstOfficialGpx(route.points, OFFICIAL_GPX);

  const resupplySites = sites.filter((s) => s.source === "Resupply");
  const byResupplyType: Record<string, number> = {};
  for (const point of resupply.points) {
    byResupplyType[point.type] = (byResupplyType[point.type] ?? 0) + 1;
  }

  // Which official sections a carry crosses. "St Arnaud to Boyle Village" is a
  // pair of place names; "Waiau Pass Track" is the reason it is 118 km without
  // a shop. The two sections it spends the most distance in carry that, and
  // being read off the route means they stay right through a reroute.
  const sectionsBetween = (fromKm: number, toKm: number): string[] =>
    baseSections
      .map((span) => ({
        name: span.section,
        fromKm: span.fromKm,
        overlap: Math.min(toKm, span.toKm) - Math.max(fromKm, span.fromKm),
      }))
      .filter((entry) => entry.overlap > 1)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 2)
      .sort((a, b) => a.fromKm - b.fromKm)
      .map((entry) => entry.name);

  // The longest you walk between one resupply point and the next. This is the
  // number that decides how much food a pack has to carry, so it is the one
  // worth stating outright. It is the same set of stretches whichever way you
  // walk; only the order reverses.
  const carries = resupplySites
    .slice(1)
    .map((site, i) => ({
      from: resupplySites[i].name,
      to: site.name,
      fromKm: round(resupplySites[i].km, 1),
      toKm: round(site.km, 1),
      distanceKm: round(site.km - resupplySites[i].km, 1),
      sections: sectionsBetween(resupplySites[i].km, site.km),
    }))
    .sort((a, b) => b.distanceKm - a.distanceKm)
    .slice(0, 5);

  // `stranded` covers every site, including towns whose off-trail figure is a
  // road distance we chose to record rather than a hut that genuinely sits that
  // far out. Only the trust's own sites belong in a claim about the trust's own
  // data, so the published figure counts those.
  const strandedOfficial = stranded.filter((s) => s.source !== "Resupply");
  const farthest = [...strandedOfficial].sort(
    (a, b) => b.offTrailMeters - a.offTrailMeters
  )[0];

  /**
   * Everything the README and the project page quote about this release.
   *
   * They are generated from this block (see src/docs.ts), so that a rebuild
   * cannot leave the prose describing a release the data no longer is. Track,
   * waypoint and row counts are the same in both directions, so the southbound
   * write speaks for both.
   */
  const stats = {
    officialGpxTrackPoints: accuracy?.officialTrackPoints ?? null,
    kmzTrackPoints: allSegments.reduce((n, s) => n + s.coordinates.length, 0),
    routePoints: route.points.length,
    tracks: written[0].tracks,
    waypoints: written[0].waypoints,
    sections: baseSections.length,
    docSites: sites.filter((s) => s.source === "DOC").length,
    privateSites: sites.filter((s) => s.source === "Private").length,
    officialSites: sites.filter((s) => s.source !== "Resupply").length,
    // The KMZ's own food count, which is the case for data/resupply.json
    // existing at all.
    officialFoodSites: sites.filter(
      (s) => s.source !== "Resupply" && s.type === "food"
    ).length,
    bypasses: folder(FOLDERS.bypasses).length,
    noCampingAreas: noCampingFeatures.length,
    planRows: written[0].planRows,
    resupply: {
      total: resupply.points.length,
      byType: byResupplyType,
      acceptsBoxes: resupply.points.filter((p) => p.acceptsBoxes).length,
      researchedAt: resupply.researchedAt ?? "",
    },
    longestCarries: carries,
    strandedSites: strandedOfficial.length,
    strandedSitesIncludingTowns: stranded.length,
    farthestSite: farthest
      ? {
          name: farthest.name,
          offTrailKm: round(farthest.offTrailMeters / 1000, 1),
        }
      : null,
    accuracy,
  };

  // ---------------------------------------------------------------- metadata

  const meta = {
    trail: TRAIL_NAME,
    season,
    version: versionLabel,
    attribution: ATTRIBUTION,
    // Every `km` in this file is the trust's own chainage, which runs
    // southbound from Cape Reinga. There is deliberately no northbound copy of
    // this file: a second set of the same coordinates under mirrored numbers
    // would be one more thing to fall out of step. Northbound km is
    // `officialLengthKm - km`, and the northbound CSVs in out/ have it applied.
    chainage: {
      direction: "SOBO",
      origin: "Cape Reinga",
      northboundKm: "officialLengthKm - km",
    },
    directions: DIRECTIONS.map((d) => ({
      id: d.id,
      code: d.code,
      label: d.label,
      from: d.from,
      to: d.to,
      files: Object.values(directionFiles(d, season)),
    })),
    generatedAt: new Date().toISOString(),
    // Which bytes this was built from. A consumer holding a copy of these files
    // can confirm it is looking at the same release, and anyone wondering
    // whether the trust has moved on since can re-run `npm run fetch` and
    // compare. Without this, the season stamped above is only a claim.
    source: sourceManifest
      ? {
          fetchedAt: sourceManifest.fetchedAt,
          files: sourceManifest.files.map((f) => ({
            file: f.file,
            url: f.url,
            bytes: f.bytes,
            sha256: f.sha256,
          })),
        }
      : { kmz: basename(KMZ), gpx: basename(OFFICIAL_GPX) },
    stats,
    officialLengthKm: round(officialKm, 3),
    geometricLengthKm: round(geometricKm, 3),
    routePoints: route.points.length,
    ascentMeters: Math.round(ascent),
    descentMeters: Math.round(descent),
    transportConnectors: connectors.map((c) => ({
      name: c.name,
      km: round(c.fromKm, 3),
      status: c.status,
      lengthKm: round(geometricLengthKm(c.coordinates), 3),
    })),
    // Every place the walking route stops and starts again. Some are covered by
    // a published ferry route, the rest are links you arrange yourself.
    routeGaps: route.breaks.map((b) => {
      const covering = connectors.filter(
        (c) => Math.abs(c.fromKm - b.km) < 0.01
      );
      return {
        km: round(b.km, 3),
        straightLineKm: round(b.distanceMeters / 1000, 3),
        from: b.fromSegment,
        to: b.toSegment,
        coveredBy: covering.map((c) => c.name),
        kind: covering.length > 0 ? ("ferry" as const) : ("unmapped" as const),
      };
    }),
    sections: baseSections.map((s) => ({
      Section: s.section,
      Island: s.island,
      "Start km": round(s.fromKm, 2),
      "End km": round(s.toKm, 2),
      "Length km": round(s.toKm - s.fromKm, 2),
    })),
    sites: sites.map((site) => ({
      name: site.name,
      type: site.type,
      source: site.source,
      km: round(site.km, 3),
      lat: round(site.lat, 6),
      lon: round(site.lon, 6),
      elevation: Math.round(site.ele),
      offTrailMeters: Math.round(site.offTrailMeters),
      section: site.section,
      island: site.island,
      bunks: site.bunks,
      fields: site.fields,
    })),
  };
  writeFileSync(
    join(outDir, "te-araroa.meta.json"),
    JSON.stringify(meta, null, 2)
  );
  console.log("  wrote te-araroa.meta.json");

  writeDocsOverview(route.points, sites, meta);

  // The README and the project page quote these numbers. Regenerating them here
  // rather than in a separate step someone has to remember is the whole point:
  // an unattended build that refreshed the data and left the prose describing
  // the previous release would be lying in a way nobody would notice.
  writeDocs();
}

/**
 * Write one direction's GPX, planning CSVs and datasheets.
 *
 * Called once per entry in `DIRECTIONS`. Everything in `context` is expressed
 * in the trust's southbound chainage; this function is the only place that
 * knows about the other direction.
 */
interface DirectionResult {
  tracks: number;
  waypoints: number;
  planRows: number;
}

function writeDirection(
  direction: DirectionSpec,
  context: DirectionContext
): DirectionResult {
  const {
    season,
    attribution: ATTRIBUTION,
    sites,
    connectors,
    mainSegments,
    bypasses,
    kmMarkers,
    baseSections,
    officialKm,
    geometricKm,
    routePointCount,
    elevationAt,
    cumulativeAscentAt,
  } = context;

  const nobo = direction.id === "nobo";
  const files = directionFiles(direction, season);

  /** Distance walked so far in this direction, from an official km. */
  const progressKm = (km: number): number => (nobo ? officialKm - km : km);

  /** Coordinates in the order you would walk them. */
  const inOrder = <T>(items: T[]): T[] => (nobo ? [...items].reverse() : items);

  /**
   * Climb and drop over a leg, from the southbound prefix sums.
   *
   * Walking a stretch the other way turns its ascent into descent, so the two
   * sums swap rather than being recomputed. `from`/`to` are official km, and
   * for a northbound leg `from` is the larger of the two.
   */
  const legClimb = (fromKm: number, toKm: number) => {
    const a = cumulativeAscentAt(fromKm);
    const b = cumulativeAscentAt(toKm);
    return nobo
      ? { ascent: a.descent - b.descent, descent: a.ascent - b.ascent }
      : { ascent: b.ascent - a.ascent, descent: b.descent - a.descent };
  };

  // ------------------------------------------------------------------ the GPX

  const ordered = inOrder(sites);

  const waypoints: GpxWaypoint[] = ordered.map((site) => ({
    lat: site.lat,
    lon: site.lon,
    ele: site.ele,
    name: site.name,
    // Leading km makes the waypoint self-locating in any viewer that only shows
    // a name. Northbound carries the official km alongside it, because that is
    // the number the trust's trail notes, its physical markers and every
    // southbound hiker you meet will be using.
    desc: nobo
      ? `km ${progressKm(site.km).toFixed(1)} (TA ${site.km.toFixed(1)}) | ${site.description}`
      : `km ${site.km.toFixed(1)} | ${site.description}`,
    type: site.type,
    cmt: site.section,
    ...(site.link ? { link: site.link } : {}),
  }));

  // Km markers keep the trust's own number as their name in both directions -
  // those are the round ones, and mirroring them would give a list of markers
  // reading 3063.2, 3053.2, 3043.2. Northbound progress goes in the note.
  for (const marker of inOrder(kmMarkers)) {
    waypoints.push({
      lat: marker.coord.lat,
      lon: marker.coord.lon,
      ele: marker.coord.ele,
      name: `${marker.km} km`,
      desc: nobo
        ? `${marker.section} | ${progressKm(marker.km).toFixed(1)} km northbound`
        : marker.section,
      type: "waypoint",
    });
  }

  const mainTrack: GpxTrack = {
    name: `${TRAIL_NAME} (${direction.code})`,
    segments: inOrder(mainSegments).map((points) => ({
      points: inOrder(points).map((p) => ({
        lat: p.lat,
        lon: p.lon,
        ele: p.ele,
        time: null,
      })),
    })),
  };

  const tracks: GpxTrack[] = [
    mainTrack,
    {
      name: "Te Araroa - Transport Connectors",
      segments: inOrder(connectors).map((segment) => ({
        points: inOrder(segment.coordinates).map((c) => ({
          lat: c.lat,
          lon: c.lon,
          ele: c.ele,
          time: null,
        })),
      })),
    },
  ];

  for (const bypass of inOrder(bypasses)) {
    // Point the bypass the way you are walking, whichever way it was drawn.
    const drawnWithChainage = bypass.endKm >= bypass.startKm;
    const coords =
      drawnWithChainage === nobo
        ? [...bypass.coordinates].reverse()
        : bypass.coordinates;
    tracks.push({
      name: bypass.name,
      segments: [
        {
          points: coords.map((c) => ({
            lat: c.lat,
            lon: c.lon,
            ele: c.ele,
            time: null,
          })),
        },
      ],
    });
  }

  const gpx = writeGpx(
    { tracks, routes: [], waypoints },
    {
      name: `${TRAIL_NAME} ${season} (${direction.code})`,
      desc:
        `Built from the official KMZ, walked ${direction.from} to ${direction.to}. ` +
        `Official chainage ${officialKm.toFixed(1)} km (measured southbound from ` +
        `Cape Reinga); route geometry ${geometricKm.toFixed(1)} km over ` +
        `${routePointCount} points.`,
      author: "Te Araroa Trust",
      keywords: ATTRIBUTION,
      creator: "te-araroa-data (gpx-tools kml-parser)",
    }
  );
  // Written twice: under the release's name, and under a name that never
  // changes so links to it survive a season rollover.
  writeFileSync(join(outDir, files.gpx), gpx);
  writeFileSync(join(outDir, files.stableGpx), gpx);
  console.log(
    `  wrote ${files.gpx} and ${files.stableGpx} (${(gpx.length / 1e6).toFixed(1)} MB, ` +
      `${tracks.length} tracks, ${waypoints.length} waypoints)`
  );

  // ------------------------------------------------------------- sections CSV

  const sectionRows = inOrder(baseSections).map((span) => {
    const start = progressKm(nobo ? span.toKm : span.fromKm);
    const end = progressKm(nobo ? span.fromKm : span.toKm);
    return {
      Section: span.section,
      Island: span.island,
      "Start km": round(start, 2),
      "End km": round(end, 2),
      "Length km": round(span.toKm - span.fromKm, 2),
      "Official start km": round(span.fromKm, 2),
      "Official end km": round(span.toKm, 2),
    };
  });
  writeFileSync(
    join(outDir, files.sections),
    Papa.unparse(tidyCsvRows(sectionRows), { quotes: true })
  );
  console.log(`  wrote ${files.sections} (${sectionRows.length} sections)`);

  // -------------------------------------------------------- resupply planning

  const planRows = ordered.map((site, index) => {
    const previous = index > 0 ? ordered[index - 1] : null;
    const next = index < ordered.length - 1 ? ordered[index + 1] : null;
    const climb = previous
      ? legClimb(previous.km, site.km)
      : { ascent: 0, descent: 0 };

    return {
      Km: round(progressKm(site.km), 2),
      // In the southbound sheet this repeats the column before it. It is here
      // anyway so the two files have one schema, and so that nothing reading
      // the northbound sheet has to know the trail's length to recover the
      // trust's number.
      "Official km": round(site.km, 2),
      Name: site.name,
      Type: site.type,
      Source: site.source,
      Section: site.section,
      Island: site.island,
      "Trail elevation m": Math.round(elevationAt(site.km)),
      "Off trail m": Math.round(site.offTrailMeters),
      "From previous km": previous
        ? round(Math.abs(site.km - previous.km), 2)
        : 0,
      "To next km": next ? round(Math.abs(next.km - site.km), 2) : 0,
      "Leg ascent m": Math.round(climb.ascent),
      "Leg descent m": Math.round(climb.descent),
      Bunks: site.bunks ?? "",
      Water: site.water ? "Yes" : "",
      "Booking required": site.bookingRequired ? "Yes" : "",
      "Trail Pass": site.trailPass,
      Phone: site.fields["phone"] ?? "",
      Address: site.fields["physical_address"] ?? "",
      Hours: site.fields["opening_hours"] ?? "",
      Link: site.link,
      Detail: site.description,
    };
  });
  writeFileSync(
    join(outDir, files.plan),
    Papa.unparse(tidyCsvRows(planRows), { quotes: true })
  );
  console.log(`  wrote ${files.plan} (${planRows.length} rows)`);

  // ----------------------------------------- the same route through gpx-tools

  // Only the main route goes in. `processGpxTravelPlan` totals every track it
  // is given, so handing it the bypasses and connectors as well would report a
  // trail nearly 5,000 km long.
  const mainRouteGpx = writeGpx(
    { tracks: [mainTrack], routes: [], waypoints },
    {
      name: `${TRAIL_NAME} ${season} (${direction.code}) - main route`,
      keywords: ATTRIBUTION,
    }
  );
  const datasheet = processGpxTravelPlan(mainRouteGpx, {
    // The KMZ has no shops in it, so "resupply" here means a site that sells
    // food or a holiday park in a town - see README on filling this gap.
    resupplyKeywords: [
      "holiday park",
      "store",
      "shop",
      "hotel",
      "tavern",
      "motor camp",
      "campground",
    ],
    waypointMaxDistance: 500,
  });
  writeFileSync(
    join(outDir, files.datasheet),
    tidyCsvText(datasheet.processedPlan)
  );
  writeFileSync(
    join(outDir, files.datasheetResupply),
    tidyCsvText(datasheet.resupplyPoints)
  );
  console.log(
    `  wrote ${files.datasheet} via gpx-tools ` +
      `(${datasheet.stats.matchedWaypoints}/${datasheet.stats.totalWaypoints} waypoints matched, ` +
      `${datasheet.stats.totalDistance.toFixed(1)} km)`
  );

  return {
    tracks: tracks.length,
    waypoints: waypoints.length,
    planRows: planRows.length,
  };
}

/**
 * A small GeoJSON for the project page's map.
 *
 * The published GPX is 3.5 MB and the no-camping polygons 3.3 MB, which is fine
 * for a GPS unit and hopeless for a web page - and the people most likely to
 * open that page are on a phone in a town with one bar of signal. Simplifying to
 * a 50 m tolerance drops the route to a few thousand points, which at the zoom
 * levels a whole-country overview can show is visually identical.
 */
function writeDocsOverview(
  points: RoutePoint[],
  sites: SiteRecord[],
  meta: { officialLengthKm: number; geometricLengthKm: number; season: string }
): void {
  const simplified = douglasPeucker(
    points.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: null })),
    50
  );

  const overview = {
    type: "FeatureCollection" as const,
    properties: {
      note: "Simplified overview for the project page map. Use the GPX in out/ for anything real.",
      season: meta.season,
      officialLengthKm: meta.officialLengthKm,
      geometricLengthKm: meta.geometricLengthKm,
      routePoints: simplified.length,
    },
    features: [
      {
        type: "Feature" as const,
        properties: { name: TRAIL_NAME, kind: "route" },
        geometry: {
          type: "LineString" as const,
          coordinates: simplified.map((p) => [
            round(p.lon, 5),
            round(p.lat, 5),
          ]),
        },
      },
      ...sites.map((site) => ({
        type: "Feature" as const,
        properties: {
          name: site.name,
          kind: site.type,
          source: site.source,
          km: round(site.km, 1),
          section: site.section,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [round(site.lon, 5), round(site.lat, 5)],
        },
      })),
    ],
  };

  const path = join(docsDataDir, "overview.geojson");
  writeFileSync(path, JSON.stringify(overview));
  const kb = Math.round(JSON.stringify(overview).length / 1024);
  console.log(
    `  wrote docs/data/overview.geojson ` +
      `(${points.length} route points simplified to ${simplified.length}, ${kb} KB)`
  );
}

/**
 * Cumulative ascent/descent lookups by official km.
 *
 * Built once as a prefix sum so a datasheet with hundreds of rows does not walk
 * the 35,000-point route for every leg.
 */
function buildCumulativeAscent(points: RoutePoint[]) {
  const ascent = new Float64Array(points.length);
  const descent = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].ele - points[i - 1].ele;
    ascent[i] = ascent[i - 1] + (delta > 0 ? delta : 0);
    descent[i] = descent[i - 1] + (delta < 0 ? -delta : 0);
  }
  return (km: number) => {
    const index = indexAtKm(points, km);
    return { ascent: ascent[index], descent: descent[index] };
  };
}

/** Binary search for the first route vertex at or past `km`. */
function indexAtKm(points: RoutePoint[], km: number): number {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid].km < km) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Sanity-check the assembled route against the trust's own GPX.
 *
 * The GPX is the same 466 walking segments in alphabetical order, so it cannot
 * be used to build a route - but its km-marker waypoints are an independent
 * statement of where each km falls, which is exactly what our chainage
 * interpolation claims to reproduce.
 */
interface Accuracy {
  markers: number;
  meanErrorMeters: number;
  worstErrorKm: number;
  worstAtKm: number;
  /** Track points in the official GPX, for the comparison the README makes. */
  officialTrackPoints: number;
}

function crossCheckAgainstOfficialGpx(
  points: RoutePoint[],
  officialGpxPath: string
): Accuracy | null {
  let xml: string;
  try {
    xml = readFileSync(officialGpxPath, "utf8");
  } catch {
    console.log("  (official GPX not present, skipping cross-check)");
    return null;
  }
  const officialTrackPoints = (xml.match(/<trkpt\b/g) ?? []).length;

  const markers = [
    ...xml.matchAll(
      /<wpt lat="([^"]+)" lon="([^"]+)">\s*<name>(\d+) km<\/name>/g
    ),
  ];
  if (markers.length === 0) {
    console.log("  (no km markers in the official GPX, skipping cross-check)");
    return null;
  }

  let worst = 0;
  let worstKm = 0;
  let total = 0;
  for (const marker of markers) {
    const lat = Number(marker[1]);
    const lon = Number(marker[2]);
    const declared = Number(marker[3]);
    const { km } = projectOntoRoute({ lat, lon }, points);
    const error = Math.abs(km - declared);
    total += error;
    if (error > worst) {
      worst = error;
      worstKm = declared;
    }
  }

  console.log(
    `  cross-check against ${markers.length} official km markers: ` +
      `mean error ${((total / markers.length) * 1000).toFixed(0)} m, ` +
      `worst ${worst.toFixed(3)} km (at km ${worstKm})`
  );

  return {
    markers: markers.length,
    meanErrorMeters: Math.round((total / markers.length) * 1000),
    worstErrorKm: round(worst, 3),
    worstAtKm: worstKm,
    officialTrackPoints,
  };
}

await main();
