/**
 * Route assembly for a trail published as an unordered pile of GIS segments.
 *
 * The Te Araroa KMZ carries every trail segment with the trust's own chainage
 * (`Fromkm`/`Tokm`), which is the distance measure every other Te Araroa
 * resource quotes. That is far better than measuring the geometry ourselves, so
 * this module treats the chainage as authoritative and hangs the geometry off
 * it: segments are ordered by `Fromkm`, oriented to run head-to-tail, and every
 * vertex gets an official km interpolated within its segment.
 */

export interface Coord {
  lat: number;
  lon: number;
  ele: number;
}

/** One source segment: geometry plus the chainage it covers. */
export interface ChainedSegment {
  name: string;
  section: string;
  fromKm: number;
  toKm: number;
  status: string;
  island: string;
  coordinates: Coord[];
}

/** A route vertex, carrying the official chainage at that point. */
export interface RoutePoint extends Coord {
  /** Official trail km at this vertex. */
  km: number;
}

/** A place where consecutive segments do not physically meet. */
export interface RouteBreak {
  /** Index into `points` of the last vertex before the break. */
  index: number;
  km: number;
  distanceMeters: number;
  fromSegment: string;
  toSegment: string;
}

export interface AssembledRoute {
  points: RoutePoint[];
  breaks: RouteBreak[];
  /** Segments in final order, with the orientation actually used. */
  segments: Array<
    ChainedSegment & { reversed: boolean; startIndex: number; endIndex: number }
  >;
}

const EARTH_RADIUS_METERS = 6371000;

export function haversineMeters(a: Coord, b: Coord): number {
  const phi1 = (a.lat * Math.PI) / 180;
  const phi2 = (b.lat * Math.PI) / 180;
  const dPhi = phi2 - phi1;
  const dLambda = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Choose an orientation for every segment so the chain runs head-to-tail.
 *
 * A greedy pass ("flip whichever end is nearer the previous one") is wrong here:
 * one bad choice propagates, and on this data it invented an 11.9 km gap near
 * Cape Reinga. Because the segment *order* is already fixed by the chainage,
 * the only free variables are the 2 orientations per segment, so the optimal
 * assignment falls out of a two-state dynamic program in one pass.
 *
 * Returns one boolean per segment: true means "use the vertices reversed".
 */
export function orientSegments(segments: ChainedSegment[]): boolean[] {
  if (segments.length === 0) return [];

  // cost[o] = best total gap distance for a chain ending with segment i in orientation o.
  let cost: [number, number] = [0, 0];
  const backpointers: Array<[number, number]> = [];

  for (let i = 1; i < segments.length; i++) {
    const previous = segments[i - 1].coordinates;
    const current = segments[i].coordinates;
    // Under orientation o, a segment starts at ends[o] reversed-aware and ends at the other.
    const previousEnds: [Coord, Coord] = [
      previous[previous.length - 1],
      previous[0],
    ];
    const currentStarts: [Coord, Coord] = [
      current[0],
      current[current.length - 1],
    ];

    const next: [number, number] = [Infinity, Infinity];
    const back: [number, number] = [0, 0];
    for (const o of [0, 1] as const) {
      for (const p of [0, 1] as const) {
        const candidate =
          cost[p] + haversineMeters(previousEnds[p], currentStarts[o]);
        if (candidate < next[o]) {
          next[o] = candidate;
          back[o] = p;
        }
      }
    }
    cost = next;
    backpointers.push(back);
  }

  const orientations = new Array<number>(segments.length).fill(0);
  let orientation = cost[0] <= cost[1] ? 0 : 1;
  orientations[segments.length - 1] = orientation;
  for (let i = segments.length - 1; i > 0; i--) {
    orientation = backpointers[i - 1][orientation];
    orientations[i - 1] = orientation;
  }

  return orientations.map((o) => o === 1);
}

/**
 * Build one continuous point list from chainage-ordered segments.
 *
 * Each vertex's km is interpolated between the segment's `Fromkm` and `Tokm` in
 * proportion to how far along the segment geometry it sits, so km stays exactly
 * on the trust's chainage at every segment boundary and varies smoothly inside.
 *
 * `breakThresholdMeters` decides what counts as a physical gap. Real gaps on
 * this trail are transport links (a ferry, a shuttle) rather than data errors,
 * so they are reported rather than closed.
 */
export function assembleRoute(
  ordered: ChainedSegment[],
  breakThresholdMeters = 200
): AssembledRoute {
  const reversedFlags = orientSegments(ordered);
  const points: RoutePoint[] = [];
  const breaks: RouteBreak[] = [];
  const segments: AssembledRoute["segments"] = [];

  ordered.forEach((segment, index) => {
    const reversed = reversedFlags[index];
    const coords = reversed
      ? [...segment.coordinates].reverse()
      : segment.coordinates;

    // Distance along this segment's own geometry, used to spread the chainage.
    const cumulative: number[] = [0];
    for (let i = 1; i < coords.length; i++) {
      cumulative.push(
        cumulative[i - 1] + haversineMeters(coords[i - 1], coords[i])
      );
    }
    const total = cumulative[cumulative.length - 1];
    const span = segment.toKm - segment.fromKm;

    if (points.length > 0) {
      const gap = haversineMeters(points[points.length - 1], coords[0]);
      if (gap > breakThresholdMeters) {
        breaks.push({
          index: points.length - 1,
          km: segment.fromKm,
          distanceMeters: gap,
          fromSegment: ordered[index - 1].name,
          toSegment: segment.name,
        });
      }
    }

    const startIndex = points.length;
    coords.forEach((coord, i) => {
      // Skip a vertex that merely repeats the previous segment's last point.
      if (
        i === 0 &&
        points.length > 0 &&
        haversineMeters(points[points.length - 1], coord) < 1
      ) {
        return;
      }
      points.push({
        ...coord,
        km: segment.fromKm + (total > 0 ? (cumulative[i] / total) * span : 0),
      });
    });

    segments.push({
      ...segment,
      reversed,
      startIndex,
      endIndex: points.length - 1,
    });
  });

  return { points, breaks, segments };
}

/**
 * Split an assembled route into the stretches you can actually walk.
 *
 * The edge across a break is not a piece of trail. It is a ferry, a river
 * crossing or a link nobody has mapped, and it exists in `points` only because
 * a point list has to be continuous. Anything that measures walking - distance,
 * ascent, a drawn line, a datasheet leg - has to sum over these stretches
 * rather than over `points`, or it charges the walker for a straight line
 * across water.
 */
export function walkedStretches(route: AssembledRoute): RoutePoint[][] {
  const endsAStretch = new Set(route.breaks.map((b) => b.index));
  const stretches: RoutePoint[][] = [];
  let current: RoutePoint[] = [];

  route.points.forEach((point, index) => {
    current.push(point);
    if (endsAStretch.has(index)) {
      stretches.push(current);
      current = [];
    }
  });
  if (current.length > 0) stretches.push(current);

  return stretches;
}

export interface RouteProjection {
  /** Official trail km of the closest point on the route. */
  km: number;
  /** How far the queried position sits from the route, in metres. */
  offTrailMeters: number;
  /** Index of the nearest route vertex. */
  index: number;
}

/**
 * Find where a position sits along the route.
 *
 * Snapping to the nearest *vertex* would quantise km to the vertex spacing
 * (~85 m on this data), so the result is refined by projecting onto the two
 * edges either side of that vertex.
 */
export function projectOntoRoute(
  target: { lat: number; lon: number },
  points: RoutePoint[]
): RouteProjection {
  let bestIndex = 0;
  let bestDistance = Infinity;
  const probe: Coord = { lat: target.lat, lon: target.lon, ele: 0 };

  for (let i = 0; i < points.length; i++) {
    const distance = haversineMeters(probe, points[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  let best = {
    km: points[bestIndex].km,
    offTrailMeters: bestDistance,
    index: bestIndex,
  };

  for (const [a, b] of [
    [bestIndex - 1, bestIndex],
    [bestIndex, bestIndex + 1],
  ]) {
    if (a < 0 || b >= points.length) continue;
    const projected = projectOntoEdge(probe, points[a], points[b]);
    if (projected && projected.distance < best.offTrailMeters) {
      best = {
        km: projected.km,
        offTrailMeters: projected.distance,
        index: bestIndex,
      };
    }
  }

  return best;
}

/**
 * Project onto a single edge in a local flat-earth frame. Over an edge of tens
 * of metres the curvature error is far below the precision anyone plans with.
 */
function projectOntoEdge(
  probe: Coord,
  a: RoutePoint,
  b: RoutePoint
): { km: number; distance: number } | null {
  const metersPerDegLat = 111320;
  const metersPerDegLon = metersPerDegLat * Math.cos((a.lat * Math.PI) / 180);

  const ax = 0;
  const ay = 0;
  const bx = (b.lon - a.lon) * metersPerDegLon;
  const by = (b.lat - a.lat) * metersPerDegLat;
  const px = (probe.lon - a.lon) * metersPerDegLon;
  const py = (probe.lat - a.lat) * metersPerDegLat;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return null;

  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
  const cx = t * dx;
  const cy = t * dy;

  return {
    km: a.km + (b.km - a.km) * t,
    distance: Math.hypot(px - cx, py - cy),
  };
}

/** Total geometric length of a point list, in km. */
export function geometricLengthKm(points: Coord[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += haversineMeters(points[i - 1], points[i]);
  return total / 1000;
}

/** Elevation gain and loss over a point list, in metres. */
export function elevationStats(points: Coord[]): {
  ascent: number;
  descent: number;
} {
  let ascent = 0;
  let descent = 0;
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].ele - points[i - 1].ele;
    if (delta > 0) ascent += delta;
    else descent -= delta;
  }
  return { ascent, descent };
}
