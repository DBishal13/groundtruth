import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon, Position } from "geojson";
import type { Issue } from "./types.js";

export type AnyGeoJSON = Geometry | Feature | FeatureCollection;

function issue(severity: Issue["severity"], code: string, message: string, fix: string): Issue {
  return { severity, code, message, fix };
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function flattenPositions(coords: unknown, out: Position[] = []): Position[] {
  if (!Array.isArray(coords)) return out;
  if (coords.length > 0 && typeof coords[0] === "number") {
    out.push(coords as Position);
    return out;
  }
  for (const c of coords) flattenPositions(c, out);
  return out;
}

/** Every ring in a Polygon/MultiPolygon, tagged with whether it's a hole (not the first ring of its polygon). */
function ringsOf(g: Polygon | MultiPolygon): { ring: Position[]; isHole: boolean }[] {
  const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  const rings: { ring: Position[]; isHole: boolean }[] = [];
  for (const poly of polygons) {
    poly.forEach((ring, i) => rings.push({ ring, isHole: i > 0 }));
  }
  return rings;
}

/**
 * Structural validation: is this actually well-formed GeoJSON, independent
 * of whether the shape is geographically sane. Catches the "LLM emitted
 * almost-GeoJSON" failure mode (unclosed rings, wrong nesting depth, NaNs).
 */
export function validateStructure(input: unknown): Issue[] {
  const issues: Issue[] = [];

  if (input === null || typeof input !== "object") {
    issues.push(
      issue("error", "not_an_object", "Input is not a GeoJSON object.", "Provide a GeoJSON Geometry, Feature, or FeatureCollection object."),
    );
    return issues;
  }

  const obj = input as Record<string, unknown>;
  const type = obj.type;
  const validTypes = [
    "Point", "MultiPoint", "LineString", "MultiLineString",
    "Polygon", "MultiPolygon", "GeometryCollection", "Feature", "FeatureCollection",
  ];

  if (typeof type !== "string" || !validTypes.includes(type)) {
    issues.push(
      issue("error", "invalid_type", `"type" is missing or unrecognized: ${JSON.stringify(type)}.`, `Set "type" to one of: ${validTypes.join(", ")}.`),
    );
    return issues;
  }

  if (type === "FeatureCollection") {
    const features = obj.features;
    if (!Array.isArray(features)) {
      issues.push(issue("error", "missing_features", "FeatureCollection has no \"features\" array.", "Add a \"features\" array, even if empty."));
    } else {
      features.forEach((f, i) => {
        for (const sub of validateStructure(f)) {
          issues.push({ ...sub, message: `feature[${i}]: ${sub.message}` });
        }
      });
    }
    return issues;
  }

  if (type === "Feature") {
    if (!("geometry" in obj)) {
      issues.push(issue("error", "missing_geometry", "Feature has no \"geometry\" key.", "Add a \"geometry\" key (or null for an unlocated feature)."));
    } else if (obj.geometry !== null) {
      issues.push(...validateStructure(obj.geometry));
    }
    return issues;
  }

  if (type === "GeometryCollection") {
    const geometries = obj.geometries;
    if (!Array.isArray(geometries)) {
      issues.push(issue("error", "missing_geometries", "GeometryCollection has no \"geometries\" array.", "Add a \"geometries\" array."));
    } else {
      geometries.forEach((g, i) => {
        for (const sub of validateStructure(g)) {
          issues.push({ ...sub, message: `geometries[${i}]: ${sub.message}` });
        }
      });
    }
    return issues;
  }

  const coords = obj.coordinates;
  if (!Array.isArray(coords)) {
    issues.push(issue("error", "missing_coordinates", `${type} has no "coordinates" array.`, "Add a \"coordinates\" array matching the geometry type."));
    return issues;
  }

  const positions = flattenPositions(coords);
  if (positions.length === 0) {
    issues.push(issue("error", "empty_coordinates", `${type} has an empty "coordinates" array.`, "Provide at least the minimum number of positions for this geometry type."));
  }
  for (const p of positions) {
    if (p.length < 2 || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) {
      issues.push(issue("error", "bad_position", `${type} contains a malformed position: ${JSON.stringify(p)}.`, "Every position must be [x, y] (or [x, y, z]) with finite numbers."));
      break;
    }
  }

  if (type === "Polygon" || type === "MultiPolygon") {
    const rings: Position[][] = type === "Polygon" ? (coords as Position[][]) : (coords as Position[][][]).flat();
    rings.forEach((ring, i) => {
      if (!Array.isArray(ring) || ring.length < 4) {
        issues.push(issue("error", "short_ring", `Ring ${i} has fewer than 4 positions (rings must close).`, "Every polygon ring needs at least 4 positions, with the first equal to the last."));
        return;
      }
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        issues.push(issue("error", "unclosed_ring", `Ring ${i} is not closed: first position ${JSON.stringify(first)} != last ${JSON.stringify(last)}.`, "Repeat the first position as the last position to close the ring."));
      }
    });
  }

  if (type === "LineString" && positions.length < 2) {
    issues.push(issue("error", "short_linestring", "LineString needs at least 2 positions.", "Provide 2 or more positions."));
  }

  return issues;
}

/**
 * Semantic sanity checks on geometry that IS well-formed GeoJSON but may
 * still be wrong in the ways LLMs are documented to get wrong: swapped
 * lat/lng axes, self-intersecting polygons, degenerate (zero-area) shapes,
 * mishandled antimeridian crossings.
 */
export function checkTopology(input: AnyGeoJSON): Issue[] {
  const issues: Issue[] = [];

  let positions: Position[] = [];
  const raw = input as { type?: string; features?: Feature[]; geometry?: Geometry; coordinates?: unknown };
  try {
    if (raw.type === "FeatureCollection") {
      for (const f of raw.features ?? []) {
        if (f.geometry) positions.push(...flattenPositions((f.geometry as { coordinates?: unknown }).coordinates));
      }
    } else if (raw.type === "Feature") {
      const geom = raw.geometry;
      if (geom) positions = flattenPositions((geom as { coordinates?: unknown }).coordinates);
    } else {
      positions = flattenPositions(raw.coordinates);
    }
  } catch {
    return issues;
  }

  const lonOutOfRange = positions.filter((p) => Math.abs(p[0]) > 180);
  const latOutOfRange = positions.filter((p) => Math.abs(p[1]) > 90);

  if (latOutOfRange.length > 0) {
    issues.push(
      issue(
        "error",
        "lat_out_of_range",
        `${latOutOfRange.length} position(s) have a latitude outside [-90, 90] (e.g. ${JSON.stringify(latOutOfRange[0])}). This usually means lat/lng axes are swapped, or coordinates aren't in degrees.`,
        "GeoJSON positions are always [longitude, latitude]. Swap axes if you built this from a [lat, lng] source, or confirm the source CRS is geographic (degrees), not projected.",
      ),
    );
  } else if (lonOutOfRange.length > 0) {
    issues.push(
      issue(
        "error",
        "lon_out_of_range",
        `${lonOutOfRange.length} position(s) have a longitude outside [-180, 180] (e.g. ${JSON.stringify(lonOutOfRange[0])}).`,
        "Confirm coordinates are in degrees and the source CRS is geographic. Projected coordinates (meters/feet) must be reprojected to EPSG:4326 first.",
      ),
    );
  }

  if (issues.length === 0 && positions.length > 0) {
    const lons = positions.map((p) => p[0]);
    const span = Math.max(...lons) - Math.min(...lons);
    if (span > 180) {
      issues.push(
        issue(
          "warning",
          "possible_antimeridian",
          `Longitude span across positions is ${span.toFixed(1)}°, which usually means the geometry crosses the antimeridian (±180°) and needs to be split, or two unrelated points were combined.`,
          "If this geometry is meant to cross the 180th meridian, split it into two parts on either side. Otherwise check for a data error.",
        ),
      );
    }
  }

  if (issues.some((i) => i.severity === "error")) return issues;

  const geomsToCheck: (Polygon | MultiPolygon)[] = [];
  const type = raw.type;
  if (type === "Polygon" || type === "MultiPolygon") geomsToCheck.push(input as Polygon | MultiPolygon);
  else if (type === "Feature" && raw.geometry) {
    const g = raw.geometry;
    if (g.type === "Polygon" || g.type === "MultiPolygon") geomsToCheck.push(g as Polygon | MultiPolygon);
  } else if (type === "FeatureCollection") {
    for (const f of raw.features ?? []) {
      if (f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")) {
        geomsToCheck.push(f.geometry as Polygon | MultiPolygon);
      }
    }
  }

  for (const g of geomsToCheck) {
    try {
      const kinks = turf.kinks(g);
      if (kinks.features.length > 0) {
        issues.push(
          issue(
            "error",
            "self_intersection",
            `Polygon is self-intersecting at ${kinks.features.length} point(s).`,
            "Simplify or rebuild the polygon so its rings don't cross themselves — a common cause is closing a ring with points out of order.",
          ),
        );
      }
      const area = turf.area(g as turf.AllGeoJSON);
      if (area === 0) {
        issues.push(
          issue(
            "error",
            "zero_area",
            "Polygon has zero area (degenerate — likely collinear or duplicate points).",
            "Check that the ring's positions actually enclose a region and aren't all on one line or the same point.",
          ),
        );
      }
      // Exterior rings should be counter-clockwise (booleanClockwise === false);
      // holes should be clockwise (=== true). Wrong whenever it's the opposite.
      const wrongWinding = ringsOf(g).filter(
        ({ ring, isHole }) => turf.booleanClockwise(ring) !== isHole,
      ).length;
      if (wrongWinding > 0) {
        issues.push(
          issue(
            "warning",
            "polygon_winding_order",
            `${wrongWinding} ring(s) don't follow the right-hand rule (exterior rings should be counter-clockwise, holes clockwise, per RFC 7946).`,
            "Reverse the affected ring's coordinate order. Most consumers (including this library's own checks) tolerate either winding, but some strict renderers or GIS engines assume the right-hand rule.",
          ),
        );
      }
    } catch (err) {
      issues.push(
        issue(
          "warning",
          "topology_check_failed",
          `Could not run topology checks: ${err instanceof Error ? err.message : String(err)}.`,
          "Verify the geometry is well-formed; topology checks were skipped for this shape.",
        ),
      );
    }
  }

  return issues;
}
