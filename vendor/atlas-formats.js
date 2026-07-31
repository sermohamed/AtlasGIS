/**
 * Browser-side DXF + shapefile helpers for Atlas GIS.
 * DXF: pure ASCII (AutoCAD-compatible). Native DWG is not available in-browser.
 * SHP: uses JSZip (if loaded) + a minimal shapefile writer; import via shpjs when present.
 */
(function (global) {
  'use strict';

  function groupNameOf(f, groups) {
    if (!f || !f.groupId) return '';
    const g = (groups || []).find((x) => x.id === f.groupId);
    return g ? g.name : '';
  }

  function exportProps(f, groups) {
    const m = f.metrics || {};
    const isPoly = m.areaSquareMeters !== undefined;
    return {
      id: f.id,
      name: f.name,
      kind: f.kind,
      groupId: f.groupId || null,
      groupName: groupNameOf(f, groups),
      style: f.style || {},
      metrics: m,
      lengthMeters: m.lengthMeters,
      areaSquareMeters: m.areaSquareMeters,
      perimeterMeters: isPoly ? m.lengthMeters : undefined,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    };
  }

  /* ─── DXF ─────────────────────────────────────────────────────────────── */
  function dxfPair(code, value) {
    return String(code) + '\n' + String(value) + '\n';
  }
  function featuresToDxf(features, groups) {
    let out = '';
    out += dxfPair(0, 'SECTION') + dxfPair(2, 'HEADER');
    out += dxfPair(9, '$ACADVER') + dxfPair(1, 'AC1014');
    out += dxfPair(0, 'ENDSEC');
    out += dxfPair(0, 'SECTION') + dxfPair(2, 'TABLES');
    out += dxfPair(0, 'TABLE') + dxfPair(2, 'LAYER') + dxfPair(70, features.length || 1);
    const layers = new Set();
    features.forEach((f) => {
      const ln = (groupNameOf(f, groups) || '0').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 31) || '0';
      layers.add(ln);
    });
    if (!layers.size) layers.add('0');
    layers.forEach((ln) => {
      out += dxfPair(0, 'LAYER') + dxfPair(2, ln) + dxfPair(70, 0) + dxfPair(62, 7) + dxfPair(6, 'CONTINUOUS');
    });
    out += dxfPair(0, 'ENDTAB') + dxfPair(0, 'ENDSEC');
    out += dxfPair(0, 'SECTION') + dxfPair(2, 'ENTITIES');
    features.forEach((f) => {
      const geom = f.geojson && f.geojson.geometry;
      if (!geom) return;
      const layer = (groupNameOf(f, groups) || '0').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 31) || '0';
      const writeVerts = (coords, close) => {
        const pts = coords.slice();
        if (close && pts.length > 1) {
          const a = pts[0], b = pts[pts.length - 1];
          if (a[0] !== b[0] || a[1] !== b[1]) pts.push(a);
        }
        out += dxfPair(0, 'LWPOLYLINE') + dxfPair(8, layer) + dxfPair(90, pts.length) + dxfPair(70, close ? 1 : 0);
        pts.forEach((c) => { out += dxfPair(10, c[0]) + dxfPair(20, c[1]); });
      };
      if (geom.type === 'Point') {
        out += dxfPair(0, 'POINT') + dxfPair(8, layer)
          + dxfPair(10, geom.coordinates[0]) + dxfPair(20, geom.coordinates[1]);
      } else if (geom.type === 'LineString') {
        writeVerts(geom.coordinates, false);
      } else if (geom.type === 'Polygon') {
        writeVerts(geom.coordinates[0] || [], true);
      } else if (geom.type === 'MultiLineString') {
        (geom.coordinates || []).forEach((line) => writeVerts(line, false));
      } else if (geom.type === 'MultiPolygon') {
        (geom.coordinates || []).forEach((poly) => writeVerts(poly[0] || [], true));
      }
    });
    out += dxfPair(0, 'ENDSEC') + dxfPair(0, 'EOF');
    return out;
  }

  function parseDxf(text) {
    const lines = String(text || '').split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      pairs.push({ code: parseInt(lines[i].trim(), 10), value: lines[i + 1] });
    }
    const features = [];
    let i = 0;
    while (i < pairs.length) {
      const p = pairs[i];
      if (p.code === 0 && p.value.trim() === 'POINT') {
        let x = 0, y = 0, layer = '0';
        i++;
        while (i < pairs.length && pairs[i].code !== 0) {
          if (pairs[i].code === 8) layer = pairs[i].value.trim();
          if (pairs[i].code === 10) x = parseFloat(pairs[i].value);
          if (pairs[i].code === 20) y = parseFloat(pairs[i].value);
          i++;
        }
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { name: layer, layer } });
        continue;
      }
      if (p.code === 0 && (p.value.trim() === 'LWPOLYLINE' || p.value.trim() === 'POLYLINE')) {
        const isLw = p.value.trim() === 'LWPOLYLINE';
        let layer = '0', closed = false, verts = [];
        i++;
        while (i < pairs.length && pairs[i].code !== 0) {
          if (pairs[i].code === 8) layer = pairs[i].value.trim();
          if (pairs[i].code === 70) closed = !!(parseInt(pairs[i].value, 10) & 1);
          if (isLw && pairs[i].code === 10) {
            const x = parseFloat(pairs[i].value);
            let y = 0;
            if (i + 1 < pairs.length && pairs[i + 1].code === 20) { y = parseFloat(pairs[i + 1].value); i++; }
            verts.push([x, y]);
          }
          i++;
        }
        // POLYLINE (old) vertices follow as VERTEX entities
        if (!isLw) {
          while (i < pairs.length && pairs[i].code === 0 && pairs[i].value.trim() === 'VERTEX') {
            i++;
            let x = 0, y = 0;
            while (i < pairs.length && pairs[i].code !== 0) {
              if (pairs[i].code === 10) x = parseFloat(pairs[i].value);
              if (pairs[i].code === 20) y = parseFloat(pairs[i].value);
              i++;
            }
            verts.push([x, y]);
          }
          if (i < pairs.length && pairs[i].code === 0 && pairs[i].value.trim() === 'SEQEND') i++;
        }
        if (verts.length >= 2) {
          if (closed) {
            const a = verts[0], b = verts[verts.length - 1];
            if (a[0] !== b[0] || a[1] !== b[1]) verts = verts.concat([a]);
            features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [verts] }, properties: { name: layer, layer } });
          } else {
            features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: verts }, properties: { name: layer, layer } });
          }
        }
        continue;
      }
      i++;
    }
    return { type: 'FeatureCollection', features };
  }

  /* ─── Shapefile (minimal writer) ──────────────────────────────────────── */
  function writeInt32LE(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n, true);
    return b;
  }
  function writeInt32BE(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n, false);
    return b;
  }
  function writeFloat64LE(n) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, true);
    return b;
  }
  function concatBufs(parts) {
    let len = 0;
    parts.forEach((p) => { len += p.length; });
    const out = new Uint8Array(len);
    let o = 0;
    parts.forEach((p) => { out.set(p, o); o += p.length; });
    return out;
  }
  function bboxOfCoords(coords) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
        minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
      } else c.forEach(walk);
    };
    walk(coords);
    return [minX, minY, maxX, maxY];
  }
  function dbfField(name, type, len, dec) {
    const b = new Uint8Array(32);
    for (let i = 0; i < 11; i++) b[i] = name.charCodeAt(i) || 0;
    b[11] = type.charCodeAt(0);
    b[16] = len;
    b[17] = dec || 0;
    return b;
  }
  function buildDbf(rows, fields) {
    const headerLen = 32 + fields.length * 32 + 1;
    const recLen = 1 + fields.reduce((s, f) => s + f.len, 0);
    const parts = [];
    const hdr = new Uint8Array(32);
    hdr[0] = 3;
    const now = new Date();
    hdr[1] = now.getFullYear() - 1900; hdr[2] = now.getMonth() + 1; hdr[3] = now.getDate();
    new DataView(hdr.buffer).setInt32(4, rows.length, true);
    new DataView(hdr.buffer).setInt16(8, headerLen, true);
    new DataView(hdr.buffer).setInt16(10, recLen, true);
    parts.push(hdr);
    fields.forEach((f) => parts.push(dbfField(f.name, f.type, f.len, f.dec)));
    parts.push(new Uint8Array([0x0d]));
    rows.forEach((row) => {
      const rec = new Uint8Array(recLen);
      rec[0] = 0x20;
      let o = 1;
      fields.forEach((f) => {
        let v = row[f.key] == null ? '' : String(row[f.key]);
        if (f.type === 'N') {
          const n = Number(row[f.key]);
          v = isFinite(n) ? n.toFixed(f.dec || 0) : '';
        }
        v = v.slice(0, f.len);
        for (let i = 0; i < f.len; i++) rec[o + i] = v.charCodeAt(i) || 0x20;
        o += f.len;
      });
      parts.push(rec);
    });
    parts.push(new Uint8Array([0x1a]));
    return concatBufs(parts);
  }
  function buildShpShx(features, shapeType) {
    const records = [];
    const boxes = [];
    features.forEach((f, idx) => {
      const g = f.geojson.geometry;
      let content;
      if (shapeType === 1) { // point
        const c = g.coordinates;
        content = concatBufs([writeInt32LE(1), writeFloat64LE(c[0]), writeFloat64LE(c[1])]);
        boxes.push([c[0], c[1], c[0], c[1]]);
      } else if (shapeType === 3) { // polyline
        const parts = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
        const all = parts.reduce((a, p) => a.concat(p), []);
        const bb = bboxOfCoords(all);
        boxes.push(bb);
        const body = [writeInt32LE(3),
          writeFloat64LE(bb[0]), writeFloat64LE(bb[1]), writeFloat64LE(bb[2]), writeFloat64LE(bb[3]),
          writeInt32LE(parts.length), writeInt32LE(all.length)];
        let off = 0;
        parts.forEach((p) => { body.push(writeInt32LE(off)); off += p.length; });
        all.forEach((c) => { body.push(writeFloat64LE(c[0]), writeFloat64LE(c[1])); });
        content = concatBufs(body);
      } else { // polygon 5
        const rings = g.type === 'MultiPolygon'
          ? g.coordinates.map((poly) => poly[0])
          : [g.coordinates[0]];
        const all = rings.reduce((a, p) => a.concat(p), []);
        const bb = bboxOfCoords(all);
        boxes.push(bb);
        const body = [writeInt32LE(5),
          writeFloat64LE(bb[0]), writeFloat64LE(bb[1]), writeFloat64LE(bb[2]), writeFloat64LE(bb[3]),
          writeInt32LE(rings.length), writeInt32LE(all.length)];
        let off = 0;
        rings.forEach((p) => { body.push(writeInt32LE(off)); off += p.length; });
        all.forEach((c) => { body.push(writeFloat64LE(c[0]), writeFloat64LE(c[1])); });
        content = concatBufs(body);
      }
      const recHeader = concatBufs([writeInt32BE(idx + 1), writeInt32BE(content.length / 2)]);
      records.push(concatBufs([recHeader, content]));
    });
    const fileLenWords = 50 + records.reduce((s, r) => s + r.length / 2, 0);
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    boxes.forEach((b) => {
      xmin = Math.min(xmin, b[0]); ymin = Math.min(ymin, b[1]);
      xmax = Math.max(xmax, b[2]); ymax = Math.max(ymax, b[3]);
    });
    if (!isFinite(xmin)) { xmin = ymin = 0; xmax = ymax = 0; }
    const shpHeader = new Uint8Array(100);
    const dv = new DataView(shpHeader.buffer);
    dv.setInt32(0, 9994, false);
    dv.setInt32(24, fileLenWords, false);
    dv.setInt32(28, 1000, true);
    dv.setInt32(32, shapeType, true);
    dv.setFloat64(36, xmin, true); dv.setFloat64(44, ymin, true);
    dv.setFloat64(52, xmax, true); dv.setFloat64(60, ymax, true);
    const shp = concatBufs([shpHeader].concat(records));
    const shxParts = [new Uint8Array(shpHeader)];
    new DataView(shxParts[0].buffer).setInt32(24, 50 + records.length * 4, false);
    let offset = 50;
    records.forEach((r) => {
      shxParts.push(concatBufs([writeInt32BE(offset), writeInt32BE((r.length - 8) / 2)]));
      offset += r.length / 2;
    });
    return { shp, shx: concatBufs(shxParts) };
  }

  async function featuresToShapefileZip(features, groups) {
    if (!global.JSZip) throw new Error('JSZip is required for shapefile export');
    const byType = { point: [], line: [], polygon: [] };
    features.forEach((f) => {
      const g = f.geojson && f.geojson.geometry;
      if (!g) return;
      if (g.type === 'Point') byType.point.push(f);
      else if (g.type === 'LineString' || g.type === 'MultiLineString') byType.line.push(f);
      else if (g.type === 'Polygon' || g.type === 'MultiPolygon') byType.polygon.push(f);
    });
    const zip = new global.JSZip();
    const prj = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
    const fields = [
      { name: 'NAME', type: 'C', len: 80, key: 'name' },
      { name: 'KIND', type: 'C', len: 16, key: 'kind' },
      { name: 'LAYER', type: 'C', len: 40, key: 'layer' },
      { name: 'LENGTH_M', type: 'N', len: 18, dec: 3, key: 'length' },
      { name: 'AREA_M2', type: 'N', len: 18, dec: 3, key: 'area' },
      { name: 'PERIM_M', type: 'N', len: 18, dec: 3, key: 'perim' },
      { name: 'STROKE', type: 'C', len: 16, key: 'stroke' },
      { name: 'FILL', type: 'C', len: 16, key: 'fill' },
    ];
    const addSet = (prefix, list, shapeType) => {
      if (!list.length) return;
      const { shp, shx } = buildShpShx(list, shapeType);
      const rows = list.map((f) => {
        const m = f.metrics || {};
        const isPoly = m.areaSquareMeters !== undefined;
        return {
          name: f.name,
          kind: f.kind,
          layer: groupNameOf(f, groups),
          length: m.lengthMeters,
          area: m.areaSquareMeters,
          perim: isPoly ? m.lengthMeters : '',
          stroke: f.style && f.style.stroke,
          fill: f.style && f.style.fill,
        };
      });
      zip.file(prefix + '.shp', shp);
      zip.file(prefix + '.shx', shx);
      zip.file(prefix + '.dbf', buildDbf(rows, fields));
      zip.file(prefix + '.prj', prj);
    };
    addSet('points', byType.point, 1);
    addSet('lines', byType.line, 3);
    addSet('polygons', byType.polygon, 5);
    if (!byType.point.length && !byType.line.length && !byType.polygon.length) {
      throw new Error('No supported geometries for shapefile export');
    }
    return zip.generateAsync({ type: 'blob' });
  }

  async function parseShapefileZip(arrayBuffer) {
    if (global.shp && typeof global.shp === 'function') {
      const geo = await global.shp(arrayBuffer);
      if (geo.type === 'FeatureCollection') return geo;
      if (Array.isArray(geo)) {
        return { type: 'FeatureCollection', features: geo.flatMap((fc) => (fc && fc.features) || []) };
      }
      if (geo && typeof geo === 'object') {
        const feats = [];
        Object.keys(geo).forEach((k) => {
          const fc = geo[k];
          if (fc && fc.features) feats.push(...fc.features);
        });
        return { type: 'FeatureCollection', features: feats };
      }
    }
    throw new Error('Shapefile import requires shpjs');
  }

  global.AtlasFormats = {
    exportProps,
    featuresToDxf,
    parseDxf,
    featuresToShapefileZip,
    parseShapefileZip,
  };
})(typeof window !== 'undefined' ? window : globalThis);
