/**
 * slot-persist.js v11 — retry sidecar fetch, IDB as primary cache.
 * Strips oversized base64 (>100KB) from response — those slots use src= attr.
 * DB name & version LOCKED forever. No writeFile interception.
 */
(function () {
  var SIDECAR = '.image-slots.state.json';
  var DB_NAME = 'belpatra_slots_v8';
  var DB_VER  = 1;
  var STORE   = 'data';
  var ALL_KEY = 'all';
  var MAX_U   = 1048576; // 1MB — strips large PNGs (2-3MB), keeps WebP photos (<500KB) — entries larger than this use src= attribute

  var _cache = null;
  var _cacheP = null;
  function getCached() {
    if (_cache) return Promise.resolve(_cache);
    if (_cacheP) return _cacheP;
    _cacheP = dbRead().then(function (d) { _cache = d || {}; return _cache; });
    return _cacheP;
  }
  function updateCache(data) {
    if (!_cache) _cache = {};
    var k = Object.keys(data);
    for (var i = 0; i < k.length; i++) _cache[k[i]] = data[k[i]];
  }

  var _db = null;
  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function (e) {
        if (!e.target.result.objectStoreNames.contains(STORE))
          e.target.result.createObjectStore(STORE);
      };
      r.onsuccess = function (e) { _db = e.target.result; res(_db); };
      r.onerror   = function () { rej(r.error); };
    });
  }
  function dbRead() {
    return openDB().then(function (d) {
      return new Promise(function (res) {
        var tx = d.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(ALL_KEY);
        req.onsuccess = function () { res(req.result || {}); };
        req.onerror   = function () { res({}); };
      });
    }).catch(function () { return {}; });
  }
  function dbWrite(newData) {
    return getCached().then(function () {
      updateCache(newData);
      var toWrite = _cache;
      return openDB().then(function (d) {
        return new Promise(function (res) {
          var tx = d.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(toWrite, ALL_KEY);
          tx.oncomplete = res; tx.onerror = res;
        });
      });
    }).catch(function () {});
  }

  getCached();

  document.addEventListener('dragover', function (e) { e.preventDefault(); }, false);
  document.addEventListener('drop', function (e) {
    var el = e.target;
    while (el && el !== document) {
      if (el.tagName && el.tagName.toLowerCase() === 'image-slot') return;
      el = el.parentElement;
    }
    e.preventDefault();
  }, false);

  var _nativeFetch = window.fetch.bind(window);
  var _mergeP = null;
  var _isFetchingSidecar = false;

  function fetchSidecarDirect() {
    return _nativeFetch(SIDECAR + '?_v=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (d) {
        return d || {};
      });
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : ((input && input.url) || '');
    var isSidecar = !_isFetchingSidecar && (
      url === SIDECAR ||
      url.endsWith('/' + SIDECAR) ||
      (url.indexOf(SIDECAR) !== -1 && url.indexOf('?') === -1)
    );

    if (isSidecar) {
      if (!_mergeP) {
        _isFetchingSidecar = true;
        _mergeP = Promise.all([fetchSidecarDirect(), getCached()])
          .then(function (results) {
            _isFetchingSidecar = false;
            var sc  = results[0] || {};
            var idb = results[1] || {};
            var merged = Object.assign({}, sc, idb);
            var scOnly = Object.keys(sc).filter(function (k) { return !idb[k]; });
            if (scOnly.length > 0) dbWrite(merged);
            // Strip oversized base64 — those slots use src= file references
            var slim = {};
            Object.keys(merged).forEach(function (k) {
              var e = merged[k];
              if (e && e.u && e.u.length > MAX_U) {
                slim[k] = { s: e.s || 1, x: e.x || 0, y: e.y || 0 };
              } else {
                slim[k] = e;
              }
            });
            return slim;
          })
          .catch(function () { _isFetchingSidecar = false; return {}; });
      }
      return _mergeP.then(function (data) {
        return new Response(JSON.stringify(data || {}), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      });
    }
    return _nativeFetch(input, init);
  };
})();
