import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { Geometry as WkxGeometry } from "wkx";
import { createRequire } from "node:module";
import { guardGeometryFile, readGeometryFile } from "../src/core/files.js";

const require = createRequire(import.meta.url);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "groundtruth-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Hand-build a minimal single-record .shp polygon file (see ESRI shapefile spec). */
function buildShp(points: [number, number][]): Buffer {
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
  header.writeUInt8(0x01, 3); // little-endian, no envelope
  header.writeInt32LE(srid, 4);
  return header;
}

async function buildGeoPackage(rows: { geojson: unknown; properties?: Record<string, unknown> }[]): Promise<Buffer> {
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database();
  db.run(`CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT)`);
  db.run(`CREATE TABLE features (id INTEGER, geom BLOB, name TEXT)`);
  db.run(`INSERT INTO gpkg_geometry_columns VALUES ('features','geom')`);
  rows.forEach((row, i) => {
    const wkb = WkxGeometry.parseGeoJSON(row.geojson as object).toWkb();
    const blob = Buffer.concat([gpbHeader(), wkb]);
    db.run("INSERT INTO features VALUES (?, ?, ?)", [i, blob, (row.properties?.name as string) ?? null]);
  });
  const data = Buffer.from(db.export());
  db.close();
  return data;
}

describe("readGeometryFile", () => {
  it("reads a Shapefile", async () => {
    const path = join(dir, "parcel.shp");
    writeFileSync(path, buildShp([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]));
    const result = await readGeometryFile(path);
    expect(result.format).toBe("shapefile");
    expect(result.features).toHaveLength(1);
    expect(result.features[0].geojson).toEqual({
      type: "Polygon",
      coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
    });
  });

  it("reads a GeoPackage with multiple features", async () => {
    const path = join(dir, "parcels.gpkg");
    writeFileSync(path, await buildGeoPackage([
      { geojson: { type: "Point", coordinates: [1, 2] }, properties: { name: "a" } },
      { geojson: { type: "Point", coordinates: [3, 4] }, properties: { name: "b" } },
    ]));
    const result = await readGeometryFile(path);
    expect(result.format).toBe("geopackage");
    expect(result.features).toHaveLength(2);
    expect(result.features.map((f) => f.geojson)).toEqual([
      { type: "Point", coordinates: [1, 2] },
      { type: "Point", coordinates: [3, 4] },
    ]);
    expect(result.features[0].properties?.name).toBe("a");
  });

  it("reads a KML file with multiple Placemarks", async () => {
    const path = join(dir, "parcels.kml");
    writeFileSync(
      path,
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
        <Placemark><name>Good</name><Point><coordinates>1,2</coordinates></Point></Placemark>
        <Placemark><name>Bad</name><Point><coordinates>999,999</coordinates></Point></Placemark>
      </Document></kml>`,
    );
    const result = await readGeometryFile(path);
    expect(result.format).toBe("kml");
    expect(result.features).toHaveLength(2);
    expect(result.features[0].properties?.name).toBe("Good");
  });

  it("reads a GML file with a bare geometry", async () => {
    const path = join(dir, "shape.gml");
    writeFileSync(
      path,
      `<gml:Polygon xmlns:gml="http://www.opengis.net/gml"><gml:exterior><gml:LinearRing><gml:posList>0 0 0 1 1 1 1 0 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>`,
    );
    const result = await readGeometryFile(path);
    expect(result.format).toBe("gml");
    expect(result.features).toHaveLength(1);
  });

  it("reads a GeoJSON FeatureCollection file", async () => {
    const path = join(dir, "parcels.geojson");
    writeFileSync(path, JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { id: 1 }, geometry: { type: "Point", coordinates: [1, 2] } },
      ],
    }));
    const result = await readGeometryFile(path);
    expect(result.format).toBe("geojson");
    expect(result.features).toHaveLength(1);
    expect(result.features[0].properties?.id).toBe(1);
  });

  it("reads a WKT text file as one feature", async () => {
    const path = join(dir, "shape.wkt");
    writeFileSync(path, "POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))");
    const result = await readGeometryFile(path);
    expect(result.format).toBe("wkt");
    expect(result.features).toHaveLength(1);
  });

  it("throws a clear error for a missing file", async () => {
    await expect(readGeometryFile(join(dir, "nope.shp"))).rejects.toThrow(/not found/i);
  });
});

describe("guardGeometryFile", () => {
  it("validates every feature and reports which ones fail", async () => {
    const path = join(dir, "mixed.kml");
    writeFileSync(
      path,
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
        <Placemark><name>Good</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 0,1 1,1 1,0 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
        <Placemark><name>Bowtie</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,1 1,0 0,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      </Document></kml>`,
    );
    const result = await guardGeometryFile(path, { type: "Polygon" });
    expect(result.totalFeatures).toBe(2);
    expect(result.invalidFeatures).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.featureIndex === 1 && i.code === "self_intersection")).toBe(true);
  });

  it("passes a fully valid Shapefile", async () => {
    const path = join(dir, "clean.shp");
    writeFileSync(path, buildShp([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]));
    const result = await guardGeometryFile(path, { type: "Polygon" });
    expect(result.ok).toBe(true);
    expect(result.invalidFeatures).toBe(0);
  });
});
