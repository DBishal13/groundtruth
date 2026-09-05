export { resolveCRS, reprojectPoint, type ResolvedCRS } from "./core/crs.js";
export { validateStructure, checkTopology, type AnyGeoJSON } from "./core/geojson.js";
export { guardGeometry, guardToolCall } from "./core/guard.js";
export { parseGeometryInput, isMalformed, type ParsedGeometry, type MalformedGeometry } from "./core/formats.js";
export {
  readGeometryFile,
  guardGeometryFile,
  type FileFormat,
  type FileFeatureRecord,
  type FileParseResult,
  type FileIssue,
  type FileGuardResult,
} from "./core/files.js";
export type { Issue, IssueSeverity, GuardResult, FieldExpectation, GeoJSONType, GeometryFormat } from "./core/types.js";
