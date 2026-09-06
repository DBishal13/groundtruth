/**
 * Generates the Shapefile and GeoPackage fixtures in this directory.
 * Run with `npx tsx examples/fixtures/generate-binary-fixtures.ts` if you
 * need to regenerate them — they're committed as binary files since a
 * .shp/.gpkg can't be hand-written the way a .wkt/.kml file can.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildShp, buildGeoPackage } from "../../bench/fixtures.js";

const dir = import.meta.dirname;

// San Francisco test parcel, correctly ordered [lon, lat] and CCW-wound.
const parcel: [number, number][] = [
  [-122.42, 37.77],
  [-122.41, 37.77],
  [-122.41, 37.78],
  [-122.42, 37.78],
  [-122.42, 37.77],
];
const bowtie: [number, number][] = [[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]];

async function main() {
  writeFileSync(join(dir, "shapefile-valid.shp"), buildShp(parcel));
  writeFileSync(join(dir, "shapefile-invalid-self-intersecting.shp"), buildShp(bowtie));

  writeFileSync(
    join(dir, "geopackage-mixed-one-bad.gpkg"),
    await buildGeoPackage([
      { geojson: { type: "Polygon", coordinates: [parcel] } },
      { geojson: { type: "Point", coordinates: [200, 200] } }, // out-of-range lon
    ]),
  );

  console.log("Generated shapefile-valid.shp, shapefile-invalid-self-intersecting.shp, geopackage-mixed-one-bad.gpkg");
}

main();
