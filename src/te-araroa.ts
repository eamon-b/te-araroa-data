/**
 * Te Araroa specifics: which KMZ folder means what, and how the trust's GIS
 * attribute names map onto the vocabulary the trail-maps and gpx-tools
 * pipelines already use.
 *
 * Everything trail-agnostic lives in gpx-tools' `kml-parser`; everything that
 * would be wrong for the next trail lives here.
 */

import type { KmlPlacemark } from "gpx-tools/lib/kml-parser";

/** The folders the 2026-27 KMZ ships, as they are named in `doc.kml`. */
export const FOLDERS = {
  docSites: "DOC Huts & Campsites",
  privateCampsites: "Private Campsites",
  kmMarkers: "Km Markers",
  kmMarkersNobo: "Km Markers (NOBO)",
  bypassKmMarkers: "Bypass Km Markers",
  // The published file writes this with two spaces before "(NOBO)".
  bypassKmMarkersNobo: "Bypass Km Markers  (NOBO)",
  mainTrail: "Main Trail",
  // Published with trailing spaces, which the parser trims off.
  bypasses: "Bypasses (inc. River Hazard Zones)",
  noCamping: "No Freedom Camping Areas",
} as const;

export function folderOf(placemark: KmlPlacemark): string {
  return placemark.folder[placemark.folder.length - 1] ?? "";
}

/**
 * A DOC site's `Type` maps onto our waypoint vocabulary directly. "Hut and
 * Campsite" becomes a hut, because the hut is the thing you plan around; the
 * campsite is recorded in the description.
 */
export function docSiteType(fields: Record<string, string>): string {
  const type = fields["Type"] ?? "";
  if (type === "Campsite") return "campsite";
  return "hut";
}

/**
 * A private site's category decides whether it is shelter or food.
 *
 * This matters more than it looks: trail-maps counts only `town`/`food`/
 * `resupply` as a resupply point, and deliberately does not count
 * `accommodation` or `caravan-park`, on the grounds that a bed is not a
 * grocery. So only sites that actually advertise a store, bar or restaurant are
 * typed as food.
 */
export function privateSiteType(fields: Record<string, string>): string {
  const categories = fields["categories"] ?? "";
  const tags = (fields["tags"] ?? "").toLowerCase();

  if (/BarOrPub|Restaurant/.test(categories) || /\bstore\b|\bshop\b/.test(tags))
    return "food";
  if (/RVPark/.test(categories)) return "caravan-park";
  if (/Motel|Hostel|LodgingBusiness/.test(categories)) return "accommodation";
  if (/shelter|free hut/.test(tags)) return "hut";
  return "campsite";
}

/** Order the description fields so the useful ones lead. */
const DOC_FIELD_ORDER = [
  "Category",
  "Facilities",
  "Bookable",
  "Booking Required",
  "Te Araroa Pass",
  "Discount",
  "More Info",
  "Place",
  "Region",
];

const PRIVATE_FIELD_ORDER = [
  "tags",
  "physical_address",
  "phone",
  "email",
  "opening_hours",
  "website",
  "categories",
];

const FIELD_LABELS: Record<string, string> = {
  tags: "Facilities",
  physical_address: "Address",
  phone: "Phone",
  email: "Email",
  opening_hours: "Hours",
  website: "Website",
  categories: "Categories",
  "Te Araroa Pass": "Trail Pass",
  Discount: "Trail Pass discount (%)",
};

/**
 * Flatten the GIS attributes into a single `<desc>` line.
 *
 * GPX has nowhere structured to put "6 bunks, booking required, 0800 473 281",
 * and a reader (or a phone screen) wants it as a sentence anyway. The full
 * structured record survives separately in the sidecar JSON.
 */
export function describeSite(
  fields: Record<string, string>,
  order: string[]
): string {
  const parts: string[] = [];
  for (const key of order) {
    const value = fields[key];
    if (!value) continue;
    parts.push(`${FIELD_LABELS[key] ?? key}: ${value}`);
  }
  return parts.join(" | ");
}

export function describeDocSite(fields: Record<string, string>): string {
  return describeSite(fields, DOC_FIELD_ORDER);
}

export function describePrivateSite(fields: Record<string, string>): string {
  return describeSite(fields, PRIVATE_FIELD_ORDER);
}

/**
 * Bunk count, pulled out of the DOC `Facilities` free-text where it appears.
 *
 * DOC writes it as "6 Bunks" or "Bunks: 20" depending on the record, and it is
 * the single most useful number when deciding whether a hut is a realistic
 * night's stop.
 */
export function bunkCount(fields: Record<string, string>): number | null {
  const facilities = fields["Facilities"] ?? "";
  const match =
    facilities.match(/(\d+)\s*(?:bunks?|beds?)/i) ??
    facilities.match(/(?:bunks?|beds?)\D{0,3}(\d+)/i);
  return match ? Number(match[1]) : null;
}

/** Whether the DOC record mentions a water supply at the site. */
export function hasWater(fields: Record<string, string>): boolean {
  return /water/i.test(fields["Facilities"] ?? "");
}

/**
 * A segment whose chainage does not advance is a transport link - a ferry, a
 * water taxi, a harbour crossing. The trust gives these `Fromkm === Tokm`, so
 * they contribute nothing to the official 3,073 km, and they must be kept out
 * of the walking route or they inflate every distance downstream.
 */
export function isTransportConnector(fromKm: number, toKm: number): boolean {
  return Math.abs(toKm - fromKm) < 1e-6;
}

/**
 * A hand correction to one of the trust's site records.
 *
 * The KMZ is the trust's data and the build otherwise passes it through
 * untouched, but some of it is wrong in ways that do not wait for the next
 * release: a misspelt name, a business that has changed hands, a field holding
 * somebody's private email address. `data/site-corrections.json` holds those,
 * each with the reason and the source that justifies it.
 *
 * A correction is keyed by the record's ArcGIS GlobalID rather than its name,
 * because the name is one of the things it corrects. It also names the record
 * as the trust publishes it, and the build refuses to apply it if that no
 * longer matches: a correction written against one record must not quietly
 * land on whatever the trust puts under that id next season.
 */
export interface SiteCorrection {
  /** The record's `GlobalID` (DOC) or `globalid` (private), braces included. */
  globalId: string;
  /** The site's name as the trust publishes it. */
  trustName: string;
  /** Fields to replace, by the trust's own attribute name. */
  set?: Record<string, string>;
  /** Fields to drop, and not publish anywhere. */
  remove?: string[];
  /**
   * Fields whose value is right but filed under the wrong attribute, moved
   * from the key to the value: `{ "phone": "email" }`.
   */
  move?: Record<string, string>;
  /**
   * The waypoint type to publish, where the one the build derives from the
   * trust's attributes is wrong. Changing a type re-keys the waypoint in
   * trail-maps' id registry, so say so in the pull request.
   */
  type?: string;
  /** A sentence put in front of the site's description. */
  note?: string;
  reason: string;
  /** Where the correction can be checked. Omitted only where there is none. */
  source?: string;
}

/** What the trust's attributes were, for the fields a correction replaced. */
export interface AppliedCorrection {
  /**
   * The trust's value of each replaced field. Removed fields are listed by
   * name only: a field is removed precisely because its value must not be
   * published, so it is not published here either.
   */
  replaced: Record<string, string>;
  removed: string[];
  /** Fields moved to another attribute, from -> to. The value is unchanged. */
  moved: Record<string, string>;
  /** The type the build derived from the trust's record, and the one published. */
  retyped?: { from: string; to: string };
  note?: string;
  reason: string;
  source?: string;
}

/** The ArcGIS GlobalID of a site record, whichever folder it came from. */
export function siteGlobalId(fields: Record<string, string>): string {
  return fields["GlobalID"] ?? fields["globalid"] ?? "";
}

/** The trust's name for a site record, whichever folder it came from. */
export function siteTrustName(
  fields: Record<string, string>,
  fallback = ""
): string {
  return fields["Name of site"] || fields["name"] || fallback;
}

/**
 * Apply a correction to a copy of a site's attributes.
 *
 * Throws if the record is not the one the correction was written for, or if a
 * field it replaces or removes is not there - either means the trust has
 * changed the record and the correction needs a person to look at it again.
 */
export function applySiteCorrection(
  fields: Record<string, string>,
  correction: SiteCorrection,
  fallbackName = "",
  typeOf?: (fields: Record<string, string>) => string
): { fields: Record<string, string>; applied: AppliedCorrection } {
  const name = siteTrustName(fields, fallbackName);
  if (name !== correction.trustName) {
    throw new Error(
      `site correction ${correction.globalId} was written for ` +
        `${JSON.stringify(correction.trustName)}, but the trust now publishes ` +
        `${JSON.stringify(name)} under that id. Check data/site-corrections.json.`
    );
  }
  const next = { ...fields };
  const replaced: Record<string, string> = {};
  for (const [key, value] of Object.entries(correction.set ?? {})) {
    if (!(key in fields)) {
      throw new Error(
        `site correction for ${correction.trustName} replaces ${key}, which ` +
          `the trust's record does not have. Check data/site-corrections.json.`
      );
    }
    replaced[key] = fields[key];
    next[key] = value;
  }
  for (const key of correction.remove ?? []) {
    if (!(key in fields)) {
      throw new Error(
        `site correction for ${correction.trustName} removes ${key}, which ` +
          `the trust's record no longer has. Check data/site-corrections.json.`
      );
    }
    delete next[key];
  }
  for (const [from, to] of Object.entries(correction.move ?? {})) {
    if (!(from in fields)) {
      throw new Error(
        `site correction for ${correction.trustName} moves ${from}, which ` +
          `the trust's record no longer has. Check data/site-corrections.json.`
      );
    }
    if (to in fields) {
      throw new Error(
        `site correction for ${correction.trustName} moves ${from} to ${to}, ` +
          `but the trust's record already has ${to}. Check data/site-corrections.json.`
      );
    }
    next[to] = fields[from];
    delete next[from];
  }
  let retyped: { from: string; to: string } | undefined;
  if (correction.type !== undefined) {
    if (!typeOf) {
      throw new Error(
        `site correction for ${correction.trustName} sets a type, but no ` +
          `type mapping was given to compare it with`
      );
    }
    const from = typeOf(fields);
    if (from === correction.type) {
      throw new Error(
        `site correction for ${correction.trustName} retypes it to ` +
          `${correction.type}, which the trust's record already maps to. ` +
          `Check data/site-corrections.json.`
      );
    }
    retyped = { from, to: correction.type };
  }
  return {
    fields: next,
    applied: {
      replaced,
      removed: [...(correction.remove ?? [])],
      moved: { ...(correction.move ?? {}) },
      ...(retyped ? { retyped } : {}),
      ...(correction.note ? { note: correction.note } : {}),
      reason: correction.reason,
      ...(correction.source ? { source: correction.source } : {}),
    },
  };
}

/**
 * Correct one of the trust's route names - a section, a segment, a crossing -
 * where `data/site-corrections.json` says it is misspelt. Exact match only, so
 * a name the trust has since fixed or reworded passes through unchanged.
 */
export function correctRouteName(
  name: string,
  corrections: Record<string, string>
): string {
  return Object.hasOwn(corrections, name) ? corrections[name] : name;
}
