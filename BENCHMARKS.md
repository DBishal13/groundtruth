# Benchmark results

Generated 2026-09-06T03:22:49.807Z by `npm run bench` ([bench/run.ts](bench/run.ts)) — every number on this page is a real, reproducible measurement of this repository's own code, run with `node --version` = v24.18.1 on win32/x64. Re-run it yourself with `npm run bench`.

## What this is — and isn't

This measures whether `groundtruth`'s guard catches the specific, documented failure modes it claims to catch, using a labeled corpus built for this benchmark (`bench/fixtures.ts`): one deliberately broken input per issue code the guard can raise, plus one clean/valid input per supported wire format.

**This is not a reproduction of GeoBenchX** (the benchmark cited in the README as motivation) or any third-party benchmark. GeoBenchX grades whether an LLM agent completes a multi-step geospatial *task* end-to-end; this measures whether a deterministic *input validator* catches known-bad geometry before it reaches a GIS pipeline. They're different layers of the stack — the numbers below say nothing about LLM task-completion rates, only about this guard's own detection accuracy against its own documented scope.

## Detection rate (synthetic failure-mode corpus)

One deliberately broken input per documented issue code, checking whether the guard's actual output includes the expected issue code.

- **13/13** documented failure modes correctly detected (100%)
- **6/6** clean/valid inputs correctly passed with no false positives (100%)

| Case | Expected issue | Detected? |
|---|---|---|
| swapped lat/lng (GeoJSON Point) | `lat_out_of_range` | ✅ |
| longitude out of range | `lon_out_of_range` | ✅ |
| self-intersecting bowtie polygon | `self_intersection` | ✅ |
| zero-area collinear polygon | `zero_area` | ✅ |
| antimeridian-spanning linestring | `possible_antimeridian` | ✅ |
| clockwise exterior ring (wrong winding) | `polygon_winding_order` | ✅ |
| centroid passed where polygon expected | `geometry_type_mismatch` | ✅ |
| hallucinated CRS name | `unresolved_crs` | ✅ |
| malformed WKT (unclosed paren) | `malformed_wkt` | ✅ |
| truncated/ambiguous hex string (should be silently ignored, not flagged) | `(none — should be clean)` | ✅ |
| malformed KML (no geometry) | `malformed_kml` | ✅ |
| non-geographic SRID (EWKT 3857) | `non_geographic_srid` | ✅ |
| unclosed polygon ring (structural) | `unclosed_ring` | ✅ |
| invalid geometry type string | `invalid_type` | ✅ |
| clean GeoJSON polygon | `(none — should be clean)` | ✅ |
| clean WKT polygon | `(none — should be clean)` | ✅ |
| clean hex WKB point | `(none — should be clean)` | ✅ |
| clean inline KML point | `(none — should be clean)` | ✅ |
| clean inline GML polygon | `(none — should be clean)` | ✅ |

## Multi-feature file formats (Shapefile, GeoPackage)

| Case | Result |
|---|---|
| Shapefile: clean polygon | ✅ (1/1 valid) |
| Shapefile: self-intersecting polygon | ✅ (self_intersection, zero_area) |
| GeoPackage: 2 features, 1 broken | ✅ (1/2 valid) |

## Throughput

Single-process, single-geometry `guardToolCall` calls per second, Node v24.18.1, win32/x64, 5,000 iterations per format after a 200-iteration warmup.

| Format | Ops/sec |
|---|---|
| GeoJSON | 166,776 |
| WKT | 152,897 |
| hex WKB | 557,184 |
| inline KML | 29,724 |
| inline GML | 25,832 |

XML formats (KML/GML) are ~5-6x slower than GeoJSON/WKT because each call pays for a fresh XML parse (`fast-xml-parser`) on top of geometry extraction — still well over an order of magnitude faster than a network round-trip to any LLM, so it's not the bottleneck in a real tool-call loop.

## Format coverage

| Format | Read (validate) | Write (produce) |
|---|---|---|
| GeoJSON | ✅ | ✅ |
| WKT / EWKT | ✅ | — |
| WKB / EWKB (hex) | ✅ | — |
| KML | ✅ | — |
| GML | ✅ | — |
| Shapefile (.shp) | ✅ (file only) | — |
| GeoPackage (.gpkg) | ✅ (file only) | — |

Most comparable open-source "GIS + LLM" guard/validation layers found during this project's own research handle GeoJSON only; this is the specific gap the project exists to close (see the README's "Why this matters" for the competitive landscape this claim is measured against).

## Known limitations (found and kept honest, not smoothed over)

- **WKB/EWKB detection is intentionally asymmetric.** A hex string only becomes a `malformed_wkb` finding if the guard is confident it's WKB in the first place — and that confidence comes from successfully parsing it. So an actually-malformed WKB string is indistinguishable from "not WKB at all" and is silently left alone (see the "truncated/ambiguous hex string" row above). This means the `malformed_wkb` issue code cannot currently be produced through inline detection — a deliberate trade-off (favoring zero false positives on unrelated hex ids/hashes over catching malformed WKB), but worth knowing rather than discovering by surprise.
- **GML axis order is assumed, not resolved.** Coordinates are read as (longitude, latitude) — the convention nearly all real-world WFS/GML output actually uses — rather than resolving the strict EPSG:4326 registry order (latitude, longitude first) from `srsName`. A GML document using strict axis order would be silently misread rather than rejected.
- **This benchmark was itself responsible for finding one real bug**, fixed in the same change that added it: `guardToolCall` was silently skipping any geometry-shaped tool-call argument whose `type` field didn't exactly match a recognized GeoJSON type string — meaning a plausible LLM mistake like a miscased `"point"` or misspelled `"Polgyon"` bypassed validation entirely instead of being flagged. Closed by treating any object with a string `type` *and* an array `coordinates` as an attempted geometry, regardless of whether `type` is recognized.
