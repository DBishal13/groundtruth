import { resolveCRS } from "./crs.js";
import { checkTopology, validateStructure, type AnyGeoJSON } from "./geojson.js";

/**
 * A weaker, structural-only signal than parseGeometryInput's format
 * detection: an object with a string `type` and an array `coordinates` is
 * clearly *intended* as a GeoJSON geometry even if `type` is misspelled or
 * miscased (e.g. "Polgyon", "point") — a plausible and common LLM mistake.
 * parseGeometryInput requires a *recognized* type and would return null
 * here, letting the field slip past guardToolCall unchecked; this catches
 * it so validateStructure can report the real "invalid_type" problem
 * instead of the field being silently ignored.
 */
function looksIntendedAsGeometry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.type === "string" && Array.isArray(obj.coordinates);
}
import { isMalformed, parseGeometryInput, type MalformedGeometry, type ParsedGeometry } from "./formats.js";
import type { FieldExpectation, GeoJSONType, GeometryFormat, GuardResult, Issue } from "./types.js";

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

const MALFORMED_FIXES: Record<GeometryFormat, string> = {
  geojson: `Check the GeoJSON structure — a Geometry, Feature, or FeatureCollection with well-formed "coordinates".`,
  wkt: `Check the WKT syntax — e.g. "POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))", with rings closed and parentheses balanced.`,
  wkb: `Check the WKB/EWKB hex encoding is complete and correctly byte-ordered.`,
  kml: `Check the KML contains a <Placemark> with a <Point>, <LineString>, or <Polygon> geometry, and that <coordinates> are well-formed.`,
  gml: `Check the GML contains a recognized geometry element (<Point>/<LineString>/<Polygon>/Multi*) with a well-formed <pos>, <posList>, or <coordinates>.`,
};

function malformedIssue(parsed: MalformedGeometry): Issue {
  return {
    severity: "error",
    code: `malformed_${parsed.format}`,
    message: `Could not parse as ${parsed.format.toUpperCase()}: ${parsed.error}`,
    fix: MALFORMED_FIXES[parsed.format],
  };
}

function sridWarning(srid: number): Issue {
  return {
    severity: "warning",
    code: "non_geographic_srid",
    message: `Geometry declares SRID ${srid}, not 4326 (WGS84). Coordinate-range and topology checks assume geographic degrees and may be unreliable if this is a projected CRS.`,
    fix: `If SRID ${srid} is a projected CRS, reproject to EPSG:4326 first, or confirm the coordinates are actually longitude/latitude in degrees.`,
  };
}

/**
 * Validate a single geometry, regardless of wire format (GeoJSON, WKT/EWKT,
 * or hex WKB/EWKB): structural well-formedness, then (only if structurally
 * sound) topology sanity checks and an optional type check.
 */
export function guardGeometry(input: unknown, expectation?: FieldExpectation): GuardResult<AnyGeoJSON> {
  const parsed = parseGeometryInput(input);

  // Not recognized as any known geometry wire format — fall back to
  // structural validation, which produces a clear "not an object" /
  // "invalid type" error for whatever this actually is.
  if (!parsed) {
    return { ok: false, issues: validateStructure(input) };
  }

  if (isMalformed(parsed)) {
    return { ok: false, format: parsed.format, issues: [malformedIssue(parsed)] };
  }

  return guardParsedGeometry(parsed, expectation);
}

function guardParsedGeometry(parsed: ParsedGeometry, expectation?: FieldExpectation): GuardResult<AnyGeoJSON> {
  const { geojson, format, srid } = parsed;
  const structural = validateStructure(geojson);
  if (structural.some((i) => i.severity === "error")) {
    return { ok: false, format, issues: structural };
  }
  const topology = checkTopology(geojson);
  const typeCheck = expectation ? checkTypeExpectation(geojson, expectation) : [];
  const sridIssue = srid !== undefined && srid !== 4326 ? [sridWarning(srid)] : [];
  const issues = [...structural, ...topology, ...typeCheck, ...sridIssue];
  return {
    ok: !issues.some((i) => i.severity === "error"),
    normalized: geojson,
    format,
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
  const formats: Record<string, GeometryFormat> = {};

  for (const [key, value] of Object.entries(args)) {
    const parsed = parseGeometryInput(value);
    if (!parsed) {
      if (looksIntendedAsGeometry(value)) {
        formats[key] = "geojson";
        for (const issue of validateStructure(value)) {
          issues.push({ ...issue, message: `${key}: ${issue.message}` });
        }
      }
      continue;
    }

    if (isMalformed(parsed)) {
      formats[key] = parsed.format;
      const issue = malformedIssue(parsed);
      issues.push({ ...issue, message: `${key}: ${issue.message}` });
      continue;
    }

    formats[key] = parsed.format;
    const result = guardParsedGeometry(parsed, expectations?.[key]);
    for (const issue of result.issues) {
      issues.push({ ...issue, message: `${key}: ${issue.message}` });
    }
    if (result.normalized) normalized[key] = result.normalized;
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
    formats,
    issues,
  };
}
