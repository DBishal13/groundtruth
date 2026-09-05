import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";
import * as shapefile from "shapefile";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { XMLParser } from "fast-xml-parser";
import type { AnyGeoJSON } from "./geojson.js";
import { extractGmlFeatures, extractKmlFeatures } from "./xml-geometry.js";
import { guardGeometry } from "./guard.js";
import type { FieldExpectation, Issue } from "./types.js";

const require = createRequire(import.meta.url);
const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

export type FileFormat = "geojson" | "wkt" | "kml" | "gml" | "shapefile" | "geopackage";

export interface FileFeatureRecord {
  index: number;
  /**
   * The geometry, in whatever shape this format produces: a parsed GeoJSON
   * object for GeoJSON/Shapefile/GeoPackage/KML/GML, or a raw WKT string
   * for a .wkt file — guardGeometry() detects and parses either.
   */
  geojson: unknown;
  properties?: Record<string, unknown>;
  /** Which table the feature came from (GeoPackage only, when there are several). */
  source?: string;
}

export interface FileParseResult {
  format: FileFormat;
  features: FileFeatureRecord[];
}

function detectFormatFromExtension(path: string): FileFormat | null {
  switch (extname(path).toLowerCase()) {
    case ".shp":
      return "shapefile";
    case ".gpkg":
      return "geopackage";
    case ".kml":
      return "kml";
    case ".gml":
    case ".xml":
      return "gml";
    case ".geojson":
    case ".json":
      return "geojson";
    case ".wkt":
      return "wkt";
    default:
      return null;
  }
}

/** Sniff a text file's format from its content when the extension is unrecognized or ambiguous. */
function detectFormatFromContent(text: string): FileFormat {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return "geojson";
  if (/<kml[\s>]/i.test(trimmed) || /<Placemark[\s>]/i.test(trimmed)) return "kml";
  if (trimmed.startsWith("<")) return "gml";
  return "wkt";
}

async function readShapefile(path: string): Promise<FileFeatureRecord[]> {
  const fc = await shapefile.read(path);
  return fc.features.map((f, index) => ({ index, geojson: f.geometry, properties: f.properties ?? undefined }));
}

interface GeometryColumn {
  table: string;
  column: string;
}

/**
 * GeoPackage stores geometries as "GeoPackageBinary": an 8+ byte header
 * (magic "GP", version, flags, SRS id, optional envelope) followed by a
 * standard WKB body. We only need the header to find where the WKB starts —
 * the WKB itself is parsed by the same wkx-based path used for inline WKB.
 */
function stripGeoPackageBinaryHeader(blob: Uint8Array): { wkb: Buffer; srid: number } | null {
  if (blob.length < 8 || blob[0] !== 0x47 || blob[1] !== 0x50) return null; // "GP" magic
  const flags = blob[3];
  const littleEndian = (flags & 0x01) === 1;
  const envelopeCode = (flags >> 1) & 0x07;
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const srid = littleEndian ? buf.readInt32LE(4) : buf.readInt32BE(4);
  const envelopeSizes = [0, 32, 48, 48, 64];
  const envelopeSize = envelopeSizes[envelopeCode] ?? 0;
  const wkbOffset = 8 + envelopeSize;
  if (wkbOffset > buf.length) return null;
  return { wkb: buf.subarray(wkbOffset), srid };
}

async function readGeoPackage(path: string): Promise<FileFeatureRecord[]> {
  const { Geometry: WkxGeometry } = await import("wkx");
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const fileBuffer = readFileSync(path);
  const db: SqlJsDatabase = new SQL.Database(fileBuffer);

  let geometryColumns: GeometryColumn[];
  try {
    const result = db.exec("SELECT table_name, column_name FROM gpkg_geometry_columns");
    geometryColumns = (result[0]?.values ?? []).map(([table, column]) => ({
      table: String(table),
      column: String(column),
    }));
  } catch (err) {
    db.close();
    throw new Error(`Not a valid GeoPackage (missing gpkg_geometry_columns): ${err instanceof Error ? err.message : String(err)}`);
  }

  const records: FileFeatureRecord[] = [];
  let index = 0;
  for (const { table, column } of geometryColumns) {
    const rows = db.exec(`SELECT * FROM "${table}"`);
    if (rows.length === 0) continue;
    const { columns, values } = rows[0];
    const geomIdx = columns.indexOf(column);
    for (const row of values) {
      const blob = row[geomIdx];
      if (!(blob instanceof Uint8Array)) continue;
      const stripped = stripGeoPackageBinaryHeader(blob);
      if (!stripped) continue;
      const properties: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        if (i !== geomIdx) properties[col] = row[i];
      });
      try {
        const geom = WkxGeometry.parse(stripped.wkb);
        records.push({
          index: index++,
          geojson: geom.toGeoJSON() as AnyGeoJSON,
          properties,
          source: geometryColumns.length > 1 ? table : undefined,
        });
      } catch {
        // Skip rows whose blob doesn't decode as valid WKB after the GPB header.
      }
    }
  }
  db.close();
  return records;
}

function readGeoJSONFile(text: string): FileFeatureRecord[] {
  const parsed: unknown = JSON.parse(text);
  const obj = parsed as { type?: string; features?: { geometry: AnyGeoJSON; properties?: Record<string, unknown> }[] };
  if (obj.type === "FeatureCollection") {
    return (obj.features ?? []).map((f, index) => ({ index, geojson: f.geometry, properties: f.properties }));
  }
  if (obj.type === "Feature") {
    const feature = parsed as { geometry: AnyGeoJSON; properties?: Record<string, unknown> };
    return [{ index: 0, geojson: feature.geometry, properties: feature.properties }];
  }
  return [{ index: 0, geojson: parsed as AnyGeoJSON }];
}

function readKmlOrGml(text: string, format: "kml" | "gml"): FileFeatureRecord[] {
  const parsed = xmlParser.parse(text);
  const features = format === "kml" ? extractKmlFeatures(parsed) : extractGmlFeatures(parsed);
  return features.map((f, index) => ({ index, geojson: f.geojson, properties: f.properties }));
}

/**
 * Read a geometry file of any supported format (GeoJSON, WKT text, KML,
 * GML, Shapefile, or GeoPackage), returning every feature it contains.
 * Format is detected from the extension first, falling back to content
 * sniffing for unrecognized text extensions.
 */
export async function readGeometryFile(path: string): Promise<FileParseResult> {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);

  const extFormat = detectFormatFromExtension(path);

  if (extFormat === "shapefile") {
    return { format: "shapefile", features: await readShapefile(path) };
  }
  if (extFormat === "geopackage") {
    return { format: "geopackage", features: await readGeoPackage(path) };
  }

  const text = readFileSync(path, "utf8");
  const format = extFormat ?? detectFormatFromContent(text);

  if (format === "geojson") return { format, features: readGeoJSONFile(text) };
  if (format === "kml" || format === "gml") return { format, features: readKmlOrGml(text, format) };
  // "wkt" fallback: the whole file is one WKT/EWKT geometry.
  return { format: "wkt", features: [{ index: 0, geojson: text.trim() }] };
}

export interface FileIssue extends Issue {
  featureIndex: number;
}

export interface FileGuardResult {
  ok: boolean;
  format: FileFormat;
  totalFeatures: number;
  invalidFeatures: number;
  issues: FileIssue[];
}

/**
 * Read a geometry file (any supported format) and validate every feature in
 * it the same way a single tool-call argument would be validated.
 */
export async function guardGeometryFile(path: string, expectation?: FieldExpectation): Promise<FileGuardResult> {
  const { format, features } = await readGeometryFile(path);
  const issues: FileIssue[] = [];
  let invalidFeatures = 0;

  for (const feature of features) {
    const result = guardGeometry(feature.geojson, expectation);
    if (!result.ok) invalidFeatures++;
    for (const issue of result.issues) {
      issues.push({ ...issue, featureIndex: feature.index });
    }
  }

  return {
    ok: invalidFeatures === 0,
    format,
    totalFeatures: features.length,
    invalidFeatures,
    issues,
  };
}
