#!/usr/bin/env node
import { guardGeometryFile } from "./core/files.js";
import type { GeoJSONType } from "./core/types.js";

const HELP = `groundtruth — validate a geometry file the way an LLM tool call would be validated.

Format is auto-detected (extension first, then content):
  GeoJSON (.geojson/.json), WKT/EWKT (.wkt), KML (.kml), GML (.gml/.xml),
  Shapefile (.shp), GeoPackage (.gpkg)

Usage:
  groundtruth validate <file> [--type <GeoJSONType>]

Options:
  --type <GeoJSONType>   Assert every geometry should be this type (e.g. Polygon).
                          Flags a centroid/point passed where an area was expected.

Examples:
  groundtruth validate parcel.geojson
  groundtruth validate parcels.shp --type Polygon
  groundtruth validate parcels.gpkg
`;

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

// process.exit() forces the process down immediately, including any
// pending libuv handle from sql.js's WASM runtime (used for .gpkg files) —
// on Windows that aborts with a native assertion instead of exiting
// cleanly. Setting exitCode and returning lets Node drain and exit on its
// own once everything is actually done.
async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exitCode = command ? 0 : 1;
    return;
  }

  if (command !== "validate") {
    fail(`Unknown command "${command}".\n\n${HELP}`);
  }

  const file = rest.find((a) => !a.startsWith("--"));
  if (!file) fail(`Missing file argument.\n\n${HELP}`);

  const typeIndex = rest.indexOf("--type");
  const expectedType = typeIndex !== -1 ? (rest[typeIndex + 1] as GeoJSONType | undefined) : undefined;

  let result: Awaited<ReturnType<typeof guardGeometryFile>>;
  try {
    result = await guardGeometryFile(file, expectedType ? { type: expectedType } : undefined);
  } catch (err) {
    fail(`Could not read "${file}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const summary =
    result.totalFeatures === 1
      ? `${file}: ${result.ok ? "valid" : "invalid"} (${result.format})`
      : `${file}: ${result.totalFeatures - result.invalidFeatures}/${result.totalFeatures} features valid (${result.format})`;
  console.log(summary);

  for (const issue of result.issues) {
    const location = result.totalFeatures > 1 ? `feature[${issue.featureIndex}]: ` : "";
    console.log(`  [${issue.severity}] ${location}${issue.code}: ${issue.message}`);
    console.log(`    fix: ${issue.fix}`);
  }

  process.exitCode = result.ok ? 0 : 1;
}

run(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof CliError ? err.message : err);
  process.exitCode = 1;
});
