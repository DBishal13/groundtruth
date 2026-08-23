import { describe, expect, it } from "vitest";
import { guardToolCall } from "../src/core/guard.js";

describe("guardToolCall", () => {
  it("passes a clean tool call through unchanged", () => {
    const args = {
      geometry: { type: "Point", coordinates: [-122.42, 37.77] },
      target_crs: "EPSG:3857",
    };
    const result = guardToolCall(args);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects a tool call with a broken geometry and explains why", () => {
    const args = {
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] },
    };
    const result = guardToolCall(args);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "self_intersection")).toBe(true);
    expect(result.issues[0].fix).toBeTruthy();
  });

  it("rejects a tool call with an unresolvable CRS string", () => {
    const args = { geometry: { type: "Point", coordinates: [0, 0] }, from_crs: "Narnia Grid" };
    const result = guardToolCall(args);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "unresolved_crs")).toBe(true);
  });

  it("catches multiple independent problems in one call", () => {
    const args = {
      geometry_a: { type: "Point", coordinates: [999, 999] },
      geometry_b: { type: "Polygon", coordinates: [[[0, 0], [1, 0]]] },
      to_crs: "made up crs",
    };
    const result = guardToolCall(args);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});
