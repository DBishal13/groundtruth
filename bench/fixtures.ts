/**
 * A labeled corpus for the benchmark: one case per documented issue code
 * the guard can raise, plus a clean/valid case per supported wire format.
 * Every case's `expectIssueCode` is what run.ts checks for in the guard's
 * actual output — this is a detection-rate measurement against our own
 * documented failure modes, not a reproduction of any third-party
 * benchmark (e.g. GeoBenchX, which grades end-to-end LLM task success,
 * a different thing entirely).
 */
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { Geometry as WkxGeometry } from "wkx";
import type { FieldExpectation } from "../src/core/types.js";

const require = createRequire(import.meta.url);

export interface Case {
  label: string;
  /** The value that would appear as a tool-call argument. */
  args: Record<string, unknown>;
  expectations?: Record<string, FieldExpectation>;
  /** Issue code the guard is expected to raise for this argument, or null if it should be clean. */
  expectIssueCode: string | null;
}

export const INLINE_CASES: Case[] = [
  // --- one deliberately broken case per documented issue code ---
  { label: "swapped lat/lng (GeoJSON Point)", args: { geometry: { type: "Point", coordinates: [37.77, -122.42] } }, expectIssueCode: "lat_out_of_range" },
  { label: "longitude out of range", args: { geometry: { type: "Point", coordinates: [420, 10] } }, expectIssueCode: "lon_out_of_range" },
  { label: "self-intersecting bowtie polygon", args: { geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] } }, expectIssueCode: "self_intersection" },
  { label: "zero-area collinear polygon", args: { geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] } }, expectIssueCode: "zero_area" },
  { label: "antimeridian-spanning linestring", args: { geometry: { type: "LineString", coordinates: [[-179, 10], [179, 12]] } }, expectIssueCode: "possible_antimeridian" },
  { label: "clockwise exterior ring (wrong winding)", args: { geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] } }, expectIssueCode: "polygon_winding_order" },
  { label: "centroid passed where polygon expected", args: { geometry: { type: "Point", coordinates: [-122.42, 37.77] } }, expectations: { geometry: { type: ["Polygon", "MultiPolygon"] } }, expectIssueCode: "geometry_type_mismatch" },
  { label: "hallucinated CRS name", args: { geometry: { type: "Point", coordinates: [0, 0] }, from_crs: "OSGB 1936 Grid System" }, expectIssueCode: "unresolved_crs" },
  { label: "malformed WKT (unclosed paren)", args: { geometry: "POLYGON((0 0, 0 1, 1 1, 1 0)" }, expectIssueCode: "malformed_wkt" },
  // Note: unlike WKT/KML/GML, a bad hex string never produces a "malformed_wkb"
  // issue — WKB detection requires an actual successful parse to be confident
  // it's geometry at all (an unrelated hex id/hash is common), so a truncated
  // or garbage hex string is silently left alone rather than flagged. This
  // case is a specificity check: confirm that's actually what happens.
  { label: "truncated/ambiguous hex string (should be silently ignored, not flagged)", args: { geometry: "01010000007b14ae47e19a" }, expectIssueCode: null },
  { label: "malformed KML (no geometry)", args: { geometry: '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>Empty</name></Placemark></kml>' }, expectIssueCode: "malformed_kml" },
  { label: "non-geographic SRID (EWKT 3857)", args: { geometry: "SRID=3857;POINT(-13627732 4546985)" }, expectIssueCode: "non_geographic_srid" },
  { label: "unclosed polygon ring (structural)", args: { geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0]]] } }, expectIssueCode: "unclosed_ring" },
  { label: "invalid geometry type string", args: { geometry: { type: "Blob", coordinates: [] } }, expectIssueCode: "invalid_type" },

  // --- one clean, valid case per inline-able wire format ---
  { label: "clean GeoJSON polygon", args: { geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }, expectIssueCode: null },
  { label: "clean WKT polygon", args: { geometry: "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))" }, expectIssueCode: null },
  { label: "clean hex WKB point", args: { geometry: "01010000007b14ae47e19a5ec0c3f5285c8fe24240" }, expectIssueCode: null },
  { label: "clean inline KML point", args: { geometry: '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Point><coordinates>-122.42,37.77</coordinates></Point></Placemark></kml>' }, expectIssueCode: null },
  { label: "clean inline GML polygon", args: { geometry: '<gml:Polygon xmlns:gml="http://www.opengis.net/gml"><gml:exterior><gml:LinearRing><gml:posList>0 0 1 0 1 1 0 1 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>' }, expectIssueCode: null },
];

// --- file-based fixtures (Shapefile / GeoPackage), built in-memory ---

export function buildShp(points: [number, number][]): Buffer {
  const numPoints = points.length;
  const contentBytes = 4 + 32 + 4 + 4 + 4 + numPoints * 16;
  const recordBytes = 8 + contentBytes;
  const totalBytes = 100 + recordBytes;
  const buf = Buffer.alloc(totalBytes);
  buf.writeInt32BE(9994, 0);
  buf.writeInt32BE(Math.floor(totalBytes / 2), 24);
  buf.writeInt32LE(1000, 28);
  buf.writeInt32LE(5, 32);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  buf.writeDoubleLE(Math.min(...xs), 36);
  buf.writeDoubleLE(Math.min(...ys), 44);
  buf.writeDoubleLE(Math.max(...xs), 52);
  buf.writeDoubleLE(Math.max(...ys), 60);
  let off = 100;
  buf.writeInt32BE(1, off); off += 4;
  buf.writeInt32BE(Math.floor(contentBytes / 2), off); off += 4;
  buf.writeInt32LE(5, off); off += 4;
  buf.writeDoubleLE(Math.min(...xs), off); off += 8;
  buf.writeDoubleLE(Math.min(...ys), off); off += 8;
  buf.writeDoubleLE(Math.max(...xs), off); off += 8;
  buf.writeDoubleLE(Math.max(...ys), off); off += 8;
  buf.writeInt32LE(1, off); off += 4;
  buf.writeInt32LE(numPoints, off); off += 4;
  buf.writeInt32LE(0, off); off += 4;
  for (const [x, y] of points) {
    buf.writeDoubleLE(x, off); off += 8;
    buf.writeDoubleLE(y, off); off += 8;
  }
  return buf;
}

function gpbHeader(srid = 4326): Buffer {
  const header = Buffer.alloc(8);
  header.write("GP", 0, "ascii");
  header.writeUInt8(0, 2);
  header.writeUInt8(0x01, 3);
  header.writeInt32LE(srid, 4);
  return header;
}

export async function buildGeoPackage(rows: { geojson: object }[]): Promise<Buffer> {
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database();
  db.run(`CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT)`);
  db.run(`CREATE TABLE features (id INTEGER, geom BLOB)`);
  db.run(`INSERT INTO gpkg_geometry_columns VALUES ('features','geom')`);
  rows.forEach((row, i) => {
    const wkb = WkxGeometry.parseGeoJSON(row.geojson).toWkb();
    db.run("INSERT INTO features VALUES (?, ?)", [i, Buffer.concat([gpbHeader(), wkb])]);
  });
  const data = Buffer.from(db.export());
  db.close();
  return data;
}
