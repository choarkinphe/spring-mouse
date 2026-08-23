import fs from "node:fs";
import path from "node:path";
import maxmind from "maxmind";
import { DATA_DIR } from "@/lib/dataDir.js";

const DEFAULT_GEOIP_DIR = path.join(DATA_DIR, "geoip");
const RECHECK_INTERVAL_MS = 60 * 1000;

const readers = {
  city: { reader: null, filePath: null, mtimeMs: 0, checkedAt: 0, loading: null },
  asn: { reader: null, filePath: null, mtimeMs: 0, checkedAt: 0, loading: null },
};

function configuredPath(kind) {
  const explicit = kind === "city" ? process.env.GEOIP_CITY_PATH : process.env.GEOIP_ASN_PATH;
  if (explicit) return explicit;

  const dataDir = process.env.GEOIP_DATA_DIR || DEFAULT_GEOIP_DIR;
  const filename = kind === "city" ? "GeoLite2-City.mmdb" : "GeoLite2-ASN.mmdb";
  return path.join(dataDir, filename);
}

function safeName(names) {
  return names?.["zh-CN"] || names?.zh || names?.en || null;
}

function geoLabel(geo) {
  return [geo?.city, geo?.region, geo?.country].filter(Boolean).join(" · ") || null;
}

async function getReader(kind) {
  const state = readers[kind];
  const now = Date.now();
  if (state.loading) return state.loading;
  if (now - state.checkedAt < RECHECK_INTERVAL_MS) return state.reader;
  state.checkedAt = now;

  const filePath = configuredPath(kind);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    state.reader = null;
    state.filePath = filePath;
    state.mtimeMs = 0;
    return null;
  }

  if (state.reader && state.filePath === filePath && state.mtimeMs === stat.mtimeMs) return state.reader;

  state.loading = maxmind.open(filePath, { cache: { max: 10_000 } })
    .then((reader) => {
      state.reader = reader;
      state.filePath = filePath;
      state.mtimeMs = stat.mtimeMs;
      return reader;
    })
    .catch((error) => {
      console.warn(`[GEOIP] Failed to load ${kind} database at ${filePath}: ${error.message}`);
      state.reader = null;
      state.filePath = filePath;
      state.mtimeMs = 0;
      return null;
    })
    .finally(() => { state.loading = null; });

  return state.loading;
}

/**
 * Enrich an already trusted client IP with local MaxMind GeoLite2 data.
 * Missing databases and lookup failures are intentionally fail-open.
 */
export async function lookupGeoIp(ip) {
  if (!ip || !maxmind.validate(ip)) return null;

  try {
    const [cityReader, asnReader] = await Promise.all([getReader("city"), getReader("asn")]);
    const city = cityReader?.get(ip) || null;
    const asn = asnReader?.get(ip) || null;
    if (!city && !asn) return null;

    const geo = {
      country: safeName(city?.country?.names),
      countryCode: city?.country?.iso_code || null,
      region: safeName(city?.subdivisions?.[0]?.names),
      regionCode: city?.subdivisions?.[0]?.iso_code || null,
      city: safeName(city?.city?.names),
      timezone: city?.location?.time_zone || null,
      asn: asn?.autonomous_system_number || null,
      organization: asn?.autonomous_system_organization || null,
    };
    return { ...geo, label: geoLabel(geo) };
  } catch {
    return null;
  }
}

export function getGeoIpStatus() {
  const cityPath = configuredPath("city");
  const asnPath = configuredPath("asn");
  return {
    dataDir: process.env.GEOIP_DATA_DIR || DEFAULT_GEOIP_DIR,
    cityPath,
    asnPath,
    cityAvailable: fs.existsSync(cityPath),
    asnAvailable: fs.existsSync(asnPath),
  };
}
