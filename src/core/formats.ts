import { Geometry as WkxGeometry } from "wkx";
import { XMLParser } from "fast-xml-parser";
import type { Geometry } from "geojson";
import type { AnyGeoJSON } from "./geojson.js";
import type { GeometryFormat } from "./types.js";
import { extractGmlFeatures, extractKmlFeatures } from "./xml-geometry.js";

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function combineFeatures(geoms: Geometry[]): AnyGeoJSON | null {
  if (geoms.length === 0) return null;
  return geoms.length === 1 ? geoms[0] : { type: "GeometryCollection", geometries: geoms };
}

const GEOJSON_TYPES = new Set([
  "Point", "MultiPoint", "LineString", "MultiLineString",
  "Polygon", "MultiPolygon", "GeometryCollection", "Feature", "FeatureCollection",
]);

function looksLikeGeoJSON(value: unknown): value is AnyGeoJSON {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).type === "string" &&
    GEOJSON_TYPES.has((value as Record<string, unknown>).type as string)
  );
}

// Matches WKT and EWKT ("SRID=4326;POINT(...)"). A matched keyword means the
// caller meant this string to be a geometry, so a parse failure downstream
// is a real error, not something to silently ignore.
const WKT_RE = /^\s*(SRID=-?\d+;\s*)?(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i;

function looksLikeWKT(value: string): boolean {
  return WKT_RE.test(value);
}

const HEX_RE = /^[0-9a-fA-F]+$/;

// A hex string is only a *candidate* — plenty of unrelated fields (ids,
// hashes, colors) are also hex. We don't trust the shape alone; we require
// an actual successful WKB/EWKB parse below before treating it as geometry.
function looksLikeHex(value: string): boolean {
  return value.length >= 10 && value.length % 2 === 0 && HEX_RE.test(value);
}

function looksLikeKml(value: string): boolean {
  return /<kml[\s>]/i.test(value) || /<Placemark[\s>]/i.test(value);
}

const GML_TAG_RE = /<(?:\w+:)?(?:Point|LineString|Polygon|Multi(?:Point|LineString|Curve|Polygon|Surface|Geometry))[\s>]/;

function looksLikeGml(value: string): boolean {
  if (!GML_TAG_RE.test(value)) return false;
  // Confirm this is GML, not some other XML dialect that happens to use
  // the same element names: either a gml: namespace prefix, or an
  // explicit opengis.net/gml xmlns declaration.
  return /<gml:/i.test(value) || /xmlns(?::\w+)?=["']https?:\/\/www\.opengis\.net\/gml/i.test(value);
}

export interface ParsedGeometry {
  format: GeometryFormat;
  geojson: AnyGeoJSON;
  /** Present when the input was EWKT/EWKB and declared a non-default SRID. */
  srid?: number;
}

export interface MalformedGeometry {
  format: GeometryFormat;
  error: string;
}

export function isMalformed(result: ParsedGeometry | MalformedGeometry): result is MalformedGeometry {
  return "error" in result;
}

/**
 * Detect and parse a geometry-shaped tool-call argument regardless of which
 * wire format an LLM emitted it in, normalizing to GeoJSON for the
 * validation and GIS layers underneath (which only speak GeoJSON).
 *
 * Returns null when the value isn't geometry-shaped at all — the caller
 * should leave it alone rather than treat it as a rejected geometry.
 */
export function parseGeometryInput(value: unknown): ParsedGeometry | MalformedGeometry | null {
  if (looksLikeGeoJSON(value)) {
    return { format: "geojson", geojson: value };
  }

  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (looksLikeWKT(trimmed)) {
    try {
      // wkx's WKT parser only recognizes uppercase keywords; WKT is
      // case-insensitive by spec (and coordinates are numeric either way).
      const geom = WkxGeometry.parse(trimmed.toUpperCase());
      return { format: "wkt", geojson: geom.toGeoJSON() as AnyGeoJSON, srid: geom.srid || undefined };
    } catch (err) {
      return { format: "wkt", error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (looksLikeHex(trimmed)) {
    try {
      const geom = WkxGeometry.parse(Buffer.from(trimmed, "hex"));
      return { format: "wkb", geojson: geom.toGeoJSON() as AnyGeoJSON, srid: geom.srid || undefined };
    } catch {
      // Not actually WKB — most likely an unrelated hex string (id/hash).
      // Since the hex shape alone isn't a confident signal, stay silent.
      return null;
    }
  }

  if (looksLikeKml(trimmed)) {
    try {
      const geojson = combineFeatures(extractKmlFeatures(xmlParser.parse(trimmed)).map((f) => f.geojson as Geometry));
      if (!geojson) return { format: "kml", error: "No Point/LineString/Polygon geometry found in the KML." };
      return { format: "kml", geojson };
    } catch (err) {
      return { format: "kml", error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (looksLikeGml(trimmed)) {
    try {
      const geojson = combineFeatures(extractGmlFeatures(xmlParser.parse(trimmed)).map((f) => f.geojson as Geometry));
      if (!geojson) return { format: "gml", error: "No Point/LineString/Polygon geometry found in the GML." };
      return { format: "gml", geojson };
    } catch (err) {
      return { format: "gml", error: err instanceof Error ? err.message : String(err) };
    }
  }

  return null;
}
