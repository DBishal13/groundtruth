export type IssueSeverity = "error" | "warning";

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
  /** Geometry normalized to WGS84 / EPSG:4326 when a CRS could be resolved. */
  normalized?: T;
  resolvedCRS?: { input: string; epsg: number; name: string } | null;
  issues: Issue[];
}
