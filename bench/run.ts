/**
 * Benchmark runner: measures detection rate + false-positive rate against
 * the labeled corpus in fixtures.ts, plus raw throughput, then writes
 * bench/results.json and prints a markdown report to stdout (redirected
 * to BENCHMARKS.md by `npm run bench`).
 *
 * This measures groundtruth's own guard against its own documented issue
 * codes — it is NOT a reproduction of GeoBenchX or any other third-party
 * benchmark (those grade end-to-end LLM task success; this grades whether
 * a deterministic validator catches known-bad input). Framed honestly
 * throughout rather than implying a head-to-head comparison.
 */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardToolCall } from "../src/core/guard.js";
import { guardGeometryFile } from "../src/core/files.js";
import { INLINE_CASES, buildShp, buildGeoPackage } from "./fixtures.js";

interface CaseResult {
  label: string;
  expected: string | null;
  found: string[];
  pass: boolean;
}

function runInlineCorpus(): CaseResult[] {
  return INLINE_CASES.map((c) => {
    const result = guardToolCall(c.args, c.expectations);
    const found = result.issues.map((i) => i.code);
    const pass = c.expectIssueCode === null ? result.issues.length === 0 : found.includes(c.expectIssueCode);
    return { label: c.label, expected: c.expectIssueCode, found, pass };
  });
}

async function runFileCorpus(): Promise<{ label: string; pass: boolean; detail: string }[]> {
  const dir = mkdtempSync(join(tmpdir(), "groundtruth-bench-"));
  const results: { label: string; pass: boolean; detail: string }[] = [];
  try {
    // Shapefile: one clean polygon.
    const shpPath = join(dir, "clean.shp");
    writeFileSync(shpPath, buildShp([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]));
    const shpResult = await guardGeometryFile(shpPath, { type: "Polygon" });
    results.push({ label: "Shapefile: clean polygon", pass: shpResult.ok && shpResult.invalidFeatures === 0, detail: `${shpResult.totalFeatures - shpResult.invalidFeatures}/${shpResult.totalFeatures} valid` });

    // Shapefile: one self-intersecting polygon (bowtie).
    const shpBadPath = join(dir, "bad.shp");
    writeFileSync(shpBadPath, buildShp([[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]));
    const shpBadResult = await guardGeometryFile(shpBadPath);
    results.push({ label: "Shapefile: self-intersecting polygon", pass: !shpBadResult.ok && shpBadResult.issues.some((i) => i.code === "self_intersection"), detail: shpBadResult.issues.map((i) => i.code).join(", ") });

    // GeoPackage: two features, one clean, one with out-of-range coordinates.
    const gpkgPath = join(dir, "mixed.gpkg");
    writeFileSync(gpkgPath, await buildGeoPackage([
      { geojson: { type: "Point", coordinates: [1, 2] } },
      { geojson: { type: "Point", coordinates: [200, 200] } },
    ]));
    const gpkgResult = await guardGeometryFile(gpkgPath);
    results.push({
      label: "GeoPackage: 2 features, 1 broken",
      pass: gpkgResult.totalFeatures === 2 && gpkgResult.invalidFeatures === 1,
      detail: `${gpkgResult.totalFeatures - gpkgResult.invalidFeatures}/${gpkgResult.totalFeatures} valid`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

function benchmarkThroughput(): { label: string; opsPerSec: number }[] {
  const targets: { label: string; args: Record<string, unknown> }[] = [
    { label: "GeoJSON", args: { geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } } },
    { label: "WKT", args: { geometry: "POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))" } },
    { label: "hex WKB", args: { geometry: "01010000007b14ae47e19a5ec0c3f5285c8fe24240" } },
    { label: "inline KML", args: { geometry: '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Point><coordinates>-122.42,37.77</coordinates></Point></Placemark></kml>' } },
    { label: "inline GML", args: { geometry: '<gml:Polygon xmlns:gml="http://www.opengis.net/gml"><gml:exterior><gml:LinearRing><gml:posList>0 0 1 0 1 1 0 1 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>' } },
  ];
  const ITERATIONS = 5000;
  return targets.map(({ label, args }) => {
    // Warm up (JIT, lazy regex compilation, etc.) before timing.
    for (let i = 0; i < 200; i++) guardToolCall(args);
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) guardToolCall(args);
    const elapsedMs = performance.now() - start;
    return { label, opsPerSec: Math.round((ITERATIONS / elapsedMs) * 1000) };
  });
}

async function main() {
  const inline = runInlineCorpus();
  const files = await runFileCorpus();
  const throughput = benchmarkThroughput();

  const errorCases = inline.filter((c) => c.expected !== null);
  const cleanCases = inline.filter((c) => c.expected === null);
  const detectionRate = errorCases.filter((c) => c.pass).length / errorCases.length;
  const falsePositiveFreeRate = cleanCases.filter((c) => c.pass).length / cleanCases.length;

  const report = {
    generatedAt: new Date().toISOString(),
    inlineCorpus: { total: inline.length, errorCases: errorCases.length, cleanCases: cleanCases.length, detectionRate, falsePositiveFreeRate, results: inline },
    fileCorpus: files,
    throughput,
  };
  writeFileSync(join(import.meta.dirname, "results.json"), JSON.stringify(report, null, 2));

  const failed = [...inline, ...files.map((f) => ({ label: f.label, pass: f.pass }))].filter((r) => !r.pass);

  console.log(`# Benchmark results\n`);
  console.log(`Generated ${report.generatedAt}\n`);
  console.log(`## Detection rate (synthetic failure-mode corpus)\n`);
  console.log(`One deliberately broken input per documented issue code, checking whether the guard's actual output includes the expected issue code.\n`);
  console.log(`- **${errorCases.filter((c) => c.pass).length}/${errorCases.length}** documented failure modes correctly detected (${(detectionRate * 100).toFixed(0)}%)`);
  console.log(`- **${cleanCases.filter((c) => c.pass).length}/${cleanCases.length}** clean/valid inputs correctly passed with no false positives (${(falsePositiveFreeRate * 100).toFixed(0)}%)\n`);
  console.log(`| Case | Expected issue | Detected? |`);
  console.log(`|---|---|---|`);
  for (const c of inline) {
    console.log(`| ${c.label} | \`${c.expected ?? "(none — should be clean)"}\` | ${c.pass ? "✅" : "❌ **MISS**"} |`);
  }

  console.log(`\n## Multi-feature file formats (Shapefile, GeoPackage)\n`);
  console.log(`| Case | Result |`);
  console.log(`|---|---|`);
  for (const f of files) {
    console.log(`| ${f.label} | ${f.pass ? "✅" : "❌ **MISS**"} (${f.detail}) |`);
  }

  console.log(`\n## Throughput\n`);
  console.log(`Single-process, single-geometry \`guardToolCall\` calls per second, Node ${process.version}, ${process.platform}/${process.arch}, ${ITERATIONS_NOTE}.\n`);
  console.log(`| Format | Ops/sec |`);
  console.log(`|---|---|`);
  for (const t of throughput) {
    console.log(`| ${t.label} | ${t.opsPerSec.toLocaleString()} |`);
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} case(s) failed — see above.`);
    process.exitCode = 1;
  }
}

const ITERATIONS_NOTE = "5,000 iterations per format after a 200-iteration warmup";

main();
