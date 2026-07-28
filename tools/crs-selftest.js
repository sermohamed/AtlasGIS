#!/usr/bin/env node
/**
 * Smoke-tests AtlasCRS against vendor/proj4 without a browser.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const root = path.join(__dirname, '..');

function loadScript(rel) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

global.window = global;
loadScript('vendor/proj4.js');
loadScript('crs/atlas-crs.data.js');
loadScript('crs/atlas-crs.js');

const CRS = global.AtlasCRS;
if (!CRS.isReady()) CRS.bootstrap(global.__ATLAS_CRS_DATA__, global.proj4);

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.error('FAIL', msg); }
  else console.log('ok  ', msg);
}

assert(CRS.getCRS(4326) && CRS.getCRS('wgs84').epsg === 4326, 'getCRS wgs84/4326');
assert(CRS.getCRS('lambert-maroc-1').epsg === 26191, 'legacy alias lambert-maroc-1');
assert(CRS.getCRS('EPSG:26191').id === 'lambert-maroc-1', 'EPSG:26191 resolves');

const ma = CRS.getCRSByCountry('MA');
assert(ma.length >= 4 && ma[0].epsg === 26191, 'MA country list priority');

const utm = CRS.generateUTM(33.5, -7.6);
assert(utm.zone === 29 && utm.hemisphere === 'N' && utm.epsg === 32629, 'UTM Casablanca → 29N');

const [x, y] = CRS.convert([-7.6, 33.5], 'wgs84', 'lambert-maroc-1');
assert(isFinite(x) && isFinite(y) && x > 100000 && y > 100000, 'WGS84 → Lambert Maroc');
const [lon, lat] = CRS.convert([x, y], 'lambert-maroc-1', 'wgs84');
assert(Math.abs(lon + 7.6) < 1e-5 && Math.abs(lat - 33.5) < 1e-5, 'round-trip Lambert');

const fr = CRS.searchCRS('Lambert-93');
assert(fr.some((d) => d.epsg === 2154), 'searchCRS finds 2154');

const near = CRS.getCRSFromLocation(33.5, -7.6, { country: 'MA' });
assert(near[0].epsg === 26191, 'location+country prefers Zone 1');

const ui = CRS.listForUi({ country: 'MA' });
assert(ui.some((c) => c.id === 'wgs84') && ui.some((c) => c.id === 'lambert-maroc-1'), 'listForUi MA');

const casablanca = CRS.suggestForLocation(33.5, -7.6);
assert(casablanca.country === 'MA' && casablanca.crs.epsg === 26191, 'suggest Casablanca → MA Zone1');
const paris = CRS.suggestForLocation(48.8566, 2.3522);
assert(paris.country === 'FR' && paris.crs.epsg === 2154, 'suggest Paris → FR Lambert-93');
const madrid = CRS.suggestForLocation(40.4168, -3.7038);
assert(madrid.country === 'ES' && [25830, 25829, 25831].includes(madrid.crs.epsg), 'suggest Madrid → ES UTM');
const agadir = CRS.suggestForLocation(30.4278, -9.5981);
assert(agadir.country === 'MA' && agadir.crs.epsg === 26192, 'suggest Agadir → MA Zone2');

process.exit(failed ? 1 : 0);
