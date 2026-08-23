import { resolveCRS } from "./crs.js";
import { checkTopology, validateStructure, type AnyGeoJSON } from "./geojson.js";
import type { FieldExpectation, GeoJSONType, GuardResult, Issue } from "./types.js";

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

/** The GeoJSON geometry type of a Geometry or Feature, unwrapping Feature. */
function geometryTypeOf(value: AnyGeoJSON): string | null {
  const raw = value as { type?: string; geometry?: { type?: string } | null };
  if (raw.type === "Feature") return raw.geometry?.type ?? null;
  return raw.type ?? null;
}

function checkTypeExpectation(value: AnyGeoJSON, expectation: FieldExpectation): Issue[] {
  const allowed = Array.isArray(expectation.type) ? expectation.type : [expectation.type];
  const actual = geometryTypeOf(value);
  if (actual && !allowed.includes(actual as GeoJSONType)) {
    return [
      {
        severity: "error",
        code: "geometry_type_mismatch",
        message: `expected ${allowed.join(" or ")}, but received ${actual}.`,
        fix:
          allowed.some((t) => t === "Polygon" || t === "MultiPolygon") && (actual === "Point" || actual === "MultiPoint")
            ? `This tool needs an area (${allowed.join("/")}), not a location. Do not pass a centroid or representative point in place of the shape it summarizes — provide the actual boundary geometry, or buffer the point into a polygon first if an area is genuinely what you mean.`
            : `Provide a ${allowed.join(" or ")} geometry instead of ${actual}.`,
      },
    ];
  }
  return [];
}

/**
 * Validate a single geometry: structural well-formedness, then (only if
 * structurally sound) topology sanity checks and an optional type check.
 */
export function guardGeometry(geometry: unknown, expectation?: FieldExpectation): GuardResult<AnyGeoJSON> {
  const structural = validateStructure(geometry);
  if (structural.some((i) => i.severity === "error")) {
    return { ok: false, issues: structural };
  }
  const topology = checkTopology(geometry as AnyGeoJSON);
  const typeCheck = expectation ? checkTypeExpectation(geometry as AnyGeoJSON, expectation) : [];
  const issues = [...structural, ...topology, ...typeCheck];
  return {
    ok: !issues.some((i) => i.severity === "error"),
    normalized: geometry as AnyGeoJSON,
    issues,
  };
}

const CRS_KEYS = ["crs", "srs", "projection", "source_crs", "target_crs", "from_crs", "to_crs"];

/**
 * Validate every geometry-shaped and CRS-shaped field found in a tool
 * call's arguments. This is the "wrap every LLM tool call" entry point:
 * call it before executing the tool, and if `ok` is false, return the
 * issues to the model as the tool result instead of running the tool.
 *
 * `expectations` lets the caller declare, per argument name, which
 * geometry type(s) that tool actually needs (e.g. an intersect tool
 * requires Polygon/MultiPolygon) so a centroid-for-polygon mixup — the
 * #1 documented GeoBenchX failure mode — is caught here instead of
 * crashing or silently misbehaving downstream.
 */
export function guardToolCall(
  args: Record<string, unknown>,
  expectations?: Record<string, FieldExpectation>,
): GuardResult<Record<string, unknown>> {
  const issues: Issue[] = [];
  const normalized: Record<string, unknown> = { ...args };

  for (const [key, value] of Object.entries(args)) {
    if (looksLikeGeoJSON(value)) {
      const result = guardGeometry(value, expectations?.[key]);
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
