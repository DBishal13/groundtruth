#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { guardToolCall } from "../core/guard.js";
import { guardGeometryFile } from "../core/files.js";
import { bufferGeometry, intersectGeometries, reprojectGeometry } from "../tools/geo-tools.js";
import type { Geometry } from "geojson";
import type { FieldExpectation, Issue } from "../core/types.js";

const GeometrySchema = z
  .union([z.record(z.any()), z.string()])
  .describe("A geometry as GeoJSON, WKT/EWKT, hex-encoded WKB/EWKB, or an inline KML/GML XML fragment");

function issuesToText(issues: Issue[]): string {
  return issues
    .map((i) => `[${i.severity.toUpperCase()}] ${i.code}: ${i.message}\n  fix: ${i.fix}`)
    .join("\n");
}

interface GuardOutcome {
  ok: true;
  args: Record<string, unknown>;
}
interface GuardFailure {
  ok: false;
  response: { content: { type: "text"; text: string }[]; isError: true };
}

/**
 * Runs the guard and, on success, returns args with every geometry field
 * normalized to GeoJSON — so a tool downstream never has to know whether
 * the caller sent GeoJSON, WKT, or WKB.
 */
function guardOrFail(
  args: Record<string, unknown>,
  expectations?: Record<string, FieldExpectation>,
): GuardOutcome | GuardFailure {
  const result = guardToolCall(args, expectations);
  if (!result.ok) {
    return {
      ok: false,
      response: {
        content: [
          {
            type: "text",
            text: `Rejected before execution — the geometry/CRS failed validation:\n\n${issuesToText(result.issues)}`,
          },
        ],
        isError: true,
      },
    };
  }
  return { ok: true, args: result.normalized ?? args };
}

const server = new McpServer({
  name: "groundtruth",
  version: "0.1.0",
});

const GEOJSON_TYPE_ENUM = [
  "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection",
] as const;

server.tool(
  "validate_geometry",
  "Validate a geometry — GeoJSON, WKT/EWKT, or hex-encoded WKB/EWKB, format auto-detected — for structural correctness and topology sanity (self-intersections, degenerate/zero-area rings, swapped lat/lng axes, antimeridian issues) before using it in any other tool. Optionally assert the geometry type you expect (e.g. Polygon) to catch a centroid passed where an area was needed.",
  {
    geometry: GeometrySchema,
    expected_type: z.enum(GEOJSON_TYPE_ENUM).optional().describe("The geometry type this should be, if known"),
  },
  async ({ geometry, expected_type }) => {
    const expectations = expected_type ? { geometry: { type: expected_type } } : undefined;
    const result = guardToolCall({ geometry }, expectations);
    const summary = result.ok
      ? "Geometry is valid."
      : "Geometry has problems:";
    const text = result.issues.length > 0 ? `${summary}\n\n${issuesToText(result.issues)}` : summary;
    return { content: [{ type: "text", text }], isError: !result.ok };
  },
);

server.tool(
  "validate_geometry_file",
  "Validate every geometry in a geometry file — GeoJSON, WKT, KML, GML, Shapefile (.shp), or GeoPackage (.gpkg), format auto-detected from the extension. Use this instead of validate_geometry whenever the geometry lives in a file rather than being passed inline, since Shapefile/GeoPackage can't be embedded in a tool call argument. Reports which of the file's features are valid and, for each invalid one, why.",
  {
    file_path: z.string().describe("Path to the geometry file to validate"),
    expected_type: z.enum(GEOJSON_TYPE_ENUM).optional().describe("The geometry type every feature in the file should be, if known"),
  },
  async ({ file_path, expected_type }) => {
    try {
      const result = await guardGeometryFile(file_path, expected_type ? { type: expected_type } : undefined);
      const header =
        result.totalFeatures === 1
          ? `1 feature (${result.format}): ${result.ok ? "valid" : "invalid"}`
          : `${result.totalFeatures - result.invalidFeatures}/${result.totalFeatures} features valid (${result.format})`;
      const body = result.issues
        .map((i) => `feature[${i.featureIndex}]: [${i.severity.toUpperCase()}] ${i.code}: ${i.message}\n  fix: ${i.fix}`)
        .join("\n");
      return {
        content: [{ type: "text", text: body ? `${header}\n\n${body}` : header }],
        isError: !result.ok,
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Could not read "${file_path}": ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "buffer_geometry",
  "Buffer a geometry (GeoJSON, WKT/EWKT, or hex WKB/EWKB) by a distance in kilometers. Geometry is validated before buffering.",
  { geometry: GeometrySchema, distance_km: z.number().describe("Buffer distance in kilometers") },
  async ({ geometry, distance_km }) => {
    const guarded = guardOrFail({ geometry });
    if (!guarded.ok) return guarded.response;
    const result = bufferGeometry(guarded.args.geometry as Geometry, distance_km);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "reproject_geometry",
  "Reproject a geometry (GeoJSON, WKT/EWKT, or hex WKB/EWKB) between coordinate reference systems. Accepts EPSG codes (e.g. \"EPSG:4326\") or common names (WGS84, Web Mercator, NAD83, British National Grid, \"UTM zone 33N\").",
  {
    geometry: GeometrySchema,
    from_crs: z.string().describe("Source CRS, e.g. \"EPSG:4326\" or \"WGS84\""),
    to_crs: z.string().describe("Target CRS, e.g. \"EPSG:3857\" or \"Web Mercator\""),
  },
  async ({ geometry, from_crs, to_crs }) => {
    const guarded = guardOrFail({ geometry, from_crs, to_crs });
    if (!guarded.ok) return guarded.response;
    try {
      const result = reprojectGeometry(guarded.args.geometry as Geometry, from_crs, to_crs);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Reprojection failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "intersect_geometries",
  "Compute the geometric intersection of two polygons (GeoJSON, WKT/EWKT, or hex WKB/EWKB). Both are validated before intersecting, including that they're actually polygons — not points or lines.",
  { geometry_a: GeometrySchema, geometry_b: GeometrySchema },
  async ({ geometry_a, geometry_b }) => {
    const expectations: Record<string, FieldExpectation> = {
      geometry_a: { type: ["Polygon", "MultiPolygon"] },
      geometry_b: { type: ["Polygon", "MultiPolygon"] },
    };
    const guarded = guardOrFail({ geometry_a, geometry_b }, expectations);
    if (!guarded.ok) return guarded.response;
    const result = intersectGeometries(guarded.args.geometry_a as Geometry, guarded.args.geometry_b as Geometry);
    return {
      content: [{ type: "text", text: result ? JSON.stringify(result) : "No intersection." }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("groundtruth MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting groundtruth MCP server:", err);
  process.exit(1);
});
