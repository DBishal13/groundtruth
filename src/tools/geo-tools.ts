import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Geometry, Polygon, MultiPolygon, Position } from "geojson";
import { reprojectPoint, resolveCRS } from "../core/crs.js";

/**
 * Demo geospatial tools an agent might call. Each assumes its geometry
 * arguments have already passed `guardToolCall` — they do the GIS work,
 * not the validation.
 */

export function bufferGeometry(geometry: Geometry, distanceKm: number): Feature {
  return turf.buffer(geometry as turf.AllGeoJSON, distanceKm, { units: "kilometers" }) as Feature;
}

function mapPositions(coords: unknown, fn: (p: Position) => Position): unknown {
  if (Array.isArray(coords) && coords.length > 0 && typeof coords[0] === "number") {
    return fn(coords as Position);
  }
  if (Array.isArray(coords)) return coords.map((c) => mapPositions(c, fn));
  return coords;
}

export interface ReprojectResult {
  geometry: Geometry;
  from: { input: string; epsg: number; name: string };
  to: { input: string; epsg: number; name: string };
}

export function reprojectGeometry(geometry: Geometry, fromCRS: string, toCRS: string): ReprojectResult {
  const from = resolveCRS(fromCRS);
  const to = resolveCRS(toCRS);
  if (!from) throw new Error(`Could not resolve source CRS "${fromCRS}".`);
  if (!to) throw new Error(`Could not resolve target CRS "${toCRS}".`);

  const coordinates = (geometry as { coordinates?: unknown }).coordinates;
  const reprojected: Geometry = {
    ...geometry,
    coordinates: mapPositions(coordinates, (p) => reprojectPoint([p[0], p[1]], from, to)),
  } as Geometry;

  return {
    geometry: reprojected,
    from: { input: fromCRS, epsg: from.epsg, name: from.name },
    to: { input: toCRS, epsg: to.epsg, name: to.name },
  };
}

export function intersectGeometries(a: Geometry, b: Geometry): Feature | null {
  const fc = turf.featureCollection([
    turf.feature(a as Polygon | MultiPolygon),
    turf.feature(b as Polygon | MultiPolygon),
  ]);
  return turf.intersect(fc as FeatureCollection<Polygon | MultiPolygon>);
}
