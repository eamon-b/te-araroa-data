/**
 * How the trust's GIS attributes become the vocabulary everything downstream
 * plans with. These are the mappings that decide whether a site shows up as a
 * place to sleep or a place to buy food, and how many nights of food a hiker
 * thinks they need to carry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { KmlPlacemark } from "gpx-tools/lib/kml-parser";

import {
  FOLDERS,
  applySiteCorrection,
  bunkCount,
  correctRouteName,
  describeDocSite,
  describePrivateSite,
  docSiteType,
  folderOf,
  hasWater,
  isTransportConnector,
  privateSiteType,
  siteGlobalId,
} from "../src/te-araroa.ts";

test("folderOf reads the deepest folder a placemark sits in", () => {
  const placemark = (folder: string[]) =>
    ({ folder, name: "x", fields: {}, geometries: [] }) as unknown as KmlPlacemark;

  assert.equal(
    folderOf(placemark(["Te Araroa", FOLDERS.docSites])),
    "DOC Huts & Campsites"
  );
  assert.equal(folderOf(placemark([])), "");
});

test("a DOC site is a hut unless it is only a campsite", () => {
  assert.equal(docSiteType({ Type: "Campsite" }), "campsite");
  assert.equal(docSiteType({ Type: "Hut" }), "hut");
  // The hut is the thing you plan around, so a combined site is a hut.
  assert.equal(docSiteType({ Type: "Hut and Campsite" }), "hut");
  assert.equal(docSiteType({}), "hut");
});

test("a private site is food only when it actually sells food", () => {
  assert.equal(privateSiteType({ categories: "BarOrPub" }), "food");
  assert.equal(privateSiteType({ categories: "Restaurant,RVPark" }), "food");
  assert.equal(privateSiteType({ tags: "Camping, Store, Showers" }), "food");

  // A bed is not a grocery: these must not read as resupply downstream.
  assert.equal(privateSiteType({ categories: "RVPark" }), "caravan-park");
  assert.equal(privateSiteType({ categories: "Motel" }), "accommodation");
  assert.equal(privateSiteType({ categories: "Hostel" }), "accommodation");
  assert.equal(privateSiteType({ categories: "LodgingBusiness" }), "accommodation");

  assert.equal(privateSiteType({ tags: "Free hut, water" }), "hut");
  assert.equal(privateSiteType({ tags: "Shelter" }), "hut");
  assert.equal(privateSiteType({}), "campsite");

  // Food wins over a bed when the site is both.
  assert.equal(
    privateSiteType({ categories: "Motel", tags: "Shop on site" }),
    "food"
  );
  // "Bookstore" is not a shop you resupply at - the word must stand alone.
  assert.equal(privateSiteType({ tags: "bookstore nearby" }), "campsite");
});

test("descriptions lead with the useful fields and relabel the obscure ones", () => {
  assert.equal(
    describeDocSite({
      Region: "Northland",
      Facilities: "12 Bunks, Water supply",
      Category: "Standard",
      "Te Araroa Pass": "Yes",
      Discount: "100",
      Unlisted: "should not appear",
    }),
    "Category: Standard | Facilities: 12 Bunks, Water supply | " +
      "Trail Pass: Yes | Trail Pass discount (%): 100 | Region: Northland"
  );

  // Empty fields are dropped rather than left as dangling labels.
  assert.equal(describeDocSite({ Category: "Basic", Region: "" }), "Category: Basic");
  assert.equal(describeDocSite({}), "");

  assert.equal(
    describePrivateSite({
      website: "https://example.nz",
      tags: "Camping, Showers",
      phone: "0800 473 281",
    }),
    "Facilities: Camping, Showers | Phone: 0800 473 281 | Website: https://example.nz"
  );
});

test("bunkCount reads both ways DOC writes it", () => {
  assert.equal(bunkCount({ Facilities: "6 Bunks, Toilets" }), 6);
  assert.equal(bunkCount({ Facilities: "Bunks: 20" }), 20);
  assert.equal(bunkCount({ Facilities: "Sleeping platform, 12 beds" }), 12);
  assert.equal(bunkCount({ Facilities: "Toilets - non-flush, Water supply" }), null);
  assert.equal(bunkCount({}), null);
});

test("hasWater looks for a water supply in the facilities", () => {
  assert.equal(hasWater({ Facilities: "Water from tap - not treated" }), true);
  assert.equal(hasWater({ Facilities: "Toilets - non-flush" }), false);
  assert.equal(hasWater({}), false);
});

test("a segment whose chainage does not advance is a transport connector", () => {
  // Ferries and water taxis: the trust gives them Fromkm === Tokm, and letting
  // one into the walking route would inflate every distance after it.
  assert.equal(isTransportConnector(1503.2, 1503.2), true);
  assert.equal(isTransportConnector(0, 1e-9), true);
  assert.equal(isTransportConnector(1503.2, 1503.3), false);
  assert.equal(isTransportConnector(0, 3073.2), false);
});

test("a site correction replaces and removes fields on a copy", () => {
  const trust = {
    name: "Happy Dayz Accomodation",
    phone: "someone@example.com",
    globalid: "{A}",
  };
  const { fields, applied } = applySiteCorrection(trust, {
    globalId: "{A}",
    trustName: "Happy Dayz Accomodation",
    set: { name: "Happy Dayz Accommodation" },
    remove: ["phone"],
    note: "A note.",
    reason: "Spelling.",
  });

  assert.equal(fields.name, "Happy Dayz Accommodation");
  assert.equal("phone" in fields, false);
  // The trust's record is not modified in place.
  assert.equal(trust.name, "Happy Dayz Accomodation");
  assert.deepEqual(applied.replaced, { name: "Happy Dayz Accomodation" });
  // A removed field is named, never echoed: it was removed so as not to be
  // published.
  assert.deepEqual(applied.removed, ["phone"]);
  assert.equal(JSON.stringify(applied).includes("example.com"), false);
  assert.equal(applied.note, "A note.");
});

test("a site correction moves a value filed under the wrong field", () => {
  const trust = { name: "Makene Road Campsite", phone: "someone@example.com" };
  const { fields, applied } = applySiteCorrection(trust, {
    globalId: "{A}",
    trustName: "Makene Road Campsite",
    move: { phone: "email" },
    reason: "An email address in the phone field.",
  });
  assert.equal(fields.email, "someone@example.com");
  assert.equal("phone" in fields, false);
  assert.deepEqual(applied.moved, { phone: "email" });
  assert.equal(
    describePrivateSite(fields),
    "Email: someone@example.com"
  );
  assert.throws(
    () =>
      applySiteCorrection(
        { ...trust, email: "x@example.com" },
        { globalId: "{A}", trustName: "Makene Road Campsite", move: { phone: "email" }, reason: "" }
      ),
    /already has email/
  );
});

test("a site correction can override the derived waypoint type", () => {
  const trust = { name: "Camp Stream Hut", globalid: "{A}" };
  const correction = {
    globalId: "{A}",
    trustName: "Camp Stream Hut",
    type: "hut",
    reason: "A six-bunk hut.",
  };
  const { applied } = applySiteCorrection(trust, correction, "", privateSiteType);
  assert.deepEqual(applied.retyped, { from: "campsite", to: "hut" });

  // A retype to what the mapping already gives is stale, not harmless.
  assert.throws(
    () =>
      applySiteCorrection(
        { ...trust, tags: "free hut" },
        correction,
        "",
        privateSiteType
      ),
    /already maps to/
  );
  // And it cannot be checked without the mapping it overrides.
  assert.throws(() => applySiteCorrection(trust, correction), /no type mapping/);
  // A correction with no type leaves the type alone.
  assert.equal(
    applySiteCorrection(trust, { ...correction, type: undefined }).applied.retyped,
    undefined
  );
});

test("a site correction refuses a record that is not the one it was written for", () => {
  const correction = {
    globalId: "{A}",
    trustName: "Top Timaru Hut",
    set: { "Name of site": "Top Tīmaru Hut" },
    reason: "Gazetteer.",
  };
  assert.throws(
    () => applySiteCorrection({ "Name of site": "Something Else Hut" }, correction),
    /now publishes "Something Else Hut"/
  );
  assert.throws(
    () =>
      applySiteCorrection(
        { "Name of site": "Top Timaru Hut" },
        { ...correction, set: undefined, remove: ["phone"] }
      ),
    /no longer has/
  );
});

test("site ids are read from either folder's spelling of GlobalID", () => {
  assert.equal(siteGlobalId({ GlobalID: "{DOC}" }), "{DOC}");
  assert.equal(siteGlobalId({ globalid: "{PRIVATE}" }), "{PRIVATE}");
  assert.equal(siteGlobalId({}), "");
});

test("route names are corrected by exact match only", () => {
  const names = { "Arthur's Pass to Rākaia River": "Arthur's Pass to Rakaia River" };
  assert.equal(
    correctRouteName("Arthur's Pass to Rākaia River", names),
    "Arthur's Pass to Rakaia River"
  );
  assert.equal(correctRouteName("Rākaia River", names), "Rākaia River");
  // Inherited properties are not corrections.
  assert.equal(correctRouteName("toString", names), "toString");
});
