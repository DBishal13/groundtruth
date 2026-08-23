#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { guardToolCall } from "../core/guard.js";
import { bufferGeometry, intersectGeometries, reprojectGeometry } from "../tools/geo-tools.js";
import type { Geometry } from "geojson";
import type { FieldExpectation, Issue } from "../core/types.js";

const GeometrySchema = z.record(z.any()).describe("A GeoJSON Geometry object");

function issuesToText(issues: Issue[]): string {
  return issues
    .map((i) => `[${i.severity.toUpperCase()}] ${i.code}: ${i.message}\n  fix: ${i.fix}`)
    .join("\n");
}

function guardOrFail(args: Record<string, unknown>, expectations?: Record<string, FieldExpectation>) {
  const result = guardToolCall(args, expectations);
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Rejected before execution — the geometry/CRS failed validation:\n\n${issuesToText(result.issues)}`,
        },
      ],
      isError: true,
    };
  }
  return null;
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
  "Validate a GeoJSON geometry for structural correctness and topology sanity (self-intersections, degenerate/zero-area rings, swapped lat/lng axes, antimeridian issues) before using it in any other tool. Optionally assert the geometry type you expect (e.g. Polygon) to catch a centroid passed where an area was needed.",
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
  "buffer_geometry",
  "Buffer a GeoJSON geometry by a distance in kilometers. Geometry is validated before buffering.",
  { geometry: GeometrySchema, distance_km: z.number().describe("Buffer distance in kilometers") },
  async ({ geometry, distance_km }) => {
    const failed = guardOrFail({ geometry });
    if (failed) return failed;
    const result = bufferGeometry(geometry as unknown as Geometry, distance_km);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "reproject_geometry",
  "Reproject a GeoJSON geometry between coordinate reference systems. Accepts EPSG codes (e.g. \"EPSG:4326\") or common names (WGS84, Web Mercator, NAD83, British National Grid, \"UTM zone 33N\").",
  {
    geometry: GeometrySchema,
    from_crs: z.string().describe("Source CRS, e.g. \"EPSG:4326\" or \"WGS84\""),
    to_crs: z.string().describe("Target CRS, e.g. \"EPSG:3857\" or \"Web Mercator\""),
  },
  async ({ geometry, from_crs, to_crs }) => {
    const failed = guardOrFail({ geometry, from_crs, to_crs });
    if (failed) return failed;
    try {
      const result = reprojectGeometry(geometry as unknown as Geometry, from_crs, to_crs);
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
  "Compute the geometric intersection of two GeoJSON polygons. Both are validated before intersecting, including that they're actually polygons — not points or lines.",
  { geometry_a: GeometrySchema, geometry_b: GeometrySchema },
  async ({ geometry_a, geometry_b }) => {
    const expectations: Record<string, FieldExpectation> = {
      geometry_a: { type: ["Polygon", "MultiPolygon"] },
      geometry_b: { type: ["Polygon", "MultiPolygon"] },
    };
    const failed = guardOrFail({ geometry_a, geometry_b }, expectations);
    if (failed) return failed;
    const result = intersectGeometries(geometry_a as unknown as Geometry, geometry_b as unknown as Geometry);
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
