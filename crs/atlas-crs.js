/**
 * AtlasCRS — registry + CoordinateTransformer + UTM + country search.
 *
 * UI code must go through this module (never call proj4 directly for CRS work).
 * Seed data lives in crs/data/*.json and is embedded via atlas-crs.data.js.
 */
(function (global) {
  'use strict';

  const WGS84_EPSG = 4326;
  const WEBMERC_EPSG = 3857;

  /** @type {Map<string, object>} id/alias → definition */
  const byId = new Map();
  /** @type {Map<number, object>} epsg → definition */
  const byEpsg = new Map();
  /** @type {Map<string, object[]>} country → [{epsg, priority}] */
  const countryLinks = new Map();
  /** @type {object[]} */
  let countries = [];
  /** @type {string[]} tokens for text search */
  const textIndex = []; // { key, def }

  let proj4fn = null;
  let ready = false;

  function normalizeId(raw) {
    if (raw == null) return '';
    let s = String(raw).trim();
    if (!s) return '';
    // Accept "26191", "EPSG:26191", "epsg:26191"
    const m = s.match(/^(?:EPSG:)?(\d+)$/i);
    if (m) return 'EPSG:' + m[1];
    return s;
  }

  function cloneDef(def) {
    return Object.assign({}, def, {
      aliases: (def.aliases || []).slice(),
      axes: (def.axes || []).slice(),
      bbox: def.bbox ? def.bbox.slice() : null,
    });
  }

  function registerProj(def) {
    if (!proj4fn || !def || !def.proj4) return;
    const keys = new Set([def.id, 'EPSG:' + def.epsg].concat(def.aliases || []));
    keys.forEach((k) => {
      if (!k) return;
      try { proj4fn.defs(k, def.proj4); } catch (_) {}
    });
  }

  function registerDefinition(raw) {
    if (!raw || raw.epsg == null) throw new Error('CRS definition missing epsg');
    const def = cloneDef(raw);
    def.epsg = Number(def.epsg);
    def.id = def.id || ('EPSG:' + def.epsg);
    def.label = def.label || def.name || def.id;
    def.isGeographic = !!def.isGeographic;
    def.axes = def.axes && def.axes.length === 2
      ? def.axes
      : (def.isGeographic ? ['Longitude', 'Latitude'] : ['X (Est)', 'Y (Nord)']);
    def.aliases = def.aliases || [];
    def.deprecated = !!def.deprecated;

    byEpsg.set(def.epsg, def);
    const keys = [def.id, String(def.epsg), 'EPSG:' + def.epsg].concat(def.aliases);
    keys.forEach((k) => {
      const nk = normalizeId(k);
      if (nk) byId.set(nk, def);
      // Also keep the raw lowercase form for legacy ids like "wgs84".
      if (k) byId.set(String(k), def);
      if (k) byId.set(String(k).toLowerCase(), def);
    });
    registerProj(def);

    const hay = [
      def.id, def.name, def.label, 'EPSG:' + def.epsg, def.area_of_use, def.datum, def.projection,
    ].filter(Boolean).join(' ').toLowerCase();
    textIndex.push({ key: hay, def });
    return def;
  }

  function getCRS(epsgOrId) {
    if (epsgOrId == null || epsgOrId === '') return null;
    if (typeof epsgOrId === 'number') return byEpsg.get(epsgOrId) || null;
    const s = String(epsgOrId).trim();
    if (/^\d+$/.test(s)) return byEpsg.get(Number(s)) || null;
    return byId.get(s) || byId.get(normalizeId(s)) || byId.get(s.toLowerCase()) || null;
  }

  function getCRSByCountry(countryCode) {
    const code = String(countryCode || '').toUpperCase();
    const links = countryLinks.get(code) || [];
    return links
      .map((l) => {
        const def = byEpsg.get(l.epsg);
        return def ? Object.assign(cloneDef(def), { priority: l.priority }) : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.priority - b.priority);
  }

  function searchCRS(text, limit) {
    const q = String(text || '').trim().toLowerCase();
    const max = limit == null ? 40 : limit;
    if (!q) {
      return Array.from(byEpsg.values())
        .filter((d) => !d.deprecated && !d._dynamic)
        .slice(0, max)
        .map(cloneDef);
    }
    // Direct EPSG / id hit first.
    const direct = getCRS(text);
    const scored = [];
    if (direct) scored.push({ score: 0, def: direct });
    for (const entry of textIndex) {
      if (direct && entry.def.epsg === direct.epsg) continue;
      const idx = entry.key.indexOf(q);
      if (idx < 0) continue;
      const score = idx === 0 ? 1 : (entry.key.includes('epsg:' + q) ? 2 : 3 + idx);
      scored.push({ score, def: entry.def });
    }
    scored.sort((a, b) => a.score - b.score || a.def.epsg - b.def.epsg);
    const seen = new Set();
    const out = [];
    for (const s of scored) {
      if (seen.has(s.def.epsg)) continue;
      seen.add(s.def.epsg);
      out.push(cloneDef(s.def));
      if (out.length >= max) break;
    }
    return out;
  }

  function bboxCenter(bbox) {
    if (!bbox || bbox.length !== 4) return null;
    return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  }

  function pointInBbox(lon, lat, bbox) {
    if (!bbox || bbox.length !== 4) return false;
    let w = bbox[0], s = bbox[1], e = bbox[2], n = bbox[3];
    // Handle antimeridian spans lightly.
    if (e < w) return lat >= s && lat <= n && (lon >= w || lon <= e);
    return lon >= w && lon <= e && lat >= s && lat <= n;
  }

  function haversineKm(lon1, lat1, lon2, lat2) {
    const R = 6371;
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR;
    const dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /**
   * Suggest CRS for a location.
   * Sort: country priority → bbox containment → distance to bbox centre.
   */
  function getCRSFromLocation(lat, lon, opts) {
    const country = opts && opts.country ? String(opts.country).toUpperCase() : null;
    const limit = opts && opts.limit != null ? opts.limit : 12;
    const countryPri = new Map();
    if (country) {
      (countryLinks.get(country) || []).forEach((l) => countryPri.set(l.epsg, l.priority));
    }

    const candidates = [];
    byEpsg.forEach((def) => {
      if (def.deprecated || def._dynamic) return;
      if (def.epsg === WGS84_EPSG || def.epsg === WEBMERC_EPSG) return;
      const bbox = def.bbox;
      const inBox = pointInBbox(lon, lat, bbox);
      const centre = bboxCenter(bbox);
      const dist = centre ? haversineKm(lon, lat, centre[0], centre[1]) : 1e9;
      const pri = countryPri.has(def.epsg) ? countryPri.get(def.epsg) : 999;
      candidates.push({
        def,
        score: [
          countryPri.has(def.epsg) ? 0 : 1,
          inBox ? 0 : 1,
          pri,
          dist,
        ],
      });
    });

    candidates.sort((a, b) => {
      for (let i = 0; i < a.score.length; i++) {
        if (a.score[i] !== b.score[i]) return a.score[i] - b.score[i];
      }
      return a.def.epsg - b.def.epsg;
    });

    const out = candidates.slice(0, limit).map((c) => cloneDef(c.def));
    // Always offer WGS84 / WebMercator at the end of suggestions.
    [WGS84_EPSG, WEBMERC_EPSG].forEach((epsg) => {
      const d = byEpsg.get(epsg);
      if (d && !out.some((x) => x.epsg === epsg)) out.push(cloneDef(d));
    });
    return out;
  }

  /** Dynamic UTM (WGS84). Never stored as 120 static zones. */
  function generateUTM(lat, lon) {
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error('generateUTM: invalid lat/lon');
    }
    // Norway / Svalbard special cases omitted: rare for this app.
    let zone = Math.floor((lon + 180) / 6) + 1;
    if (zone < 1) zone = 1;
    if (zone > 60) zone = 60;
    const north = lat >= 0;
    const epsg = north ? 32600 + zone : 32700 + zone;
    const hemi = north ? 'N' : 'S';
    const proj4 = '+proj=utm +zone=' + zone + (north ? '' : ' +south')
      + ' +datum=WGS84 +units=m +no_defs';
    const id = 'EPSG:' + epsg;
    const def = {
      epsg,
      id,
      aliases: [],
      name: 'WGS 84 / UTM zone ' + zone + hemi,
      label: 'UTM ' + zone + hemi + ' (EPSG:' + epsg + ')',
      proj4,
      unit: 'metre',
      axis_order: 'enu',
      isGeographic: false,
      axes: ['Easting', 'Northing'],
      bbox: [((zone - 1) * 6) - 180, north ? 0 : -80, (zone * 6) - 180, north ? 84 : 0],
      area_of_use: 'UTM zone ' + zone + hemi,
      datum: 'WGS84',
      projection: 'utm',
      accuracy: 1,
      deprecated: false,
      zone,
      hemisphere: hemi,
      _dynamic: true,
    };
    // Register so convert() can use it immediately.
    if (!byEpsg.has(epsg)) registerDefinition(def);
    else registerProj(def);
    return cloneDef(getCRS(epsg));
  }

  function resolveProjKey(crsOrId) {
    if (crsOrId && typeof crsOrId === 'object' && crsOrId.id) return crsOrId.id;
    const def = getCRS(crsOrId);
    if (!def) throw new Error('CRS inconnu: ' + crsOrId);
    // Prefer the primary id we registered with proj4.
    return def.id;
  }

  /** Single transform entry point. UI must not call proj4. */
  function convert(xy, from, to) {
    if (!proj4fn) throw new Error('AtlasCRS: proj4 non chargé');
    if (!xy || xy.length < 2 || !isFinite(xy[0]) || !isFinite(xy[1])) {
      throw new Error('Coordonnées invalides');
    }
    const fromKey = resolveProjKey(from);
    const toKey = resolveProjKey(to);
    if (fromKey === toKey) return [xy[0], xy[1]];
    // Ensure definitions are registered (covers late dynamic UTM).
    const fromDef = getCRS(from);
    const toDef = getCRS(to);
    if (fromDef) registerProj(fromDef);
    if (toDef) registerProj(toDef);
    const r = proj4fn(fromKey, toKey, [xy[0], xy[1]]);
    if (!r || !isFinite(r[0]) || !isFinite(r[1])) {
      throw new Error('Conversion impossible (' + fromKey + ' → ' + toKey + ')');
    }
    return [r[0], r[1]];
  }

  function toWgs84(xy, from) {
    return convert(xy, from, 'wgs84');
  }

  function fromWgs84(xy, to) {
    return convert(xy, 'wgs84', to);
  }

  /** Compatibility shape used by the existing UI dropdowns. */
  function listForUi(opts) {
    const country = opts && opts.country ? String(opts.country).toUpperCase() : null;
    const includeDynamic = !!(opts && opts.includeDynamic);
    let list;
    if (country && country !== 'XX' && country !== 'ALL') {
      list = getCRSByCountry(country);
      // Always ensure WGS84 is present.
      if (!list.some((d) => d.epsg === WGS84_EPSG)) {
        const w = getCRS(WGS84_EPSG);
        if (w) list = [cloneDef(w)].concat(list);
      }
    } else if (country === 'XX') {
      list = getCRSByCountry('XX');
    } else {
      list = Array.from(byEpsg.values())
        .filter((d) => !d.deprecated && (includeDynamic || !d._dynamic))
        .sort((a, b) => {
          // Prefer Morocco + WGS84 near the top for this app's default audience.
          const rank = (d) => {
            if (d.epsg === WGS84_EPSG) return 0;
            if (d.epsg === 26191) return 1;
            if (String(d.area_of_use || '').toLowerCase().includes('morocco')
                || String(d.name || '').toLowerCase().includes('merchich')) return 2;
            if (d.epsg === WEBMERC_EPSG) return 90;
            return 50;
          };
          return rank(a) - rank(b) || a.epsg - b.epsg;
        })
        .map(cloneDef);
    }
    return list.map((d) => ({
      id: d.id,
      epsg: d.epsg,
      label: d.label,
      name: d.name,
      isGeographic: d.isGeographic,
      axes: d.axes.slice(),
      unit: d.unit,
      axis_order: d.axis_order,
    }));
  }

  function listCountries() {
    return countries.map((c) => Object.assign({}, c));
  }

  function bootstrap(data, proj4Ref) {
    proj4fn = proj4Ref || global.proj4;
    if (!proj4fn) throw new Error('AtlasCRS: proj4 is required');

    byId.clear();
    byEpsg.clear();
    countryLinks.clear();
    textIndex.length = 0;

    countries = (data && data.countries) || [];
    ((data && data.countryCrs) || []).forEach((row) => {
      const code = String(row.country || '').toUpperCase();
      if (!countryLinks.has(code)) countryLinks.set(code, []);
      countryLinks.get(code).push({
        epsg: Number(row.epsg),
        priority: Number(row.priority) || 100,
      });
    });
    countryLinks.forEach((arr) => arr.sort((a, b) => a.priority - b.priority));

    ((data && data.seed) || []).forEach(registerDefinition);

    // Built-in aliases for proj4's own WGS84 token.
    try { proj4fn.defs('wgs84', proj4fn.defs('WGS84')); } catch (_) {}
    ready = true;
    return api;
  }

  function isReady() { return ready; }

  const api = {
    WGS84_EPSG,
    WEBMERC_EPSG,
    bootstrap,
    isReady,
    getCRS,
    getCRSByCountry,
    searchCRS,
    getCRSFromLocation,
    generateUTM,
    convert,
    toWgs84,
    fromWgs84,
    listForUi,
    listCountries,
    registerDefinition,
    /** Future NADGRID hook: register a grid file path/url against a CRS. */
    registerGrid: function registerGrid(_epsg, _gridUrl) {
      // Placeholder — proj4 nadgrids support will plug in here.
      return false;
    },
  };

  // Auto-bootstrap when embedded data + proj4 are already on the page.
  function autoBoot() {
    if (!global.proj4) return false;
    const data = global.__ATLAS_CRS_DATA__;
    if (!data) return false;
    bootstrap(data, global.proj4);
    return true;
  }

  if (typeof document !== 'undefined') {
    // Defer one tick so atlas-crs.data.js can run if loaded after this file.
    if (!autoBoot()) {
      setTimeout(autoBoot, 0);
    }
  } else {
    autoBoot();
  }

  global.AtlasCRS = api;
})(typeof window !== 'undefined' ? window : globalThis);
