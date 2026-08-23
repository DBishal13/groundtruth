import proj4 from "proj4";

export interface ResolvedCRS {
  input: string;
  epsg: number;
  name: string;
  proj4def: string;
}

/**
 * Curated aliases for the CRS strings LLMs actually emit — full names, loose
 * casing, common abbreviations — not the EPSG registry's canonical labels.
 */
const ALIASES: Record<string, { epsg: number; name: string; def: string }> = {
  "wgs84": { epsg: 4326, name: "WGS 84", def: "+proj=longlat +datum=WGS84 +no_defs" },
  "wgs 84": { epsg: 4326, name: "WGS 84", def: "+proj=longlat +datum=WGS84 +no_defs" },
  "epsg:4326": { epsg: 4326, name: "WGS 84", def: "+proj=longlat +datum=WGS84 +no_defs" },
  "4326": { epsg: 4326, name: "WGS 84", def: "+proj=longlat +datum=WGS84 +no_defs" },
  "web mercator": {
    epsg: 3857,
    name: "WGS 84 / Pseudo-Mercator",
    def: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs",
  },
  "pseudo-mercator": {
    epsg: 3857,
    name: "WGS 84 / Pseudo-Mercator",
    def: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs",
  },
  "epsg:3857": {
    epsg: 3857,
    name: "WGS 84 / Pseudo-Mercator",
    def: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs",
  },
  "3857": {
    epsg: 3857,
    name: "WGS 84 / Pseudo-Mercator",
    def: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs",
  },
  "nad83": { epsg: 4269, name: "NAD83", def: "+proj=longlat +datum=NAD83 +no_defs" },
  "epsg:4269": { epsg: 4269, name: "NAD83", def: "+proj=longlat +datum=NAD83 +no_defs" },
  "4269": { epsg: 4269, name: "NAD83", def: "+proj=longlat +datum=NAD83 +no_defs" },
  "british national grid": {
    epsg: 27700,
    name: "OSGB36 / British National Grid",
    def: "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs",
  },
  "osgb36": {
    epsg: 27700,
    name: "OSGB36 / British National Grid",
    def: "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs",
  },
  "epsg:27700": {
    epsg: 27700,
    name: "OSGB36 / British National Grid",
    def: "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs",
  },
};

const EPSG_CODE_RE = /^(?:epsg:)?(\d{4,5})$/i;
// Matches strings like "UTM zone 33N", "UTM 33S", "WGS84 UTM zone 10N"
const UTM_RE = /utm\s*(?:zone\s*)?(\d{1,2})\s*([ns])/i;

function utmToEpsg(zone: number, hemisphere: "n" | "s"): ResolvedCRS {
  const epsg = hemisphere === "n" ? 32600 + zone : 32700 + zone;
  const def = `+proj=utm +zone=${zone}${hemisphere === "s" ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
  return {
    input: `UTM zone ${zone}${hemisphere.toUpperCase()}`,
    epsg,
    name: `WGS 84 / UTM zone ${zone}${hemisphere.toUpperCase()}`,
    proj4def: def,
  };
}

/**
 * Resolve a free-form CRS string (as an LLM would write it) to a canonical
 * EPSG code and a proj4 definition, registering the definition with proj4
 * as a side effect so reprojection can use it immediately.
 *
 * Returns null when the string can't be confidently resolved — callers
 * should treat that as a hard stop, not a guess.
 */
export function resolveCRS(input: string): ResolvedCRS | null {
  if (!input || typeof input !== "string") return null;
  const key = input.trim().toLowerCase();

  const alias = ALIASES[key];
  if (alias) {
    const resolved: ResolvedCRS = { input, epsg: alias.epsg, name: alias.name, proj4def: alias.def };
    registerWithProj4(resolved);
    return resolved;
  }

  const epsgMatch = key.match(EPSG_CODE_RE);
  if (epsgMatch) {
    const code = Number(epsgMatch[1]);
    const byCode = Object.values(ALIASES).find((a) => a.epsg === code);
    if (byCode) {
      const resolved: ResolvedCRS = { input, epsg: byCode.epsg, name: byCode.name, proj4def: byCode.def };
      registerWithProj4(resolved);
      return resolved;
    }
    // Unknown EPSG code with no local def — can't reproject without a
    // registry lookup we don't have offline. Fail closed.
    return null;
  }

  const utmMatch = key.match(UTM_RE);
  if (utmMatch) {
    const zone = Number(utmMatch[1]);
    const hemisphere = utmMatch[2].toLowerCase() as "n" | "s";
    if (zone >= 1 && zone <= 60) {
      const resolved = utmToEpsg(zone, hemisphere);
      registerWithProj4(resolved);
      return resolved;
    }
  }

  return null;
}

function registerWithProj4(crs: ResolvedCRS): void {
  proj4.defs(`EPSG:${crs.epsg}`, crs.proj4def);
}

/** Reproject a single [x, y] coordinate pair between two resolved CRSs. */
export function reprojectPoint(point: [number, number], from: ResolvedCRS, to: ResolvedCRS): [number, number] {
  const result = proj4(`EPSG:${from.epsg}`, `EPSG:${to.epsg}`, point);
  return [result[0], result[1]];
}
