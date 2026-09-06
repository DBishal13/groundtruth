# The business case — Groundtruth

This is the pitch and market framing behind the project. For the actual software, see [README.md](README.md). For how we're testing whether this should become more than a prototype, see [VALIDATION.md](VALIDATION.md).

**Domain:** Agentic AI · **Tier:** 1 (build now) · **Composite score:** 3.4/5

## Why this matters
Real but closing. Esri is shipping AI Assistants into ArcGIS Online on a monthly cadence through 2026; Google Research's "Geospatial Reasoning" orchestrates Gemini across multiple Earth foundation models but remains a trusted-tester preview; CARTO ships production AI agents over customer warehouses. All three are building this inside their own walled platforms, not as a portable, model-agnostic validation layer. Independent benchmarks confirm the problem is unsolved: GeoBenchX found even the best model (Claude Sonnet 3.5) hit only 53% success on solvable multi-step geospatial tasks, routinely confusing centroids for polygons and using stale geographic facts.

## Market signal
No dedicated market figure exists. Broad AI-agent market estimates range so widely between research firms ($43B by 2030 to $295B by 2035) that none should be treated as reliable for this narrow slice.

## Feasibility & time-to-MVP
The validation primitives are solved, mature libraries (Shapely/GEOS, pyproj) — the work is wiring LLM tool-call outputs to them with graceful failure recovery across multi-stage GDAL/PDAL pipelines. A schema-and-CRS wrapper ships in weeks; a full multi-stage orchestrator with topology sanity and rollback is a 3–6 month build for a strong team, roughly matching where academic prototypes (GISclaw) already sit.

## Existing players to differentiate from
Esri ArcGIS AI Assistants, Google Geospatial Reasoning (preview), CARTO AI Agents (MCP-based), early open-source GDAL MCP servers. Felt raised $15M (Jul 2025) for a natural-language GIS builder, a vertical app rather than an infra layer.

## Core risk to de-risk first
Incumbents have every incentive to keep this feature captive to their own platform rather than license it out, and GIS's fragmented CRS/format conventions make a truly generic validator harder to keep general than it first appears. The window to establish an open standard before Esri/Google close the gap natively is real but narrowing.

## Scoring snapshot

| Dimension | Score |
|---|---|
| Whitespace | 3/5 |
| Market signal | 3/5 |
| Feasibility | 4/5 |
| Capital efficiency | 4/5 |
| Buyer readiness | 3/5 |

## Status
This is a thin working prototype, not a validated product yet. `VALIDATION.md` is still the decision gate for whether to invest further.
