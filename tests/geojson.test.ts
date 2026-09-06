import { describe, expect, it } from "vitest";
import { checkTopology, validateStructure } from "../src/core/geojson.js";

describe("validateStructure", () => {
  it("accepts a well-formed polygon", () => {
    const square = {
      type: "Polygon",
      coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
    };
    expect(validateStructure(square)).toHaveLength(0);
  });

  it("flags an unclosed ring", () => {
    const openRing = {
      type: "Polygon",
      coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0]]],
    };
    const issues = validateStructure(openRing);
    expect(issues.some((i) => i.code === "unclosed_ring")).toBe(true);
  });

  it("flags an unrecognized type", () => {
    const issues = validateStructure({ type: "Blob", coordinates: [] });
    expect(issues.some((i) => i.code === "invalid_type")).toBe(true);
  });

  it("flags a non-object input", () => {
    const issues = validateStructure("not geojson");
    expect(issues.some((i) => i.code === "not_an_object")).toBe(true);
  });

  it("recurses into FeatureCollection members", () => {
    const fc = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0]]] }, properties: {} },
      ],
    };
    const issues = validateStructure(fc);
    expect(issues.some((i) => i.code === "unclosed_ring")).toBe(true);
  });
});

describe("checkTopology", () => {
  it("flags swapped lat/lng axes", () => {
    // Latitude of 105 is impossible — a classic [lat, lng] vs [lng, lat] mixup.
    const point = { type: "Point", coordinates: [45, 105] };
    const issues = checkTopology(point);
    expect(issues.some((i) => i.code === "lat_out_of_range")).toBe(true);
  });

  it("flags a self-intersecting (bowtie) polygon", () => {
    const bowtie = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]],
    };
    const issues = checkTopology(bowtie);
    expect(issues.some((i) => i.code === "self_intersection")).toBe(true);
  });

  it("flags a zero-area (degenerate) polygon", () => {
    const collinear = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]],
    };
    const issues = checkTopology(collinear);
    expect(issues.some((i) => i.code === "zero_area")).toBe(true);
  });

  it("warns on a likely mishandled antimeridian crossing", () => {
    const spanning = { type: "LineString", coordinates: [[-179, 10], [179, 12]] };
    const issues = checkTopology(spanning);
    expect(issues.some((i) => i.code === "possible_antimeridian")).toBe(true);
  });

  it("passes a clean, valid, correctly-wound polygon with no issues", () => {
    const square = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]], // counter-clockwise
    };
    expect(checkTopology(square)).toHaveLength(0);
  });

  it("warns on a clockwise-wound exterior ring", () => {
    const clockwiseSquare = {
      type: "Polygon",
      coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]], // clockwise
    };
    const issues = checkTopology(clockwiseSquare);
    expect(issues.some((i) => i.code === "polygon_winding_order" && i.severity === "warning")).toBe(true);
  });

  it("does not warn on a hole with correct (clockwise) winding", () => {
    const withHole = {
      type: "Polygon",
      coordinates: [
        [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], // exterior, CCW
        [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]], // hole, CW
      ],
    };
    const issues = checkTopology(withHole);
    expect(issues.some((i) => i.code === "polygon_winding_order")).toBe(false);
  });
});
