import { describe, expect, it } from "vitest";
import { guardGeometry, guardToolCall } from "../src/core/guard.js";

describe("guardGeometry with a type expectation", () => {
  it("passes when the geometry matches the expected type", () => {
    const polygon = { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] };
    const result = guardGeometry(polygon, { type: "Polygon" });
    expect(result.ok).toBe(true);
  });

  it("flags a centroid passed where an area was expected — the GeoBenchX failure mode", () => {
    const centroid = { type: "Point", coordinates: [-122.42, 37.77] };
    const result = guardGeometry(centroid, { type: ["Polygon", "MultiPolygon"] });
    expect(result.ok).toBe(false);
    const mismatch = result.issues.find((i) => i.code === "geometry_type_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.fix).toMatch(/centroid/i);
  });

  it("accepts any of several allowed types", () => {
    const multiPolygon = {
      type: "MultiPolygon",
      coordinates: [[[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]],
    };
    const result = guardGeometry(multiPolygon, { type: ["Polygon", "MultiPolygon"] });
    expect(result.ok).toBe(true);
  });
});

describe("guardToolCall with per-argument expectations", () => {
  it("rejects an intersect-style call when one side is a point instead of a polygon", () => {
    const args = {
      geometry_a: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
      geometry_b: { type: "Point", coordinates: [0.5, 0.5] },
    };
    const result = guardToolCall(args, {
      geometry_a: { type: ["Polygon", "MultiPolygon"] },
      geometry_b: { type: ["Polygon", "MultiPolygon"] },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "geometry_type_mismatch" && i.message.startsWith("geometry_b:"))).toBe(true);
  });
});
