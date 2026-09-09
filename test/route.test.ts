/**
 * The route assembly maths, on geometry small enough to check by hand.
 *
 * Everything here is what the trail data depends on being right: if a segment
 * is oriented the wrong way, or a vertex's km is interpolated wrongly, every
 * distance in every published file is wrong and nothing downstream notices.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assembleRoute,
  elevationStats,
  geometricLengthKm,
  haversineMeters,
  orientSegments,
  projectOntoRoute,
  walkedStretches,
  type ChainedSegment,
  type Coord,
} from "../src/route.ts";

const at = (lat: number, lon: number, ele = 0): Coord => ({ lat, lon, ele });

function segment(
  name: string,
  fromKm: number,
  toKm: number,
  coordinates: Coord[]
): ChainedSegment {
  return {
    name,
    section: "Test Section",
    fromKm,
    toKm,
    status: "Open",
    island: "North",
    coordinates,
  };
}

/** Roughly one degree of latitude, the standard sanity figure. */
const DEGREE_METERS = 111195;

test("haversineMeters measures a degree of latitude", () => {
  assert.equal(haversineMeters(at(0, 0), at(0, 0)), 0);
  const oneDegree = haversineMeters(at(0, 0), at(1, 0));
  assert.ok(
    Math.abs(oneDegree - DEGREE_METERS) < 100,
    `expected ~${DEGREE_METERS} m, got ${oneDegree}`
  );
  // Symmetric, and shrinking with latitude in longitude.
  assert.equal(
    haversineMeters(at(-41, 174), at(-42, 175)),
    haversineMeters(at(-42, 175), at(-41, 174))
  );
  assert.ok(
    haversineMeters(at(-46, 168), at(-46, 169)) <
      haversineMeters(at(-34, 173), at(-34, 174))
  );
});

test("orientSegments leaves a chain that already runs head-to-tail alone", () => {
  const flags = orientSegments([
    segment("a", 0, 1, [at(0, 0), at(0.01, 0)]),
    segment("b", 1, 2, [at(0.01, 0), at(0.02, 0)]),
    segment("c", 2, 3, [at(0.02, 0), at(0.03, 0)]),
  ]);
  assert.deepEqual(flags, [false, false, false]);
});

test("orientSegments flips a segment the trust published backwards", () => {
  const flags = orientSegments([
    segment("a", 0, 1, [at(0, 0), at(0.01, 0)]),
    // Drawn tail-first: its last vertex is the one that meets a.
    segment("b", 1, 2, [at(0.02, 0), at(0.01, 0)]),
    segment("c", 2, 3, [at(0.02, 0), at(0.03, 0)]),
  ]);
  assert.deepEqual(flags, [false, true, false]);
});

test("orientSegments beats the greedy choice that invented an 11.9 km gap", () => {
  // Greedy holds the first segment as published and flips only later ones. Here
  // that is wrong: the cheap chain needs the *first* segment reversed, which a
  // pass that only ever looks backwards can never choose.
  const segments = [
    segment("first", 0, 1, [at(0, 0), at(0.01, 0)]),
    segment("second", 1, 2, [at(0.00001, 0), at(-0.01, 0)]),
  ];
  assert.deepEqual(orientSegments(segments), [true, false]);

  assert.deepEqual(orientSegments([]), []);
  assert.deepEqual(orientSegments([segments[0]]), [false]);
});

test("assembleRoute hangs official chainage off the geometry", () => {
  // Three evenly spaced vertices over a segment the trust chains 0 -> 2 km.
  const route = assembleRoute([
    segment("a", 0, 2, [at(0, 0), at(0.005, 0), at(0.01, 0)]),
    segment("b", 2, 6, [at(0.01, 0), at(0.02, 0)]),
  ]);

  // The joint vertex is shared, not repeated.
  assert.equal(route.points.length, 4);
  assert.deepEqual(
    route.points.map((p) => Number(p.km.toFixed(6))),
    [0, 1, 2, 6]
  );
  // km never goes backwards, which is what indexAtKm's binary search assumes.
  for (let i = 1; i < route.points.length; i++) {
    assert.ok(route.points[i].km >= route.points[i - 1].km);
  }
  assert.equal(route.breaks.length, 0);

  // Segments come back with the slice of the point list they occupy.
  assert.deepEqual(
    route.segments.map((s) => [s.name, s.startIndex, s.endIndex, s.reversed]),
    [
      ["a", 0, 2, false],
      ["b", 3, 3, false],
    ]
  );
});

test("assembleRoute reports a physical gap instead of closing it", () => {
  const route = assembleRoute([
    segment("before the ferry", 0, 1, [at(0, 0), at(0.01, 0)]),
    // Starts ~1.1 km north of where the previous segment ended.
    segment("after the ferry", 1, 2, [at(0.02, 0), at(0.03, 0)]),
  ]);

  assert.equal(route.breaks.length, 1);
  const [gap] = route.breaks;
  assert.equal(gap.fromSegment, "before the ferry");
  assert.equal(gap.toSegment, "after the ferry");
  assert.equal(gap.km, 1);
  // The break points at the last vertex before it, so the writer can split there.
  assert.equal(gap.index, 1);
  assert.ok(Math.abs(gap.distanceMeters - DEGREE_METERS * 0.01) < 20);
  // Nothing is dropped or bridged: both segments' vertices are still present.
  assert.equal(route.points.length, 4);

  // A gap under the threshold is just a joint.
  const tight = assembleRoute(
    [
      segment("a", 0, 1, [at(0, 0), at(0.01, 0)]),
      segment("b", 1, 2, [at(0.0101, 0), at(0.02, 0)]),
    ],
    200
  );
  assert.equal(tight.breaks.length, 0);
});

test("assembleRoute chains a reversed segment without a gap", () => {
  const route = assembleRoute([
    segment("a", 0, 1, [at(0, 0), at(0.01, 0)]),
    segment("b", 1, 2, [at(0.02, 0), at(0.01, 0)]),
  ]);
  assert.equal(route.breaks.length, 0);
  assert.equal(route.segments[1].reversed, true);
  assert.deepEqual(
    route.points.map((p) => Number(p.km.toFixed(6))),
    [0, 1, 2]
  );
});

test("geometricLengthKm and elevationStats total a point list", () => {
  assert.ok(
    Math.abs(geometricLengthKm([at(0, 0), at(1, 0)]) - DEGREE_METERS / 1000) <
      0.1
  );
  assert.equal(geometricLengthKm([at(0, 0)]), 0);

  assert.deepEqual(
    elevationStats([at(0, 0, 100), at(0, 0.001, 250), at(0, 0.002, 50)]),
    { ascent: 150, descent: 200 }
  );
  assert.deepEqual(elevationStats([]), { ascent: 0, descent: 0 });
});

test("projectOntoRoute refines past the nearest vertex", () => {
  // Vertices ~1.1 km apart, so snapping to the nearest one would quantise km
  // badly. The query sits beside the middle of the first edge, ~11 m off.
  const route = assembleRoute([
    segment("a", 0, 2, [at(0, 0), at(0.01, 0), at(0.02, 0)]),
  ]);

  const projection = projectOntoRoute({ lat: 0.005, lon: 0.0001 }, route.points);

  assert.ok(
    Math.abs(projection.km - 0.5) < 0.01,
    `expected km ~0.5, got ${projection.km}`
  );
  assert.ok(
    Math.abs(projection.offTrailMeters - DEGREE_METERS * 0.0001) < 2,
    `expected ~11 m off trail, got ${projection.offTrailMeters}`
  );

  // A point sitting on a vertex projects to that vertex's own chainage.
  const onRoute = projectOntoRoute({ lat: 0.01, lon: 0 }, route.points);
  assert.ok(Math.abs(onRoute.km - 1) < 1e-6);
  assert.ok(onRoute.offTrailMeters < 1e-6);
});

test("walkedStretches cuts the route at every break and nowhere else", () => {
  // Two pieces of trail with a kilometre of water between them. The chainage is
  // continuous across it - the trust numbers its trail that way - so nothing
  // but the geometry says the walking stopped.
  const route = assembleRoute([
    segment("north shore", 0, 1, [at(0, 0), at(0.005, 0), at(0.01, 0)]),
    segment("south shore", 1, 2, [at(0.02, 0), at(0.03, 0)]),
  ]);
  assert.equal(route.breaks.length, 1);

  const stretches = walkedStretches(route);
  assert.equal(stretches.length, 2);
  assert.deepEqual(
    stretches.map((s) => s.length),
    [3, 2]
  );
  // Every vertex ends up in exactly one stretch, in order, and none is invented.
  assert.deepEqual(stretches.flat(), route.points);

  // Which is the whole point: measured this way, the water is not walked.
  const walked = stretches.reduce((sum, s) => sum + geometricLengthKm(s), 0);
  assert.ok(
    walked < geometricLengthKm(route.points) - 1,
    "the straight line across the break is still being counted"
  );
});

test("a route with no break comes back as one stretch", () => {
  const route = assembleRoute([
    segment("a", 0, 1, [at(0, 0), at(0.01, 0)]),
    segment("b", 1, 2, [at(0.01, 0), at(0.02, 0)]),
  ]);
  assert.equal(route.breaks.length, 0);
  assert.deepEqual(walkedStretches(route), [route.points]);
});
