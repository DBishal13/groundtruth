# Groundtruth — agent context

## Product purpose
Deterministic CRS resolution, GeoJSON validation, and topology sanity checks wrapped around every LLM tool call — the "LangGraph for GIS" nobody's shipped as an open, model-agnostic layer.

## MVP scope
Read `feasibility` in README.md for the realistic time-to-MVP estimate before committing to scope. Build the smallest version that lets you show a real user something concrete — favor an ugly working prototype over a polished mock.

## Product rules
- Do not build past what's needed to run the next discovery call or validate the next assumption.
- The core risk to design around: Incumbents have every incentive to keep this feature captive to their own platform rather than license it out, and GIS's fragmented CRS/format conventions make a truly generic validator harder to keep general than it first appears. The window to establish an open standard before Esri/Google close the gap natively is real but narrowing.
- Differentiate explicitly from: Esri ArcGIS AI Assistants, Google Geospatial Reasoning (preview), CARTO AI Agents (MCP-based), early open-source GDAL MCP servers. Felt raised $15M (Jul 2025) for a natural-language GIS builder, a vertical app rather than an infra layer.

## Success criteria
The project is on track when it can produce evidence — a working demo, a discovery-call finding, a pilot commitment — not just more code. See `VALIDATION.md` for the concrete decision gate.

## Working rule
Treat this as a validation exercise until a real buyer has said yes to a pilot or paid engagement. Keep it cheap until it earns the right to get expensive.
