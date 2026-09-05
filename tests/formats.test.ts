import { describe, expect, it } from "vitest";
import { isMalformed, parseGeometryInput } from "../src/core/formats.js";
import { guardGeometry, guardToolCall } from "../src/core/guard.js";

describe("parseGeometryInput", () => {
  it("recognizes a GeoJSON object", () => {
    const result = parseGeometryInput({ type: "Point", coordinates: [1, 2] });
    expect(result).not.toBeNull();
    expect(result && !isMalformed(result) && result.format).toBe("geojson");
  });

  it("parses a WKT string to GeoJSON", () => {
    const result = parseGeometryInput("POINT(-122.42 37.77)");
    expect(result).not.toBeNull();
    expect(result && !isMalformed(result) && result.format).toBe("wkt");
    expect(result && !isMalformed(result) && result.geojson).toEqual({
      type: "Point",
      coordinates: [-122.42, 37.77],
    });
  });

  it("parses an EWKT string and captures the SRID", () => {
    const result = parseGeometryInput("SRID=4326;POINT(-122.42 37.77)");
    expect(result && !isMalformed(result) && result.srid).toBe(4326);
  });

  it("parses a lowercase WKT keyword", () => {
    const result = parseGeometryInput("point(1 2)");
    expect(result).not.toBeNull();
    expect(result && !isMalformed(result) && result.format).toBe("wkt");
  });

  it("reports malformed WKT as an error, not a silent skip", () => {
    const result = parseGeometryInput("POLYGON((0 0, 1 1)");
    expect(result).not.toBeNull();
    expect(result && isMalformed(result)).toBe(true);
    expect(result && isMalformed(result) && result.format).toBe("wkt");
  });

  it("parses hex-encoded WKB to GeoJSON", () => {
    // POINT(-122.42 37.77) as little-endian WKB hex
    const hex = "01010000007b14ae47e19a5ec0c3f5285c8fe24240";
    const result = parseGeometryInput(hex);
    expect(result).not.toBeNull();
    expect(result && !isMalformed(result) && result.format).toBe("wkb");
    expect(result && !isMalformed(result) && result.geojson).toEqual({
      type: "Point",
      coordinates: [-122.42, 37.77],
    });
  });

  it("does not mistake an arbitrary hex-looking id for WKB", () => {
    const result = parseGeometryInput("deadbeefcafebabe1234");
    expect(result).toBeNull();
  });

  it("returns null for a plain non-geometry string", () => {
    expect(parseGeometryInput("hello world")).toBeNull();
  });

  it("returns null for a plain object with no type field", () => {
    expect(parseGeometryInput({ foo: "bar" })).toBeNull();
  });

  it("parses an inline KML Placemark", () => {
    const kml = `<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Point><coordinates>-122.42,37.77</coordinates></Point></Placemark></kml>`;
    const result = parseGeometryInput(kml);
    expect(result).not.toBeNull();
    expect(result && !isMalformed(result) && result.format).toBe("kml");
    expect(result && !isMalformed(result) && result.geojson).toEqual({ type: "Point", coordinates: [-122.42, 37.77] });
  });

  it("reports KML with no geometry as malformed", () => {
    const kml = `<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>Empty</name></Placemark></kml>`;
    const result = parseGeometryInput(kml);
    expect(result && isMalformed(result) && result.format).toBe("kml");
  });

  it("parses an inline GML polygon (gml: prefix)", () => {
    const gml = `<gml:Polygon xmlns:gml="http://www.opengis.net/gml"><gml:exterior><gml:LinearRing><gml:posList>0 0 0 1 1 1 1 0 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>`;
    const result = parseGeometryInput(gml);
    expect(result).not.toBeNull();
    expect(result && !isMalformed(result) && result.format).toBe("gml");
    expect(result && !isMalformed(result) && result.geojson).toEqual({
      type: "Polygon",
      coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
    });
  });

  it("does not mistake an arbitrary XML string for GML", () => {
    const xml = `<config><Point>not geospatial</Point></config>`;
    expect(parseGeometryInput(xml)).toBeNull();
  });
});

describe("guardGeometry with WKT/WKB input", () => {
  it("validates a clean WKT polygon", () => {
    const result = guardGeometry("POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))");
    expect(result.ok).toBe(true);
    expect(result.format).toBe("wkt");
    expect(result.normalized).toEqual({
      type: "Polygon",
      coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
    });
  });

  it("catches swapped lat/lng axes expressed as WKT", () => {
    const result = guardGeometry("POINT(37.77 -122.42)");
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "lat_out_of_range")).toBe(true);
  });

  it("catches a self-intersecting polygon expressed as WKT", () => {
    const result = guardGeometry("POLYGON((0 0, 1 1, 1 0, 0 1, 0 0))");
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "self_intersection")).toBe(true);
  });

  it("rejects malformed WKT with a clear fix instruction", () => {
    const result = guardGeometry("POLYGON((0 0, 1 1)");
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("malformed_wkt");
    expect(result.issues[0].fix).toBeTruthy();
  });

  it("enforces a type expectation against a WKT geometry", () => {
    const result = guardGeometry("POINT(-122.42 37.77)", { type: ["Polygon", "MultiPolygon"] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "geometry_type_mismatch")).toBe(true);
  });

  it("warns when EWKT declares a non-WGS84 SRID", () => {
    const result = guardGeometry("SRID=3857;POINT(-13627732 4546985)");
    expect(result.issues.some((i) => i.code === "non_geographic_srid")).toBe(true);
  });

  it("catches a self-intersecting polygon expressed as KML", () => {
    const kml = `<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,1 1,0 0,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    const result = guardGeometry(kml);
    expect(result.ok).toBe(false);
    expect(result.format).toBe("kml");
    expect(result.issues.some((i) => i.code === "self_intersection")).toBe(true);
  });

  it("validates a clean GML polygon", () => {
    const gml = `<gml:Polygon xmlns:gml="http://www.opengis.net/gml"><gml:exterior><gml:LinearRing><gml:posList>0 0 0 1 1 1 1 0 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>`;
    const result = guardGeometry(gml, { type: "Polygon" });
    expect(result.ok).toBe(true);
    expect(result.format).toBe("gml");
  });
});

describe("guardToolCall with mixed-format arguments", () => {
  it("accepts one GeoJSON and one WKT argument in the same call", () => {
    const args = {
      geometry_a: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
      geometry_b: "POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))",
    };
    const result = guardToolCall(args);
    expect(result.ok).toBe(true);
    expect(result.formats).toEqual({ geometry_a: "geojson", geometry_b: "wkt" });
    expect(result.normalized?.geometry_b).toEqual({
      type: "Polygon",
      coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
    });
  });

  it("leaves an unrelated string argument untouched", () => {
    const args = { geometry: "POINT(1 2)", label: "some parcel" };
    const result = guardToolCall(args);
    expect(result.ok).toBe(true);
    expect(result.normalized?.label).toBe("some parcel");
    expect(result.formats).toEqual({ geometry: "wkt" });
  });
});
