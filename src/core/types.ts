export type IssueSeverity = "error" | "warning";

/** The wire format a geometry-shaped input was detected in. */
export type GeometryFormat = "geojson" | "wkt" | "wkb" | "kml" | "gml";

export type GeoJSONType =
  | "Point" | "MultiPoint" | "LineString" | "MultiLineString"
  | "Polygon" | "MultiPolygon" | "GeometryCollection";

/** Constrains which geometry type(s) a tool call argument is allowed to be. */
export interface FieldExpectation {
  type: GeoJSONType | GeoJSONType[];
}

export interface Issue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** What the caller (an LLM) should do to fix it, phrased as an instruction. */
  fix: string;
}

export interface GuardResult<T = unknown> {
  ok: boolean;
  /** Geometry normalized to GeoJSON, regardless of the wire format it arrived in. */
  normalized?: T;
  resolvedCRS?: { input: string; epsg: number; name: string } | null;
  /** Wire format the geometry was detected in (guardGeometry only). */
  format?: GeometryFormat;
  /** Per-argument wire formats detected (guardToolCall only). */
  formats?: Record<string, GeometryFormat>;
  issues: Issue[];
}
