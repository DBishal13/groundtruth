#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { guardGeometry } from "./core/guard.js";
import type { GeoJSONType } from "./core/types.js";

const HELP = `groundtruth — validate a GeoJSON file the way an LLM tool call would be validated.

Usage:
  groundtruth validate <file.geojson> [--type <GeoJSONType>]

Options:
  --type <GeoJSONType>   Assert the geometry should be this type (e.g. Polygon).
                          Flags a centroid/point passed where an area was expected.

Examples:
  groundtruth validate parcel.geojson
  groundtruth validate parcel.geojson --type Polygon
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(command ? 0 : 1);
  }

  if (command !== "validate") {
    fail(`Unknown command "${command}".\n\n${HELP}`);
  }

  const file = rest.find((a) => !a.startsWith("--"));
  if (!file) fail(`Missing file argument.\n\n${HELP}`);

  const typeIndex = rest.indexOf("--type");
  const expectedType = typeIndex !== -1 ? (rest[typeIndex + 1] as GeoJSONType | undefined) : undefined;

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    fail(`Could not read "${file}": ${err instanceof Error ? err.message : String(err)}`);
  }

  let geometry: unknown;
  try {
    geometry = JSON.parse(raw);
  } catch (err) {
    fail(`"${file}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = guardGeometry(geometry, expectedType ? { type: expectedType } : undefined);

  if (result.issues.length === 0) {
    console.log(`${file}: valid`);
    process.exit(0);
  }

  console.log(`${file}: ${result.ok ? "valid, with warnings" : "invalid"}`);
  for (const issue of result.issues) {
    console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
    console.log(`    fix: ${issue.fix}`);
  }
  process.exit(result.ok ? 0 : 1);
}

main(process.argv.slice(2));
