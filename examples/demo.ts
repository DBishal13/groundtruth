/**
 * Run with `npm run demo`. Simulates a few LLM tool calls — some clean,
 * some with the exact mistakes GeoBenchX documented models making — and
 * shows what the guard catches before any GIS library touches them.
 */
import { guardToolCall } from "../src/core/guard.js";
import type { FieldExpectation } from "../src/core/types.js";

const calls: { label: string; args: Record<string, unknown>; expectations?: Record<string, FieldExpectation> }[] = [
  {
    label: "clean buffer call",
    args: {
      geometry: { type: "Point", coordinates: [-122.42, 37.77] },
      distance_km: 5,
    },
  },
  {
    label: "swapped lat/lng axes (a documented model failure mode)",
    args: {
      geometry: { type: "Point", coordinates: [37.77, -122.42] },
    },
  },
  {
    label: "self-intersecting polygon (bowtie ring)",
    args: {
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]],
      },
    },
  },
  {
    label: "reproject with a CRS name the model half-remembered",
    args: {
      geometry: { type: "Point", coordinates: [-0.1, 51.5] },
      from_crs: "WGS84",
      to_crs: "British National Grid",
    },
  },
  {
    label: "reproject with a hallucinated CRS name",
    args: {
      geometry: { type: "Point", coordinates: [-0.1, 51.5] },
      from_crs: "WGS84",
      to_crs: "OSGB 1936 Grid System",
    },
  },
  {
    label: "intersect call where one side is a centroid, not the polygon it summarizes",
    args: {
      geometry_a: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
      geometry_b: { type: "Point", coordinates: [0.5, 0.5] },
    },
    expectations: {
      geometry_a: { type: ["Polygon", "MultiPolygon"] },
      geometry_b: { type: ["Polygon", "MultiPolygon"] },
    },
  },
  {
    label: "same buffer call, but the model emitted WKT instead of GeoJSON",
    args: {
      geometry: "POINT(-122.42 37.77)",
      distance_km: 5,
    },
  },
  {
    label: "malformed WKT (unclosed parenthesis)",
    args: {
      geometry: "POLYGON((0 0, 0 1, 1 1, 1 0)",
    },
  },
  {
    label: "EWKT with a non-WGS84 SRID (projected coordinates, not degrees)",
    args: {
      geometry: "SRID=3857;POINT(-13627732 4546985)",
    },
  },
  {
    label: "inline KML fragment instead of GeoJSON",
    args: {
      geometry:
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Point><coordinates>-122.42,37.77</coordinates></Point></Placemark></kml>',
    },
  },
  {
    label: "self-intersecting polygon expressed as GML",
    args: {
      geometry:
        '<gml:Polygon xmlns:gml="http://www.opengis.net/gml"><gml:exterior><gml:LinearRing>' +
        "<gml:posList>0 0 1 1 1 0 0 1 0 0</gml:posList>" +
        "</gml:LinearRing></gml:exterior></gml:Polygon>",
    },
  },
];

// Shapefile and GeoPackage can't be embedded inline in a tool call the way
// WKT/KML/GML can (multi-file / binary formats) — validate those with
// `groundtruth validate parcels.shp` or `guardGeometryFile()` instead,
// which check every feature in the file, not just one argument.

for (const { label, args, expectations } of calls) {
  const result = guardToolCall(args, expectations);
  console.log(`\n=== ${label} ===`);
  console.log(result.ok ? "PASSED" : "REJECTED");
  for (const issue of result.issues) {
    console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
    console.log(`    fix: ${issue.fix}`);
  }
}
