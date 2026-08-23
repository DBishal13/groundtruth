import { describe, expect, it } from "vitest";
import { resolveCRS, reprojectPoint } from "../src/core/crs.js";

describe("resolveCRS", () => {
  it("resolves canonical EPSG codes", () => {
    expect(resolveCRS("EPSG:4326")?.epsg).toBe(4326);
    expect(resolveCRS("4326")?.epsg).toBe(4326);
  });

  it("resolves common aliases an LLM would actually write", () => {
    expect(resolveCRS("WGS84")?.epsg).toBe(4326);
    expect(resolveCRS("Web Mercator")?.epsg).toBe(3857);
    expect(resolveCRS("web mercator")?.epsg).toBe(3857);
    expect(resolveCRS("British National Grid")?.epsg).toBe(27700);
  });

  it("resolves UTM zone descriptions to the correct EPSG code", () => {
    expect(resolveCRS("UTM zone 33N")?.epsg).toBe(32633);
    expect(resolveCRS("UTM 18S")?.epsg).toBe(32718);
  });

  it("fails closed on unresolvable strings instead of guessing", () => {
    expect(resolveCRS("some made up projection")).toBeNull();
    expect(resolveCRS("")).toBeNull();
  });

  it("round-trips a point through WGS84 -> Web Mercator -> WGS84", () => {
    const wgs84 = resolveCRS("EPSG:4326")!;
    const webMerc = resolveCRS("EPSG:3857")!;
    const original: [number, number] = [-122.42, 37.77];
    const projected = reprojectPoint(original, wgs84, webMerc);
    const back = reprojectPoint(projected, webMerc, wgs84);
    expect(back[0]).toBeCloseTo(original[0], 6);
    expect(back[1]).toBeCloseTo(original[1], 6);
  });
});
