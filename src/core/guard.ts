import { resolveCRS } from "./crs.js";
import { checkTopology, validateStructure, type AnyGeoJSON } from "./geojson.js";
import type { GuardResult, Issue } from "./types.js";

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

const CRS_KEYS = ["crs", "srs", "projection", "source_crs", "target_crs", "from_crs", "to_crs"];

/**
 * Validate a single geometry: structural well-formedness, then (only if
 * structurally sound) topology sanity checks.
 */
export function guardGeometry(geometry: unknown): GuardResult<AnyGeoJSON> {
  const structural = validateStructure(geometry);
  if (structural.some((i) => i.severity === "error")) {
    return { ok: false, issues: structural };
  }
  const topology = checkTopology(geometry as AnyGeoJSON);
  const issues = [...structural, ...topology];
  return {
    ok: !issues.some((i) => i.severity === "error"),
    normalized: geometry as AnyGeoJSON,
    issues,
  };
}

/**
 * Validate every geometry-shaped and CRS-shaped field found in a tool
 * call's arguments. This is the "wrap every LLM tool call" entry point:
 * call it before executing the tool, and if `ok` is false, return the
 * issues to the model as the tool result instead of running the tool.
 */
export function guardToolCall(args: Record<string, unknown>): GuardResult<Record<string, unknown>> {
  const issues: Issue[] = [];
  const normalized: Record<string, unknown> = { ...args };

  for (const [key, value] of Object.entries(args)) {
    if (looksLikeGeoJSON(value)) {
      const result = guardGeometry(value);
      for (const issue of result.issues) {
        issues.push({ ...issue, message: `${key}: ${issue.message}` });
      }
      if (result.ok && result.normalized) normalized[key] = result.normalized;
    }
  }

  for (const key of CRS_KEYS) {
    const value = args[key];
    if (typeof value === "string") {
      const resolved = resolveCRS(value);
      if (!resolved) {
        issues.push({
          severity: "error",
          code: "unresolved_crs",
          message: `${key}: "${value}" could not be resolved to a known CRS.`,
          fix: `Use a canonical EPSG code (e.g. "EPSG:4326") or a well-known name (WGS84, Web Mercator, NAD83, British National Grid, or "UTM zone <N><N/S>").`,
        });
      }
    }
  }

  return {
    ok: !issues.some((i) => i.severity === "error"),
    normalized,
    issues,
  };
}
