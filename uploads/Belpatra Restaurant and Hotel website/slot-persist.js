/**
 * slot-persist.js v8 — SAFE persistence. Never deletes data on upgrade.
 * DB version is FIXED at 1 forever. Single-record fast storage.
 * Load BEFORE image-slot.js.
 */
(function () {
  var SIDECAR  = '.image-slots.state.json';
  var LS_KEY   = '__belpatra_slots';
  var DB_NAME  = 'belpatra_slots_v8'; // new name = fresh start, safe
  var DB_VER   = 1;                   // NEVER change this
  var STORE    = 'data';
  var ALL_KEY  = 'all';

  /* ── In-memory cache ─────────────────────────────────────────────────── */
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

  /* ── IndexedDB: single-record ─────────────────────────────────────────── */
  var _db = null;
  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function (e) {
        // Only create — never delete
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
    }).catch(function () {
      try { return JSON.parse(localStorage.getItem(LS_KEY)||'{}'); } catch(e) { return {}; }
    });
  }
  function dbWrite(newData) {
    updateCache(newData);
    var toWrite = _cache;
    return openDB().then(function (d) {
      return new Promise(function (res) {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(toWrite, ALL_KEY);
        tx.oncomplete = res; tx.onerror = res;
      });
    }).catch(function () {
      try { localStorage.setItem(LS_KEY, JSON.stringify(toWrite)); } catch(e) {}
    });
  }

  /* ── Seed from sidecar on first run (restore lost images) ────────────── */
  getCached().then(function (existing) {
    var hasData = existing && Object.keys(existing).length > 0;
    if (hasData) return; // already have data, skip
    // Try to load from sidecar file as seed
    fetch(SIDECAR + '?seed=1')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (sd) { if (sd && Object.keys(sd).length) dbWrite(sd); })
      .catch(function () {});
  });

  /* ── Also migrate any localStorage data ─────────────────────────────── */
  try {
    var lsRaw = localStorage.getItem(LS_KEY);
    if (lsRaw) {
      var lsData = JSON.parse(lsRaw);
      if (Object.keys(lsData).length > 0) {
        dbWrite(lsData).then(function () {
          try { localStorage.removeItem(LS_KEY); } catch(e) {}
        });
      }
    }
  } catch(e) {}

  /* ── Pre-warm cache ───────────────────────────────────────────────────── */
  getCached();

  function makeResponse(obj) {
    return new Response(JSON.stringify(obj), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  /* ── Patch omelette.writeFile ────────────────────────────────────────── */
  var _pSet = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  function patchOmelette(om) {
    if (!om) return;
    if (_pSet) { if (_pSet.has(om)) return; _pSet.add(om); }
    else { if (om.__sp8) return; try { om.__sp8 = true; } catch(e){} }
    var orig; try { orig = om.writeFile; } catch(e) {}
    var patched = function (path, data) {
      if (path === SIDECAR) {
        try { dbWrite(JSON.parse(data)); } catch(e) {}
      }
      return orig ? orig.call(om, path, data) : Promise.resolve();
    };
    try {
      Object.defineProperty(om, 'writeFile', { configurable:true, writable:true, value: patched });
    } catch(e) { try { om.writeFile = patched; } catch(e2){} }
  }

  var _om = window.omelette;
  if (_om) patchOmelette(_om);
  try {
    Object.defineProperty(window, 'omelette', {
      configurable: true,
      get: function () { return _om; },
      set: function (v) { _om = v; patchOmelette(v); }
    });
  } catch(e) {}

  /* ── DOM sync ────────────────────────────────────────────────────────── */
  function syncSlotsFromDOM() {
    try {
      var changed = {};
      document.querySelectorAll('image-slot[id]').forEach(function (el) {
        var u = el._userUrl;
        if (!el.id || !u || !/^data:image\//i.test(u)) return;
        var v = el._view || {};
        changed[el.id] = { u:u, s:Number(v.s)||1, x:Number(v.x)||0, y:Number(v.y)||0 };
      });
      if (Object.keys(changed).length) dbWrite(changed);
    } catch(e) {}
  }

  /* ── MutationObserver ────────────────────────────────────────────────── */
  function startObserver() {
    if (!window.MutationObserver) return;
    var mo = new MutationObserver(function () { setTimeout(syncSlotsFromDOM, 300); });
    mo.observe(document.documentElement, {
      subtree:true, attributes:true,
      attributeFilter:['data-filled','src'], childList:true
    });
  }
  if (document.body) { startObserver(); syncSlotsFromDOM(); }
  else document.addEventListener('DOMContentLoaded', function () { startObserver(); syncSlotsFromDOM(); });

  document.addEventListener('drop', function () {
    setTimeout(syncSlotsFromDOM, 800);
    setTimeout(syncSlotsFromDOM, 2500);
    setTimeout(syncSlotsFromDOM, 5000);
  }, true);
  document.addEventListener('change', function (e) {
    if (e.target && e.target.type === 'file') {
      setTimeout(syncSlotsFromDOM, 800);
      setTimeout(syncSlotsFromDOM, 2500);
    }
  }, true);

  /* ── Prevent anchor nav on file drop ────────────────────────────────── */
  document.addEventListener('dragover', function (e) { e.preventDefault(); }, false);
  document.addEventListener('drop', function (e) {
    var el = e.target;
    while (el && el !== document) {
      if (el.tagName && el.tagName.toLowerCase() === 'image-slot') return;
      el = el.parentElement;
    }
    e.preventDefault();
  }, false);

  /* ── Patch fetch: serve from memory cache ────────────────────────────── */
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : ((input && input.url) || '');
    var isSidecar = url === SIDECAR || url.endsWith('/'+SIDECAR);
    // Skip our seed fetch
    if (url.includes(SIDECAR+'?seed=1')) return origFetch(input, init);
    if (isSidecar) {
      return getCached().then(function (data) {
        if (data && Object.keys(data).length > 0) return makeResponse(data);
        return origFetch(input, init)
          .then(function (r) { return r.ok ? r.json() : {}; })
          .catch(function () { return {}; })
          .then(function (sd) { if (sd && Object.keys(sd).length) dbWrite(sd); return makeResponse(sd||{}); });
      });
    }
    return origFetch(input, init);
  };
})();
