#!/usr/bin/env node
/**
 * Regenerates crs/atlas-crs.data.js then runs tools/crs-selftest.js.
 * Use after editing crs/data/*.json.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');

function run(script) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', script)], {
    cwd: root, stdio: 'inherit',
  });
  if (r.status) process.exit(r.status || 1);
}

run('embed-crs-data.js');
run('crs-selftest.js');
