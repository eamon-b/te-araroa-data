/**
 * Te Araroa specifics: which KMZ folder means what, and how the trust's GIS
 * attribute names map onto the vocabulary the trail-maps and gpx-tools
 * pipelines already use.
 *
 * Everything trail-agnostic lives in gpx-tools' `kml-parser`; everything that
 * would be wrong for the next trail lives here.
 */

import type { KmlPlacemark } from "../../../gpx-tools/src/lib/kml-parser";

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
  "opening_hours",
  "website",
  "categories",
];

const FIELD_LABELS: Record<string, string> = {
  tags: "Facilities",
  physical_address: "Address",
  phone: "Phone",
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
