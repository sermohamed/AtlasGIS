/* global window */
(function (global) {
  'use strict';

  function wireTerraDrawAdapter(config) {
    if (!config || !config.td || typeof config.td.on !== 'function') return;

    var td = config.td;
    var promptedTerraIds = new Set();

    function findTdSnapshotFeature(snapshot, terraId) {
      return (snapshot || []).find(function (x) { return config.terraIdMatch(x.id, terraId); });
    }

    function findStoreFeatureByTerraId(terraId) {
      return (config.state.features || []).find(function (x) {
        return x.geojson && x.geojson.properties &&
          config.terraIdMatch(x.geojson.properties._terraId, terraId);
      });
    }

    function promptFeatureNameOnce(terraId, featureId) {
      var tidKey = (terraId == null) ? String(featureId) : String(terraId);
      if (promptedTerraIds.has(tidKey)) return;
      promptedTerraIds.add(tidKey);
      config.promptFeatureName(featureId);
    }

    function createStoreFeatureFromTd(terraId, tdFeature, ctxMode) {
      var mode = (tdFeature.properties && tdFeature.properties.mode) || ctxMode || '';
      var kind = config.kindFromGeom(tdFeature.geometry, mode);
      var newF = config.addFeature({
        type: 'Feature',
        geometry: tdFeature.geometry,
        properties: { _terraId: terraId },
      }, kind);
      config.selectFeature(newF.id, { additive: false });
      promptFeatureNameOnce(terraId, newF.id);
      return newF;
    }

    function isCompletedTdFeature(tdFeature) {
      if (!tdFeature || !tdFeature.geometry) return false;
      var mode = (tdFeature.properties && tdFeature.properties.mode) || '';
      var g = tdFeature.geometry;
      if (mode === 'point') return g.type === 'Point';
      if (g.type === 'LineString') {
        if (!Array.isArray(g.coordinates) || g.coordinates.length < 2) return false;
        var a = g.coordinates[0];
        return g.coordinates.some(function (p) { return p && a && (p[0] !== a[0] || p[1] !== a[1]); });
      }
      if (g.type === 'Polygon') {
        if (!Array.isArray(g.coordinates) || !Array.isArray(g.coordinates[0]) || g.coordinates[0].length < 4) return false;
        var ring = g.coordinates[0];
        var first = ring[0];
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < ring.length; i++) {
          var p = ring[i];
          if (!p) continue;
          if (p[0] < minX) minX = p[0];
          if (p[1] < minY) minY = p[1];
          if (p[0] > maxX) maxX = p[0];
          if (p[1] > maxY) maxY = p[1];
        }
        // Circle mode starts with a tiny seed polygon after first tap. Do not
        // treat that as completed; wait for a user-sized circle.
        if (mode === 'circle') {
          var areaSeed = Math.abs((maxX - minX) * (maxY - minY));
          if (areaSeed < 1e-8) return false;
        }
        var spreadOk = (maxX - minX) > 1e-10 || (maxY - minY) > 1e-10;
        var notAllSame = ring.some(function (p) { return p && first && (p[0] !== first[0] || p[1] !== first[1]); });
        return spreadOk && notAllSame;
      }
      return false;
    }

    // TerraDraw can repaint its native blue select highlight asynchronously.
    // To keep the app's yellow halo as the single selection cue (outside edit),
    // clear native selection immediately and again on the next frames.
    function suppressNativeBlueSelection() {
      if (config.isEditActive()) return;
      if (typeof td.deselect !== 'function') return;
      try { td.deselect(); } catch (_) {}
      requestAnimationFrame(function () {
        try { td.deselect(); } catch (_) {}
      });
      setTimeout(function () {
        try { td.deselect(); } catch (_) {}
      }, 0);
      setTimeout(function () {
        try { td.deselect(); } catch (_) {}
      }, 32);
      if (typeof config.triggerRepaint === 'function') config.triggerRepaint();
    }

    function forceYellowHaloOnTop() {
      if (typeof config.forceYellowHalo !== 'function') return;
      try { config.forceYellowHalo(); } catch (_) {}
      requestAnimationFrame(function () {
        try { config.forceYellowHalo(); } catch (_) {}
      });
      setTimeout(function () {
        try { config.forceYellowHalo(); } catch (_) {}
      }, 0);
      setTimeout(function () {
        try { config.forceYellowHalo(); } catch (_) {}
      }, 32);
      setTimeout(function () {
        try { config.forceYellowHalo(); } catch (_) {}
      }, 96);
    }

    td.on('finish', function (id, ctx) {
      config.clearFirstVertex();
      try {
        config.log.info('[HydraulicGIS] terra-draw finish:', id, 'action=' + (ctx && ctx.action));
        var action = ctx && ctx.action;
        var snap = td.getSnapshot();
        var f = findTdSnapshotFeature(snap, id);
        if (!f) return;

        var existing = findStoreFeatureByTerraId(id);
        if (existing) {
          existing.geojson.geometry = f.geometry;
          existing.metrics = config.computeMetrics(existing.geojson, existing.kind);
          existing.updatedAt = Date.now();
          config.notifyFeatures();
          config.triggerRepaint();
          config.log.info('[HydraulicGIS] synced geometry for existing feature', existing.id, 'on action=' + action);
          return;
        }

        if (action && action !== 'draw') {
          config.log.warn('[HydraulicGIS] finish with action=' + action + ' but no matching row — creating row anyway');
        }
        var newF = createStoreFeatureFromTd(id, f, ctx && ctx.mode);
        config.log.info('[HydraulicGIS] added feature', newF.id, 'kind=' + newF.kind);
        config.toggleButtonsWhenNoFeature();
        config.triggerRepaint();
        config.ensureStaticMode();
      } catch (err) {
        config.log.error('[HydraulicGIS] error in finish handler:', err);
      }
    });

    td.on('change', function (ids, type) {
      if (type === 'delete') {
        var banTerraIds = new Set((ids || []).map(String).filter(function (id) {
          // Points are intentionally detached from terra-draw; ignore those deletes.
          var stillInStore = (config.state.features || []).some(function (f) {
            return f.geojson && f.geojson.properties &&
              String(f.geojson.properties._terraId) === id;
          });
          return stillInStore;
        }));
        var toRemove = (config.state.features || [])
          .filter(function (f) {
            return f.geojson && f.geojson.properties &&
              banTerraIds.has(String(f.geojson.properties._terraId));
          })
          .map(function (f) { return f.id; });
        if (toRemove.length) {
          config.log.info('[HydraulicGIS] removing', toRemove.length, 'feature(s) deleted in terra-draw');
          toRemove.forEach(config.removeFeature);
        }
        return;
      }

      if (type !== 'create' && type !== 'update') return;

      var snap = td.getSnapshot();
      var touched = 0;
      (ids || []).forEach(function (tid) {
        var tf = findTdSnapshotFeature(snap, tid);
        if (!tf) return;

        var ours = findStoreFeatureByTerraId(tid);
        if (ours) {
          ours.geojson.geometry = tf.geometry;
          ours.metrics = config.computeMetrics({ type: 'Feature', geometry: tf.geometry }, ours.kind);
          ours.updatedAt = Date.now();
          touched++;
          return;
        }

        var mode = (tf.properties && tf.properties.mode) || '';
        if (type === 'create' && isCompletedTdFeature(tf)) {
          createStoreFeatureFromTd(tid, tf, mode);
        }
      });

      if (touched) {
        config.log.info('[HydraulicGIS] updated', touched, 'feature(s) edited in terra-draw');
        config.notifyFeatures();
      }
    });

    td.on('select', function (terraId) {
      try {
        if (config.ignoreTdSelect === true) {
          suppressNativeBlueSelection();
          forceYellowHaloOnTop();
          return;
        }
        config.hudLog('td.select ' + terraId);
        var ours = findStoreFeatureByTerraId(terraId);
        if (!ours) {
          config.hudLog('  → not found in state');
          return;
        }
        config.selectFeature(ours.id, { additive: config.isMultiSelectMode() });
        suppressNativeBlueSelection();
        forceYellowHaloOnTop();
        config.hudLog('  → sel=[' + config.state.selectedIds.join(',') + ']');
      } catch (e) {
        config.hudLog('  ERR ' + e.message);
      }
    });

    td.on('deselect', function () {});
  }

  global.HGISWireTerraDrawAdapter = wireTerraDrawAdapter;
})(window);
