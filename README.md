# Groundtruth

> Deterministic CRS resolution, GeoJSON validation, and topology sanity checks wrapped around every LLM tool call — the "LangGraph for GIS" nobody's shipped as an open, model-agnostic layer.

**Domain:** Agentic AI · **Tier:** 1 (build now) · **Composite score:** 3.4/5

## Why this matters
Real but closing. Esri is shipping AI Assistants into ArcGIS Online on a monthly cadence through 2026; Google Research's "Geospatial Reasoning" orchestrates Gemini across multiple Earth foundation models but remains a trusted-tester preview; CARTO ships production AI agents over customer warehouses. All three are building this inside their own walled platforms, not as a portable, model-agnostic validation layer. Independent benchmarks confirm the problem is unsolved: GeoBenchX found even the best model (Claude Sonnet 3.5) hit only 53% success on solvable multi-step geospatial tasks, routinely confusing centroids for polygons and using stale geographic facts.

## Market signal
No dedicated market figure exists. Broad AI-agent market estimates range so widely between research firms ($43B by 2030 to $295B by 2035) that none should be treated as reliable for this narrow slice.

## Feasibility & time-to-MVP
The validation primitives are solved, mature libraries (Shapely/GEOS, pyproj) — the work is wiring LLM tool-call outputs to them with graceful failure recovery across multi-stage GDAL/PDAL pipelines. A schema-and-CRS wrapper ships in weeks; a full multi-stage orchestrator with topology sanity and rollback is a 3–6 month build for a strong team, roughly matching where academic prototypes (GISclaw) already sit.

## Existing players to differentiate from
Esri ArcGIS AI Assistants, Google Geospatial Reasoning (preview), CARTO AI Agents (MCP-based), early open-source GDAL MCP servers. Felt raised $15M (Jul 2025) for a natural-language GIS builder, a vertical app rather than an infra layer.

## Core risk to de-risk first
Incumbents have every incentive to keep this feature captive to their own platform rather than license it out, and GIS's fragmented CRS/format conventions make a truly generic validator harder to keep general than it first appears. The window to establish an open standard before Esri/Google close the gap natively is real but narrowing.

## Scoring snapshot

| Dimension | Score |
|---|---|
| Whitespace | 3/5 |
| Market signal | 3/5 |
| Feasibility | 4/5 |
| Capital efficiency | 4/5 |
| Buyer readiness | 3/5 |

## Status
This is a thin working prototype, not a validated product yet. `VALIDATION.md` is still the decision gate for whether to invest further.

## Prototype: what's here

- `src/core/formats.ts` — detects and parses a single geometry-shaped input regardless of wire format: native GeoJSON, WKT/EWKT strings (`"POLYGON((...))"`, `"SRID=4326;POINT(...)"`), hex-encoded WKB/EWKB, or an inline KML/GML XML fragment. Everything normalizes to GeoJSON before it reaches validation or the GIS layer. WKT/KML/GML detection is confident (a matched keyword or tag means the caller meant this to be a geometry, so a parse failure is a reported `malformed_*` error); WKB detection is conservative (a hex-looking string is only treated as WKB if it actually parses as one, so an unrelated hex id or hash is left alone).
- `src/core/xml-geometry.ts` — shared KML/GML geometry extraction used by both the inline path above and the file-based path below. Scope is deliberately bounded to Point/LineString/Polygon and their Multi* variants (no curves, no surfaces with interpolation); GML axis order is read as (longitude, latitude), the de-facto convention for most real-world WFS/GML output — strict EPSG:4326 (latitude, longitude) axis order is a documented limitation, not silently guessed.
- `src/core/files.ts` — reads a geometry **file** of any supported format (GeoJSON, WKT text, KML, GML, Shapefile `.shp`, or GeoPackage `.gpkg`) and yields every feature it contains, since Shapefile/GeoPackage can't be embedded inline in a tool call the way WKT/KML can. GeoPackage support is hand-rolled on `sql.js` (pure WASM SQLite, no native build step): it reads `gpkg_geometry_columns` to find the geometry table(s), then strips the small GeoPackageBinary header and hands the remaining WKB to the same parser used for inline WKB. `guardGeometryFile(path, expectations?)` validates every feature the same way `guardToolCall` validates one, returning per-feature issues.
- `src/core/crs.ts` — resolves the CRS strings an LLM actually writes ("WGS84", "Web Mercator", "British National Grid", "UTM zone 33N", `EPSG:4326`) to canonical EPSG codes and proj4 defs. Fails closed on anything it can't confidently resolve, rather than guessing.
- `src/core/geojson.ts` — structural GeoJSON validation (unclosed rings, malformed positions, wrong nesting) plus topology sanity checks aimed at the documented LLM failure modes: swapped lat/lng axes, self-intersecting polygons, zero-area/degenerate rings, mishandled antimeridian crossings.
- `src/core/guard.ts` — `guardToolCall(args, expectations?)`, the library entry point: scans a tool call's arguments for geometry- and CRS-shaped fields in any inline-able format, validates them, and returns structured issues (with a `fix` string per issue) plus `normalized` args with every geometry converted to GeoJSON — so a wrapped tool never has to know whether the caller sent GeoJSON, WKT, WKB, or KML/GML. `expectations` lets a caller declare which geometry type an argument must be (e.g. `{ geometry: { type: "Polygon" } }`), catching the #1 GeoBenchX failure mode — a centroid passed where the actual boundary was needed — before it reaches the GIS code. Also flags EWKT/EWKB carrying a non-WGS84 SRID as a warning, since the geographic sanity checks assume degrees.
- `src/mcp/server.ts` — an MCP server exposing `validate_geometry`, `validate_geometry_file`, `buffer_geometry`, `reproject_geometry`, and `intersect_geometries`. The inline tools accept GeoJSON, WKT/EWKT, hex WKB/EWKB, or KML/GML as a `geometry` argument; `validate_geometry_file` takes a `file_path` instead, for formats that can't be embedded inline (Shapefile, GeoPackage) or whole documents (multi-feature KML/GML). Every tool is wrapped in the guard so bad input is rejected with an explanation before any GIS work runs.
- `src/cli.ts` — a standalone `groundtruth validate <file>` command for sanity-checking a geometry file outside of any agent loop. Format is auto-detected (by extension first, then content): `.geojson`/`.json`, `.wkt`, `.kml`, `.gml`/`.xml`, `.shp`, `.gpkg`. For a multi-feature file it reports how many of the file's features are valid and, for each invalid one, why.

### Run it

```bash
npm install
npm test                                   # unit tests for CRS resolution, structural validation, topology, and type checks
npm run demo                               # runs guardToolCall over a handful of clean and deliberately broken tool calls
npm run dev:mcp                            # starts the MCP server on stdio — point an MCP client (e.g. Claude Desktop/Code) at it
npm run cli -- validate parcel.geojson     # validate a file directly; add --type Polygon to assert the expected shape
npm run cli -- validate parcels.shp        # Shapefile, GeoPackage, KML, GML, WKT text all work the same way
```

### Use as a library

```ts
import { guardToolCall } from "groundtruth";

const result = guardToolCall({
  geometry: { type: "Point", coordinates: [37.77, -122.42] }, // lat/lng swapped
});
// result.ok === false
// result.issues[0].code === "lat_out_of_range"
// result.issues[0].fix === "GeoJSON positions are always [longitude, latitude]. ..."

// The same guard accepts WKT/EWKT and hex WKB/EWKB too, and normalizes
// whatever it receives to GeoJSON for the tool underneath:
const wktResult = guardToolCall({ geometry: "POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))" });
// wktResult.formats.geometry === "wkt"
// wktResult.normalized.geometry === { type: "Polygon", coordinates: [[[0,0],[0,1],[1,1],[1,0],[0,0]]] }

// Files (including formats that can't be embedded inline, like Shapefile
// and GeoPackage) go through guardGeometryFile instead — it validates
// every feature the file contains, not just one:
import { guardGeometryFile } from "groundtruth";

const fileResult = await guardGeometryFile("parcels.shp", { type: "Polygon" });
// fileResult.totalFeatures, fileResult.invalidFeatures
// fileResult.issues[i].featureIndex identifies which feature an issue belongs to

// Assert the geometry type a tool actually needs, e.g. before an intersect:
const intersectArgs = guardToolCall(
  { geometry_a, geometry_b },
  {
    geometry_a: { type: ["Polygon", "MultiPolygon"] },
    geometry_b: { type: ["Polygon", "MultiPolygon"] },
  },
);
// Rejects a centroid passed in place of the polygon it summarizes, with an
// explicit fix instruction instead of a downstream crash or silent no-op.
```
