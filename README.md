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

- `src/core/crs.ts` — resolves the CRS strings an LLM actually writes ("WGS84", "Web Mercator", "British National Grid", "UTM zone 33N", `EPSG:4326`) to canonical EPSG codes and proj4 defs. Fails closed on anything it can't confidently resolve, rather than guessing.
- `src/core/geojson.ts` — structural GeoJSON validation (unclosed rings, malformed positions, wrong nesting) plus topology sanity checks aimed at the documented LLM failure modes: swapped lat/lng axes, self-intersecting polygons, zero-area/degenerate rings, mishandled antimeridian crossings.
- `src/core/guard.ts` — `guardToolCall(args, expectations?)`, the library entry point: scans a tool call's arguments for geometry- and CRS-shaped fields, validates them, and returns structured issues (with a `fix` string per issue) suitable for feeding straight back to the calling model. `expectations` lets a caller declare which geometry type an argument must be (e.g. `{ geometry: { type: "Polygon" } }`), catching the #1 GeoBenchX failure mode — a centroid passed where the actual boundary was needed — before it reaches the GIS code.
- `src/mcp/server.ts` — an MCP server exposing `validate_geometry`, `buffer_geometry`, `reproject_geometry`, and `intersect_geometries`, each wrapped in `guardToolCall` (with type expectations where the operation demands them, like `intersect_geometries` requiring polygons on both sides) so bad input is rejected with an explanation before any GIS work runs.
- `src/cli.ts` — a standalone `groundtruth validate` command for sanity-checking a `.geojson` file outside of any agent loop — useful for a quick demo or a CI check.

### Run it

```bash
npm install
npm test                                   # unit tests for CRS resolution, structural validation, topology, and type checks
npm run demo                               # runs guardToolCall over a handful of clean and deliberately broken tool calls
npm run dev:mcp                            # starts the MCP server on stdio — point an MCP client (e.g. Claude Desktop/Code) at it
npm run cli -- validate parcel.geojson     # validate a file directly; add --type Polygon to assert the expected shape
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
