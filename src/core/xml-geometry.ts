import type { Geometry, LineString, Point, Polygon, Position } from "geojson";
import type { AnyGeoJSON } from "./geojson.js";

/**
 * Geometry extraction shared by KML and GML (both are XML, both nest
 * geometry inside a container structure — Placemark vs. a feature member).
 * Scope is deliberately bounded to the common case: Point/LineString/
 * Polygon and their Multi* variants. Curves, surfaces with interpolation,
 * and other GML 3.2 exotica are out of scope — this is a validation guard,
 * not a full OGC implementation.
 *
 * GML axis order: coordinates are read as (x, y) = (longitude, latitude),
 * the de-facto convention used by most real-world WFS/GML output (and the
 * only order KML supports). Strict EPSG:4326 axis order (latitude,
 * longitude first) is NOT detected or corrected — a known, documented
 * limitation rather than a silent guess.
 */

export function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (node && typeof node === "object" && "#text" in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)["#text"]);
  }
  return "";
}

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** KML-style "lon,lat[,alt] lon,lat[,alt] ..." coordinate string. */
function parseKmlCoordinates(text: string): Position[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tuple) => tuple.split(",").map(Number).slice(0, 2) as Position)
    .filter((p) => p.length === 2 && p.every(Number.isFinite));
}

/** GML posList: a flat whitespace-separated list of numbers, `dim` per tuple. */
function parseGmlPosList(text: string, dim = 2): Position[] {
  const nums = text.trim().split(/\s+/).filter(Boolean).map(Number);
  const positions: Position[] = [];
  for (let i = 0; i + dim <= nums.length; i += dim) {
    positions.push([nums[i], nums[i + 1]]);
  }
  return positions;
}

/** GML pos: a single "x y[ z]" tuple. */
function parseGmlPos(text: string): Position | null {
  const nums = text.trim().split(/\s+/).filter(Boolean).map(Number);
  if (nums.length < 2 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1])) return null;
  return [nums[0], nums[1]];
}

// ---------------------------------------------------------------- KML ----

const KML_GEOMETRY_TAGS = ["Point", "LineString", "Polygon", "MultiGeometry"] as const;

function extractKmlRing(linearRing: unknown): Position[] {
  const node = linearRing as Record<string, unknown> | undefined;
  return node ? parseKmlCoordinates(textOf(node.coordinates)) : [];
}

function extractKmlPolygon(polygon: Record<string, unknown>): Geometry {
  const outer = polygon.outerBoundaryIs as Record<string, unknown> | undefined;
  const exterior = extractKmlRing(outer?.LinearRing);
  const inners = asArray(polygon.innerBoundaryIs as unknown).map((ib) =>
    extractKmlRing((ib as Record<string, unknown>)?.LinearRing),
  );
  return { type: "Polygon", coordinates: [exterior, ...inners] };
}

function extractKmlGeometryNode(node: Record<string, unknown>, tag: string): Geometry | null {
  switch (tag) {
    case "Point": {
      const p = parseKmlCoordinates(textOf(node.coordinates))[0];
      return p ? { type: "Point", coordinates: p } : null;
    }
    case "LineString": {
      const coords = parseKmlCoordinates(textOf(node.coordinates));
      return coords.length > 0 ? { type: "LineString", coordinates: coords } : null;
    }
    case "Polygon":
      return extractKmlPolygon(node);
    case "MultiGeometry": {
      const geoms = extractAllKmlGeometries(node);
      if (geoms.length === 0) return null;
      return geoms.length === 1 ? geoms[0] : { type: "GeometryCollection", geometries: geoms };
    }
    default:
      return null;
  }
}

function extractAllKmlGeometries(container: Record<string, unknown>): Geometry[] {
  const found: Geometry[] = [];
  for (const tag of KML_GEOMETRY_TAGS) {
    if (!(tag in container)) continue;
    for (const node of asArray(container[tag])) {
      const g = extractKmlGeometryNode(node as Record<string, unknown>, tag);
      if (g) found.push(g);
    }
  }
  return found;
}

export interface XmlFeature {
  geojson: AnyGeoJSON;
  properties: Record<string, unknown>;
}

function kmlProperties(pm: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (typeof pm.name === "string") props.name = pm.name;
  if (typeof pm.description === "string") props.description = pm.description;
  return props;
}

function walkKmlContainer(node: unknown, out: XmlFeature[]): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const placemark of asArray(obj.Placemark)) {
    const pm = placemark as Record<string, unknown>;
    const geoms = extractAllKmlGeometries(pm);
    if (geoms.length === 1) out.push({ geojson: geoms[0], properties: kmlProperties(pm) });
    else if (geoms.length > 1) {
      out.push({ geojson: { type: "GeometryCollection", geometries: geoms }, properties: kmlProperties(pm) });
    }
  }
  for (const key of ["Document", "Folder"]) {
    for (const child of asArray(obj[key])) walkKmlContainer(child, out);
  }
}

/**
 * Extract every Placemark's geometry from a parsed KML document (or a bare
 * KML geometry fragment with no <kml>/<Placemark> wrapper).
 */
export function extractKmlFeatures(parsed: unknown): XmlFeature[] {
  const root = (parsed as Record<string, unknown>)?.kml ?? parsed;
  const out: XmlFeature[] = [];
  walkKmlContainer(root, out);
  if (out.length === 0) {
    // No <Placemark> found — maybe this is a bare geometry fragment.
    const bare = extractAllKmlGeometries(root as Record<string, unknown>);
    for (const g of bare) out.push({ geojson: g, properties: {} });
  }
  return out;
}

// ---------------------------------------------------------------- GML ----

const GML_GEOMETRY_TAGS = [
  "Point", "LineString", "Polygon",
  "MultiPoint", "MultiLineString", "MultiCurve", "MultiPolygon", "MultiSurface",
  "MultiGeometry",
] as const;

function extractGmlRing(ring: Record<string, unknown> | undefined): Position[] {
  if (!ring) return [];
  if (ring.posList !== undefined) return parseGmlPosList(textOf(ring.posList));
  if (ring.coordinates !== undefined) return parseKmlCoordinates(textOf(ring.coordinates));
  if (ring.pos !== undefined) {
    return asArray(ring.pos)
      .map((p) => parseGmlPos(textOf(p)))
      .filter((p): p is Position => p !== null);
  }
  return [];
}

function ringFromBoundary(boundary: unknown): Position[] {
  const b = boundary as Record<string, unknown> | undefined;
  if (!b) return [];
  const ring = (b.LinearRing ?? b) as Record<string, unknown>;
  return extractGmlRing(ring);
}

function extractGmlPolygon(node: Record<string, unknown>): Geometry {
  const exterior = ringFromBoundary(node.exterior ?? node.outerBoundaryIs);
  const interiors = asArray(node.interior ?? node.innerBoundaryIs).map((n) => ringFromBoundary(n));
  return { type: "Polygon", coordinates: [exterior, ...interiors] };
}

function memberGeometry(member: unknown, innerTag: string): Geometry | null {
  const inner = (member as Record<string, unknown>)?.[innerTag];
  return inner ? extractGmlGeometryNode(inner as Record<string, unknown>, innerTag) : null;
}

function extractGmlGeometryNode(node: Record<string, unknown>, tag: string): Geometry | null {
  switch (tag) {
    case "Point": {
      const p = node.pos !== undefined ? parseGmlPos(textOf(node.pos)) : parseKmlCoordinates(textOf(node.coordinates))[0];
      return p ? { type: "Point", coordinates: p } : null;
    }
    case "LineString": {
      const coords = node.posList !== undefined
        ? parseGmlPosList(textOf(node.posList))
        : parseKmlCoordinates(textOf(node.coordinates));
      return coords.length > 0 ? { type: "LineString", coordinates: coords } : null;
    }
    case "Polygon":
      return extractGmlPolygon(node);
    case "MultiPoint": {
      const pts = asArray(node.pointMember)
        .map((m) => memberGeometry(m, "Point"))
        .filter((g): g is Point => g !== null && g.type === "Point");
      return pts.length > 0 ? { type: "MultiPoint", coordinates: pts.map((p) => p.coordinates) } : null;
    }
    case "MultiLineString":
    case "MultiCurve": {
      const lines = asArray(node.lineStringMember ?? node.curveMember)
        .map((m) => memberGeometry(m, "LineString"))
        .filter((g): g is LineString => g !== null && g.type === "LineString");
      return lines.length > 0 ? { type: "MultiLineString", coordinates: lines.map((g) => g.coordinates) } : null;
    }
    case "MultiPolygon":
    case "MultiSurface": {
      const polys = asArray(node.polygonMember ?? node.surfaceMember)
        .map((m) => memberGeometry(m, "Polygon"))
        .filter((g): g is Polygon => g !== null && g.type === "Polygon");
      return polys.length > 0 ? { type: "MultiPolygon", coordinates: polys.map((g) => g.coordinates) } : null;
    }
    case "MultiGeometry": {
      const geoms: Geometry[] = [];
      for (const m of asArray(node.geometryMember)) {
        const mm = m as Record<string, unknown>;
        for (const t of GML_GEOMETRY_TAGS) {
          if (t in mm) {
            const g = extractGmlGeometryNode(mm[t] as Record<string, unknown>, t);
            if (g) geoms.push(g);
          }
        }
      }
      if (geoms.length === 0) return null;
      return geoms.length === 1 ? geoms[0] : { type: "GeometryCollection", geometries: geoms };
    }
    default:
      return null;
  }
}

/**
 * Recursively find every GML geometry element in a subtree, without
 * descending further once a geometry tag is matched (its children belong
 * to that geometry, not to a sibling one).
 */
function findGmlGeometries(node: unknown, out: Geometry[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) findGmlGeometries(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  let matchedHere = false;
  for (const tag of GML_GEOMETRY_TAGS) {
    if (tag in obj) {
      matchedHere = true;
      for (const geomNode of asArray(obj[tag])) {
        const g = extractGmlGeometryNode(geomNode as Record<string, unknown>, tag);
        if (g) out.push(g);
      }
    }
  }
  if (matchedHere) return;
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("@_") || key === "#text") continue;
    findGmlGeometries(value, out);
  }
}

function collectMembers(root: unknown, out: unknown[] = []): unknown[] {
  if (!root || typeof root !== "object") return out;
  if (Array.isArray(root)) {
    for (const item of root) collectMembers(item, out);
    return out;
  }
  const obj = root as Record<string, unknown>;
  let matched = false;
  for (const key of ["member", "featureMember", "featureMembers"]) {
    if (key in obj) {
      matched = true;
      out.push(...asArray(obj[key]));
    }
  }
  if (!matched) {
    for (const value of Object.values(obj)) collectMembers(value, out);
  }
  return out;
}

/**
 * Extract features from a parsed GML/WFS document. If feature-member
 * wrappers (<gml:featureMember>, <wfs:member>, ...) are present, one
 * feature is emitted per member (with whatever geometry is found inside
 * it — WFS output nests geometry under an arbitrary, schema-specific
 * property name we can't know in advance). Otherwise every geometry found
 * anywhere in the document is emitted as its own feature.
 */
export function extractGmlFeatures(parsed: unknown): XmlFeature[] {
  const members = collectMembers(parsed);
  if (members.length > 0) {
    const features: XmlFeature[] = [];
    for (const member of members) {
      const geoms: Geometry[] = [];
      findGmlGeometries(member, geoms);
      if (geoms.length === 1) features.push({ geojson: geoms[0], properties: {} });
      else if (geoms.length > 1) features.push({ geojson: { type: "GeometryCollection", geometries: geoms }, properties: {} });
    }
    return features;
  }
  const geoms: Geometry[] = [];
  findGmlGeometries(parsed, geoms);
  return geoms.map((g) => ({ geojson: g, properties: {} }));
}
