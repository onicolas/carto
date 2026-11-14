// Balise - carte de randonnée hors ligne (PWA).
import * as store from './store.js';
import * as geo from './geo.js';

const APP_VERSION = '1.0.0';
const NB = ' ';
const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Fonds de carte IGN (Géoplateforme, WMTS, pyramide Web Mercator "PM")
// ---------------------------------------------------------------------------
const LAYERS = {
  plan: {
    label: 'Plan IGN',
    ign: 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2',
    format: 'image/png',
    base: 'https://data.geopf.fr/wmts',
    priv: false,
    maxzoom: 18,
    levels: [[14, 'Vue d\'ensemble (14)'], [15, 'Intermédiaire (15)'], [16, 'Randonnée (16), recommandé'], [17, 'Détaillé (17)'], [18, 'Très détaillé (18)']],
    def: 16,
    kb: 35
  },
  scan: {
    label: 'SCAN 25',
    ign: 'GEOGRAPHICALGRIDSYSTEMS.MAPS',
    format: 'image/jpeg',
    base: 'https://data.geopf.fr/private/wmts',
    priv: true,
    maxzoom: 16,
    levels: [[14, 'Vue d\'ensemble (14)'], [15, 'Carte au 1:25 000 (15)'], [16, 'Carte au 1:25 000 agrandie (16), recommandé']],
    def: 16,
    kb: 30
  }
};
const ZMIN = 8;             // les petits niveaux de zoom sont toujours inclus (peu de tuiles)
const MAX_TILES = 20000;    // garde-fou : taille de zone et charge sur les serveurs de l'IGN
const TRACK_BUFFER_M = 1000;
const CONCURRENCY = 6;

// ---------------------------------------------------------------------------
// Réglages persistants
// ---------------------------------------------------------------------------
const DEFAULTS = { layer: 'plan', scanKey: '', forceOffline: false, wake: false, view: { center: [2.6, 46.5], zoom: 5 } };
let settings = { ...DEFAULTS };
try {
  settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('balise-settings') || '{}') };
} catch (e) { /* stockage indisponible : réglages par défaut */ }
if (!LAYERS[settings.layer]) settings.layer = 'plan';

function saveSettings() {
  try { localStorage.setItem('balise-settings', JSON.stringify(settings)); } catch (e) { /* ignoré */ }
}

// ---------------------------------------------------------------------------
// Petits utilitaires d'interface
// ---------------------------------------------------------------------------
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'onclick') e.addEventListener('click', v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}

let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const fmtInt = (n) => Math.round(n).toLocaleString('fr-FR');
function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + NB + 'Go';
  if (bytes >= 1e6) return (bytes / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + NB + 'Mo';
  return Math.max(1, Math.round(bytes / 1e3)) + NB + 'ko';
}
function fmtDist(m) {
  if (m >= 1000) return (m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + NB + 'km';
  return Math.round(m) + NB + 'm';
}
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function confirmButton(label, action) {
  const b = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: label });
  let armed = false;
  let timer = null;
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.textContent = 'Confirmer la suppression';
      timer = setTimeout(() => { armed = false; b.textContent = label; }, 3500);
    } else {
      clearTimeout(timer);
      action();
    }
  });
  return b;
}

// ---------------------------------------------------------------------------
// Tuiles : réseau, stockage local, repli sur un niveau de zoom inférieur
// ---------------------------------------------------------------------------
let netDownUntil = 0;
let netRetryTimer = null;
let deniedKey = null;      // clé SCAN 25 refusée par le serveur : on n'insiste pas

// Tuile transparente renvoyée quand rien n'est disponible : le fond de la carte reste visible.
const BLANK_TILE = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGBgAAAABQABeqhXUAAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function isOffline() {
  return settings.forceOffline || !navigator.onLine;
}

function canUseNetwork(layerId) {
  if (isOffline()) return false;
  if (Date.now() < netDownUntil) return false;
  if (LAYERS[layerId].priv && (!settings.scanKey || settings.scanKey === deniedKey)) return false;
  return true;
}

function tileUrl(layerId, z, x, y) {
  const L = LAYERS[layerId];
  const p = new URLSearchParams({
    SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0',
    LAYER: L.ign, STYLE: 'normal', FORMAT: L.format,
    TILEMATRIXSET: 'PM', TILEMATRIX: z, TILEROW: y, TILECOL: x
  });
  if (L.priv) p.set('apikey', settings.scanKey);
  return L.base + '?' + p.toString();
}

// Renvoie { status: 'ok', buf } | { status: 'absent' } | { status: 'denied' }.
// Lève une erreur en cas de panne réseau ou de réponse temporaire (429, 5xx).
async function fetchTile(layerId, z, x, y, signal, timeoutMs) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(tileUrl(layerId, z, x, y), { signal: ctrl.signal, mode: 'cors', credentials: 'omit' });
    if (res.status === 401 || res.status === 403) return { status: 'denied' };
    if (res.status === 429 || res.status >= 500) throw new Error('Serveur indisponible (' + res.status + ')');
    if (!res.ok || res.status === 204) return { status: 'absent' };
    const type = res.headers.get('content-type') || '';
    if (type && !type.startsWith('image/')) return { status: 'absent' };
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) return { status: 'absent' };
    return { status: 'ok', buf };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function decodeImage(buf) {
  const blob = new Blob([buf]);
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch (e) { /* repli ci-dessous */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible')); };
    img.src = url;
  });
}

// Hors couverture téléchargée à ce zoom : agrandit la tuile d'un niveau inférieur.
async function scaleFromAncestor(layerId, z, x, y) {
  for (let d = 1; d <= 6 && z - d >= 0; d++) {
    const buf = await store.getTile(layerId + '/' + (z - d) + '/' + (x >> d) + '/' + (y >> d));
    if (!buf) continue;
    const img = await decodeImage(buf);
    const n = 1 << d;
    const sw = img.width / n;
    const sh = img.height / n;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (x - ((x >> d) << d)) * sw, (y - ((y >> d) << d)) * sh, sw, sh, 0, 0, 256, 256);
    if (img.close) img.close();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return blob ? blob.arrayBuffer() : null;
  }
  return null;
}

async function loadTile(layerId, z, x, y, signal) {
  const stored = await store.getTile(layerId + '/' + z + '/' + x + '/' + y);
  if (stored) return stored;
  if (z <= LAYERS[layerId].maxzoom && canUseNetwork(layerId)) {
    try {
      const r = await fetchTile(layerId, z, x, y, signal, 9000);
      if (r.status === 'ok') return r.buf;
      if (r.status === 'denied' && deniedKey !== settings.scanKey) {
        deniedKey = settings.scanKey;
        toast('Clé SCAN 25 refusée par l\'IGN', 4500);
      }
    } catch (e) {
      if (signal && signal.aborted) throw e;
      // Réseau trop faible : on arrête d'insister quelques secondes, puis on réessaie.
      netDownUntil = Date.now() + 15000;
      clearTimeout(netRetryTimer);
      netRetryTimer = setTimeout(() => { if (!isOffline()) refreshTiles(layerId); }, 15500);
    }
  }
  return scaleFromAncestor(layerId, z, x, y);
}

maplibregl.addProtocol('balise', async (params, abortController) => {
  const m = /^balise:\/\/(\w+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
  if (!m) throw new Error('Adresse de tuile invalide');
  const data = await loadTile(m[1], +m[2], +m[3], +m[4], abortController && abortController.signal);
  return { data: data || BLANK_TILE.slice().buffer };
});

// ---------------------------------------------------------------------------
// Carte
// ---------------------------------------------------------------------------
const tilesOf = (id) => ['balise://' + id + '/{z}/{x}/{y}'];
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      plan: { type: 'raster', tiles: tilesOf('plan'), tileSize: 256, maxzoom: LAYERS.plan.maxzoom },
      scan: { type: 'raster', tiles: tilesOf('scan'), tileSize: 256, maxzoom: LAYERS.scan.maxzoom }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e8e4da' } },
      { id: 'plan', type: 'raster', source: 'plan', layout: { visibility: settings.layer === 'plan' ? 'visible' : 'none' } },
      { id: 'scan', type: 'raster', source: 'scan', layout: { visibility: settings.layer === 'scan' ? 'visible' : 'none' } }
    ]
  },
  center: settings.view.center,
  zoom: settings.view.zoom,
  minZoom: 4,
  maxZoom: 19.5,
  maxPitch: 0,
  pitchWithRotate: false,
  touchPitch: false,
  attributionControl: false,
  fadeDuration: 120
});
map.touchZoomRotate.enableRotation();
map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-left');
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© IGN' }), 'bottom-right');
map.on('error', () => { /* tuiles absentes hors ligne : rien à signaler */ });

const mapReady = new Promise((resolve) => map.on('load', resolve));

mapReady.then(() => {
  map.addSource('zones', { type: 'geojson', data: EMPTY_FC });
  map.addSource('accuracy', { type: 'geojson', data: EMPTY_FC });
  map.addSource('tracks', { type: 'geojson', data: EMPTY_FC });
  map.addSource('trackpts', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': '#16302b', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': 0.75 } });
  map.addLayer({ id: 'accuracy-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#1263e6', 'fill-opacity': 0.14 } });
  map.addLayer({ id: 'tracks-casing', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'tracks-line', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7a1fd1', 'line-width': 4 } });
  map.addLayer({
    id: 'trackpts', type: 'circle', source: 'trackpts',
    paint: {
      'circle-radius': ['match', ['get', 'kind'], 'wpt', 5, 7],
      'circle-color': ['match', ['get', 'kind'], 'start', '#1f7a4d', 'end', '#14211e', '#ffffff'],
      'circle-stroke-color': ['match', ['get', 'kind'], 'wpt', '#7a1fd1', '#ffffff'],
      'circle-stroke-width': 2.5
    }
  });
  map.on('click', 'trackpts', (e) => {
    const f = e.features && e.features[0];
    if (!f || !f.properties.label) return;
    new maplibregl.Popup({ closeButton: false, offset: 10 }).setLngLat(f.geometry.coordinates).setText(f.properties.label).addTo(map);
  });
});

let viewTimer = null;
map.on('moveend', () => {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    const c = map.getCenter();
    settings.view = { center: [+c.lng.toFixed(5), +c.lat.toFixed(5)], zoom: +map.getZoom().toFixed(2) };
    saveSettings();
  }, 600);
});

function refreshTiles(layerId) {
  const src = map.getSource(layerId);
  if (src && src.setTiles) src.setTiles(tilesOf(layerId));
}

function applyLayer() {
  for (const id of Object.keys(LAYERS)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', id === settings.layer ? 'visible' : 'none');
  }
  $('#chip-layer').textContent = LAYERS[settings.layer].label;
  document.querySelectorAll('.segmented button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.layer === settings.layer));
  });
  $('#scan-box').hidden = settings.layer !== 'scan';
}

function updateNetChip() {
  $('#chip-net').hidden = !isOffline();
  $('#chip-net').textContent = settings.forceOffline ? 'Hors ligne forcé' : 'Hors ligne';
}
window.addEventListener('online', () => { netDownUntil = 0; updateNetChip(); refreshTiles(settings.layer); });
window.addEventListener('offline', updateNetChip);

// ---------------------------------------------------------------------------
// Boussole
// ---------------------------------------------------------------------------
const compass = { on: false, heading: null, smooth: null, listening: false };
let touching = false;
const mapEl = $('#map');
for (const type of ['touchstart', 'touchend', 'touchcancel']) {
  mapEl.addEventListener(type, (e) => { touching = e.touches.length > 0; }, { passive: true });
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

// Cap à partir des angles alpha, beta, gamma (Android).
// Téléphone à plat ou incliné, comme on tient une carte : direction du bord supérieur.
// Téléphone tenu presque à la verticale : direction du dos de l'appareil (formule du W3C).
function tiltHeading(alpha, beta, gamma) {
  const d = Math.PI / 180;
  const x = (beta || 0) * d, y = (gamma || 0) * d, z = alpha * d;
  const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z);
  const sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  let east, north;
  if (Math.abs(cX) > 0.35) {
    east = -sZ * cX;
    north = cZ * cX;
  } else {
    east = -cZ * sY - sZ * sX * cY;
    north = -sZ * sY + cZ * sX * cY;
  }
  if (Math.abs(east) < 1e-9 && Math.abs(north) < 1e-9) return null;
  return (Math.atan2(east, north) / d + 360) % 360;
}

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    h = e.webkitCompassHeading;                       // iOS
  } else if ((e.absolute === true || e.type === 'deviceorientationabsolute') && typeof e.alpha === 'number') {
    h = tiltHeading(e.alpha, e.beta, e.gamma);        // Android
  }
  if (h === null) return;
  compass.heading = ((h + screenAngle()) % 360 + 360) % 360;
}

async function startCompass() {
  if (typeof DeviceOrientationEvent === 'undefined') return false;
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS (et certains navigateurs récents) demandent une autorisation explicite.
    // Quelle que soit la réponse, on écoute : c'est l'arrivée d'un cap qui fait foi.
    try { await DeviceOrientationEvent.requestPermission(); } catch (e) { /* hors geste utilisateur */ }
  }
  if (!compass.listening) {
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
    compass.listening = true;
    requestAnimationFrame(tick);
  }
  return true;
}

function tick() {
  requestAnimationFrame(tick);
  if (compass.heading === null) return;
  if (compass.smooth === null) compass.smooth = compass.heading;
  else {
    const d = ((compass.heading - compass.smooth + 540) % 360) - 180;
    compass.smooth = (compass.smooth + d * 0.18 + 360) % 360;
  }
  if (gps.marker) {
    gps.el.classList.add('has-heading');
    gps.marker.setRotation(compass.smooth);
  }
  if (compass.on && !touching && !frame.active) {
    const diff = Math.abs(((compass.smooth - map.getBearing() + 540) % 360) - 180);
    if (diff > 0.4) {
      const opt = { bearing: compass.smooth };
      if (gps.follow && gps.pos) opt.center = [gps.pos.lng, gps.pos.lat];
      map.jumpTo(opt);
    }
  }
}

function setCompass(on) {
  compass.on = on;
  $('#btn-compass').setAttribute('aria-pressed', String(on));
  $('#compass-tag').textContent = on ? 'Boussole' : 'N';
  if (on) map.touchZoomRotate.disableRotation();
  else if (!frame.active) map.touchZoomRotate.enableRotation();
}

map.on('rotate', () => {
  $('#needle').style.transform = 'rotate(' + (-map.getBearing()) + 'deg)';
});

$('#btn-compass').addEventListener('click', async () => {
  if (frame.active) { toast('Rotation indisponible pendant le choix de la zone'); return; }
  if (compass.on) {
    setCompass(false);
    map.easeTo({ bearing: 0, duration: 400 });
    toast('Nord en haut');
    return;
  }
  if (Math.abs(map.getBearing()) > 1) {
    map.easeTo({ bearing: 0, duration: 400 });
    toast('Nord en haut. Touchez encore pour suivre la boussole');
    return;
  }
  const ok = await startCompass();
  if (!ok) { toast('Boussole indisponible sur cet appareil'); return; }
  setCompass(true);
  toast('Carte orientée selon la boussole du téléphone');
  setTimeout(() => {
    if (compass.on && compass.heading === null) {
      setCompass(false);
      toast('Aucun cap reçu' + NB + ': boussole absente, ou accès aux capteurs de mouvement refusé', 5000);
    }
  }, 3500);
});

// ---------------------------------------------------------------------------
// Position GPS
// ---------------------------------------------------------------------------
const gps = { watch: null, pos: null, follow: false, marker: null, el: null, first: true };

function updateLocateBtn() {
  const b = $('#btn-locate');
  b.setAttribute('aria-pressed', String(gps.watch !== null));
  b.classList.toggle('is-following', gps.watch !== null && gps.follow);
}

function onPosition(p) {
  const c = p.coords;
  gps.pos = { lng: c.longitude, lat: c.latitude, acc: c.accuracy, alt: c.altitude };
  const ll = [c.longitude, c.latitude];
  if (!gps.marker) {
    gps.el = el('div', { class: 'pos-marker' }, el('div', { class: 'pos-cone' }), el('div', { class: 'pos-dot' }));
    gps.marker = new maplibregl.Marker({ element: gps.el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(ll).addTo(map);
  } else {
    gps.marker.setLngLat(ll);
  }
  const acc = map.getSource('accuracy');
  if (acc) {
    acc.setData(c.accuracy > 8
      ? { type: 'Feature', properties: {}, geometry: geo.circlePolygon(ll, c.accuracy) }
      : EMPTY_FC);
  }
  const ns = c.latitude >= 0 ? 'N' : 'S';
  const ew = c.longitude >= 0 ? 'E' : 'O';
  $('#readout-coord').textContent = Math.abs(c.latitude).toFixed(5) + '°' + NB + ns + '  ' + Math.abs(c.longitude).toFixed(5) + '°' + NB + ew;
  const parts = [];
  if (typeof c.altitude === 'number') parts.push('Alt. ' + fmtInt(c.altitude) + NB + 'm');
  parts.push('± ' + fmtInt(c.accuracy) + NB + 'm');
  $('#readout-alt').textContent = parts.join(', ');
  $('#readout').hidden = false;

  if (gps.follow) {
    if (gps.first) {
      map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 15), duration: 700 });
    } else if (!compass.on && !touching) {
      map.easeTo({ center: ll, duration: 500 });
    }
  }
  gps.first = false;
}

function onPositionError(err) {
  if (err.code === 1) {
    stopGPS();
    toast('Accès à la position refusé. Autorisez la localisation pour ce site dans les réglages du téléphone', 5000);
  } else if (!gps.pos) {
    toast('Position pas encore disponible. Placez-vous à ciel ouvert');
  }
}

function startGPS() {
  gps.first = true;
  gps.watch = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true, maximumAge: 3000, timeout: 60000
  });
}

function stopGPS() {
  if (gps.watch !== null) navigator.geolocation.clearWatch(gps.watch);
  gps.watch = null;
  gps.follow = false;
  gps.pos = null;
  if (gps.marker) { gps.marker.remove(); gps.marker = null; gps.el = null; }
  const acc = map.getSource('accuracy');
  if (acc) acc.setData(EMPTY_FC);
  $('#readout').hidden = true;
  updateLocateBtn();
}

map.on('dragstart', () => {
  if (gps.follow) { gps.follow = false; updateLocateBtn(); }
});

$('#btn-locate').addEventListener('click', () => {
  if (!('geolocation' in navigator)) { toast('Localisation indisponible sur cet appareil'); return; }
  // Hors iOS, le cap s'obtient sans fenêtre d'autorisation : on l'active pour orienter le marqueur.
  // Sur iOS, l'autorisation n'est demandée qu'au premier appui sur le bouton boussole.
  if (!isIOS || compass.listening) startCompass();
  if (gps.watch === null) {
    gps.follow = true;
    startGPS();
    toast('Recherche de la position');
  } else if (!gps.follow) {
    gps.follow = true;
    if (gps.pos) map.easeTo({ center: [gps.pos.lng, gps.pos.lat], zoom: Math.max(map.getZoom(), 15), duration: 600 });
  } else {
    stopGPS();
    toast('Position masquée');
  }
  updateLocateBtn();
});

// ---------------------------------------------------------------------------
// Panneaux et onglets
// ---------------------------------------------------------------------------
function openSheet(id) {
  if (frame.active) exitFrame();
  document.querySelectorAll('.sheet').forEach((s) => { s.hidden = s.id !== id; });
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.sheet === (id || '')));
  if (id === 'sheet-offline') { renderZones(); }
  if (id === 'sheet-tracks') { renderTracks(); }
}
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    const id = t.dataset.sheet;
    const already = id && !$('#' + id).hidden;
    openSheet(already ? '' : id);
  });
});
document.querySelectorAll('.sheet-close').forEach((b) => b.addEventListener('click', () => openSheet('')));

// ---------------------------------------------------------------------------
// Tracés GPX
// ---------------------------------------------------------------------------
let tracks = [];

function visibleSegments() {
  const segs = [];
  for (const t of tracks) if (t.visible) for (const s of t.segments) segs.push(s);
  return segs;
}

function drawTracks() {
  const lines = [];
  const pts = [];
  for (const t of tracks) {
    if (!t.visible) continue;
    for (const seg of t.segments) {
      lines.push({ type: 'Feature', properties: { id: t.id }, geometry: { type: 'LineString', coordinates: seg.map((p) => [p[0], p[1]]) } });
    }
    if (t.segments.length) {
      const first = t.segments[0][0];
      const lastSeg = t.segments[t.segments.length - 1];
      const last = lastSeg[lastSeg.length - 1];
      pts.push({ type: 'Feature', properties: { kind: 'end', label: 'Arrivée' + NB + ': ' + t.name }, geometry: { type: 'Point', coordinates: [last[0], last[1]] } });
      pts.push({ type: 'Feature', properties: { kind: 'start', label: 'Départ' + NB + ': ' + t.name }, geometry: { type: 'Point', coordinates: [first[0], first[1]] } });
    }
    for (const w of t.waypoints || []) {
      pts.push({ type: 'Feature', properties: { kind: 'wpt', label: w.name || 'Point' }, geometry: { type: 'Point', coordinates: [w.coord[0], w.coord[1]] } });
    }
  }
  const a = map.getSource('tracks');
  const b = map.getSource('trackpts');
  if (a) a.setData({ type: 'FeatureCollection', features: lines });
  if (b) b.setData({ type: 'FeatureCollection', features: pts });
  $('#btn-zone-track').hidden = visibleSegments().length === 0;
}

function trackBBox(t) {
  const segs = t.segments.length ? t.segments : [(t.waypoints || []).map((w) => w.coord)];
  return geo.bboxOfSegments(segs);
}

function fitBBox(bbox, extra = {}) {
  if (bbox[0] > bbox[2]) return;
  map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
    padding: { top: 90, bottom: 60, left: 40, right: 40 }, maxZoom: 16, duration: 700, bearing: map.getBearing(), ...extra
  });
}

function renderTracks() {
  const list = $('#track-list');
  list.replaceChildren();
  if (!tracks.length) {
    list.append(el('li', { class: 'empty', text: 'Aucun tracé importé.' }));
    return;
  }
  for (const t of tracks) {
    const meta = [];
    if (t.stats.dist > 0) meta.push(fmtDist(t.stats.dist));
    if (t.stats.up !== null) meta.push('D+ ' + fmtInt(t.stats.up) + NB + 'm', 'D- ' + fmtInt(t.stats.down) + NB + 'm');
    if (t.waypoints && t.waypoints.length) meta.push(t.waypoints.length + ' point' + (t.waypoints.length > 1 ? 's' : ''));
    list.append(el('li', { class: 'item' },
      el('div', { class: 'item-title', text: t.name }),
      el('div', { class: 'item-meta', text: meta.join(', ') }),
      el('div', { class: 'item-actions' },
        el('button', {
          type: 'button', class: 'btn btn-small', text: 'Voir sur la carte',
          onclick: async () => {
            if (!t.visible) { t.visible = true; await store.put('tracks', t); drawTracks(); }
            openSheet('');
            fitBBox(trackBBox(t));
          }
        }),
        el('button', {
          type: 'button', class: 'btn btn-small', text: t.visible ? 'Masquer' : 'Afficher',
          onclick: async () => { t.visible = !t.visible; await store.put('tracks', t); drawTracks(); renderTracks(); }
        }),
        confirmButton('Supprimer', async () => {
          await store.del('tracks', t.id);
          tracks = tracks.filter((x) => x.id !== t.id);
          drawTracks();
          renderTracks();
        })
      )
    ));
  }
}

$('#gpx-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  let last = null;
  for (const file of files) {
    try {
      const parsed = geo.parseGPX(await file.text(), file.name.replace(/\.[^.]+$/, ''));
      const t = {
        id: newId(), name: parsed.name, segments: parsed.segments, waypoints: parsed.waypoints,
        stats: geo.trackStats(parsed.segments), visible: true, date: Date.now()
      };
      await store.put('tracks', t);
      tracks.push(t);
      last = t;
    } catch (err) {
      toast(file.name + NB + ': ' + (err.message || 'fichier illisible'), 4500);
    }
  }
  if (last) {
    drawTracks();
    renderTracks();
    openSheet('');
    fitBBox(trackBBox(last));
    toast('Tracé « ' + last.name + ' » importé');
  }
});

// ---------------------------------------------------------------------------
// Choix de la zone à télécharger
// ---------------------------------------------------------------------------
const frame = { active: false, mode: 'bbox', trackKeys: null, trackLevel: null };

function frameBBox() {
  const r = $('#frame').getBoundingClientRect();
  const m = mapEl.getBoundingClientRect();
  const sw = map.unproject([r.left - m.left, r.bottom - m.top]);
  const ne = map.unproject([r.right - m.left, r.top - m.top]);
  return [sw.lng, sw.lat, ne.lng, ne.lat];
}

function frameKeys() {
  const level = +$('#zone-level').value;
  if (frame.mode === 'track') {
    if (frame.trackLevel !== level) {
      frame.trackKeys = geo.tilesForTrack(visibleSegments(), TRACK_BUFFER_M, ZMIN, level);
      frame.trackLevel = level;
    }
    return frame.trackKeys;
  }
  return null;
}

function updateEstimate() {
  if (!frame.active) return;
  const level = +$('#zone-level').value;
  const L = LAYERS[settings.layer];
  const n = frame.mode === 'track' ? frameKeys().length : geo.countTilesForBBox(frameBBox(), ZMIN, level);
  const out = $('#frame-estimate');
  const over = n > MAX_TILES;
  out.classList.toggle('is-over', over);
  out.textContent = over
    ? 'Zone trop grande (' + fmtInt(n) + ' tuiles). Réduisez la zone ou le niveau de détail.'
    : fmtInt(n) + ' tuiles, environ ' + fmtSize(n * L.kb * 1000) + ' (' + L.label + ')';
  $('#frame-go').disabled = over || n === 0;
}

let estimateRaf = 0;
map.on('move', () => {
  if (!frame.active || frame.mode !== 'bbox') return;
  cancelAnimationFrame(estimateRaf);
  estimateRaf = requestAnimationFrame(updateEstimate);
});
$('#zone-level').addEventListener('change', updateEstimate);

function enterFrame(mode) {
  if (dl.active) { toast('Un téléchargement est déjà en cours'); return; }
  const L = LAYERS[settings.layer];
  if (L.priv && !settings.scanKey) {
    toast('Saisissez d\'abord votre clé SCAN 25 dans les réglages', 4500);
    return;
  }
  if (isOffline()) { toast('Pas de réseau' + NB + ': le téléchargement demande une connexion', 4500); return; }
  openSheet('');
  setCompass(false);
  frame.active = true;
  frame.mode = mode;
  frame.trackKeys = null;
  frame.trackLevel = null;
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.easeTo({ bearing: 0, duration: 300 });

  const sel = $('#zone-level');
  sel.replaceChildren(...L.levels.map(([z, label]) => {
    const o = el('option', { value: String(z), text: label });
    if (z === L.def) o.selected = true;
    return o;
  }));
  const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  if (mode === 'track') {
    const shown = tracks.filter((t) => t.visible && t.segments.length);
    $('#zone-name').value = shown.length === 1 ? shown[0].name.slice(0, 40) : 'Tracés du ' + today;
    $('#frame-help').textContent = 'La carte sera téléchargée sur une bande de 1 km de chaque côté des tracés affichés.';
    $('#frame').hidden = true;
    fitBBox(geo.bboxOfSegments(visibleSegments()), { bearing: 0, padding: { top: 90, bottom: 340, left: 40, right: 40 } });
  } else {
    $('#zone-name').value = 'Zone du ' + today;
    $('#frame-help').textContent = 'Déplacez et zoomez la carte pour placer la zone dans le cadre.';
    $('#frame').hidden = false;
  }
  $('#framebar').hidden = false;
  setTimeout(updateEstimate, 350);
}

function exitFrame() {
  frame.active = false;
  $('#frame').hidden = true;
  $('#framebar').hidden = true;
  map.dragRotate.enable();
  map.touchZoomRotate.enableRotation();
}

$('#btn-zone-frame').addEventListener('click', () => enterFrame('bbox'));
$('#btn-zone-track').addEventListener('click', () => enterFrame('track'));
$('#frame-cancel').addEventListener('click', () => { exitFrame(); openSheet('sheet-offline'); });
$('#framebar').addEventListener('submit', (e) => {
  e.preventDefault();
  const level = +$('#zone-level').value;
  let keys, bbox;
  if (frame.mode === 'track') {
    keys = frameKeys();
    bbox = geo.expandBBox(geo.bboxOfSegments(visibleSegments()), TRACK_BUFFER_M);
  } else {
    bbox = frameBBox();
    keys = geo.tilesForBBox(bbox, ZMIN, level);
  }
  if (!keys.length || keys.length > MAX_TILES) return;
  const layer = settings.layer;
  const zone = {
    id: newId(), name: $('#zone-name').value.trim() || 'Zone sans nom', layer, kind: frame.mode,
    bbox: bbox.map((v) => +v.toFixed(6)), zmin: ZMIN, zmax: level, total: keys.length, missing: keys.length, bytes: 0, date: Date.now()
  };
  exitFrame();
  runDownload(zone, keys.map((k) => layer + '/' + k));
});

// ---------------------------------------------------------------------------
// Téléchargement d'une zone
// ---------------------------------------------------------------------------
const dl = { active: false, ctrl: null };

$('#progress-cancel').addEventListener('click', () => { if (dl.ctrl) dl.ctrl.abort(); });

async function runDownload(zone, fullKeys) {
  if (dl.active) return;
  dl.active = true;
  dl.ctrl = new AbortController();
  const signal = dl.ctrl.signal;
  const layer = zone.layer;
  applyWake();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* facultatif */ }

  $('#progress-title').textContent = 'Téléchargement de « ' + zone.name + ' »';
  $('#progress-fill').style.width = '0%';
  $('#progress-text').textContent = 'Préparation';
  $('#progress').hidden = false;

  let failed = 0, absent = 0, bytes = 0, denied = false, storageError = null;
  try {
    // La zone est enregistrée dès le départ : un arrêt en cours de route reste visible et se reprend.
    await store.put('zoneTiles', fullKeys, zone.id);
    await store.put('zones', zone);

    const existing = new Set(await store.allTileKeys());
    const todo = fullKeys.filter((k) => !existing.has(k));
    let done = fullKeys.length - todo.length;
    let index = 0;
    let buffer = [];
    let chain = Promise.resolve();
    const flush = () => {
      const batch = buffer;
      buffer = [];
      chain = chain.then(() => store.putTiles(batch)).catch((err) => { storageError = err; dl.ctrl.abort(); });
      return chain;
    };
    let lastPaint = 0;
    const paint = (force) => {
      const now = Date.now();
      if (!force && now - lastPaint < 150) return;
      lastPaint = now;
      $('#progress-fill').style.width = ((done / fullKeys.length) * 100).toFixed(1) + '%';
      $('#progress-text').textContent = fmtInt(done) + ' sur ' + fmtInt(fullKeys.length) + ' tuiles, ' + fmtSize(bytes) +
        '. Gardez l\'application ouverte.';
    };
    paint(true);

    const worker = async () => {
      while (index < todo.length && !signal.aborted && !denied) {
        const key = todo[index++];
        const parts = key.split('/');
        let res = null;
        for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
          try {
            res = await fetchTile(layer, +parts[1], +parts[2], +parts[3], signal, 20000);
            break;
          } catch (err) {
            if (signal.aborted) return;
            await sleep(700 * (attempt + 1));
          }
        }
        if (signal.aborted) return;
        if (!res) failed++;
        else if (res.status === 'ok') {
          buffer.push([key, res.buf]);
          bytes += res.buf.byteLength;
          if (buffer.length >= 24) await flush();
        } else if (res.status === 'denied') denied = true;
        else absent++;
        done++;
        paint(false);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await flush();

    const stored = new Set(await store.allTileKeys());
    let notStored = 0;
    for (const k of fullKeys) if (!stored.has(k)) notStored++;
    zone.missing = denied || signal.aborted || failed ? Math.max(0, notStored - absent) : 0;
    zone.bytes = (zone.bytes || 0) + bytes;
    zone.date = Date.now();
    await store.put('zones', zone);
  } catch (err) {
    storageError = storageError || err;
  }

  const aborted = signal.aborted;
  dl.active = false;
  dl.ctrl = null;
  $('#progress').hidden = true;
  applyWake();
  refreshTiles(layer);
  await loadZones();
  openSheet('sheet-offline');

  if (storageError) {
    toast('Stockage impossible' + NB + ': espace insuffisant sur l\'appareil ?', 6000);
  } else if (denied) {
    toast('Accès refusé par l\'IGN' + NB + ': vérifiez votre clé SCAN 25', 6000);
  } else if (aborted) {
    toast('Téléchargement arrêté. Vous pouvez le reprendre depuis la liste', 5000);
  } else if (zone.missing > 0) {
    toast(fmtInt(zone.missing) + ' tuiles n\'ont pas pu être chargées. Reprenez le téléchargement', 6000);
  } else {
    toast('« ' + zone.name + ' » est disponible hors ligne', 4500);
  }
}

// ---------------------------------------------------------------------------
// Zones téléchargées
// ---------------------------------------------------------------------------
let zones = [];

async function loadZones() {
  zones = (await store.getAll('zones')).sort((a, b) => b.date - a.date);
  await mapReady;
  map.getSource('zones').setData({
    type: 'FeatureCollection',
    features: zones.map((z) => ({
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[[z.bbox[0], z.bbox[1]], [z.bbox[2], z.bbox[1]], [z.bbox[2], z.bbox[3]], [z.bbox[0], z.bbox[3]], [z.bbox[0], z.bbox[1]]]] }
    }))
  });
}

async function deleteZone(zone) {
  const mine = (await store.get('zoneTiles', zone.id)) || [];
  const keep = new Set();
  for (const other of zones) {
    if (other.id === zone.id || other.layer !== zone.layer) continue;
    for (const k of (await store.get('zoneTiles', other.id)) || []) keep.add(k);
  }
  await store.deleteTiles(mine.filter((k) => !keep.has(k)));
  await store.del('zoneTiles', zone.id);
  await store.del('zones', zone.id);
  await loadZones();
  refreshTiles(zone.layer);
  renderZones();
  toast('Zone supprimée');
}

async function renderZones() {
  const list = $('#zone-list');
  list.replaceChildren();
  if (!zones.length) {
    list.append(el('li', { class: 'empty', text: 'Aucune zone pour l\'instant.' }));
  }
  for (const z of zones) {
    const meta = LAYERS[z.layer].label + ', détail ' + z.zmax + ', ' + fmtInt(z.total) + ' tuiles' + (z.bytes ? ', ' + fmtSize(z.bytes) : '');
    const item = el('li', { class: 'item' },
      el('div', { class: 'item-title', text: z.name }),
      el('div', { class: 'item-meta', text: meta })
    );
    if (z.missing > 0) {
      item.append(el('div', { class: 'item-meta item-warn', text: 'Incomplète' + NB + ': ' + fmtInt(z.missing) + ' tuiles manquantes' }));
    }
    const actions = el('div', { class: 'item-actions' },
      el('button', {
        type: 'button', class: 'btn btn-small', text: 'Voir sur la carte',
        onclick: () => {
          if (settings.layer !== z.layer) { settings.layer = z.layer; saveSettings(); applyLayer(); }
          openSheet('');
          fitBBox(z.bbox);
        }
      })
    );
    if (z.missing > 0) {
      actions.append(el('button', {
        type: 'button', class: 'btn btn-small', text: 'Reprendre',
        onclick: async () => {
          if (dl.active) { toast('Un téléchargement est déjà en cours'); return; }
          if (isOffline()) { toast('Pas de réseau pour reprendre le téléchargement'); return; }
          const keys = (await store.get('zoneTiles', z.id)) || [];
          openSheet('');
          runDownload(z, keys);
        }
      }));
    }
    actions.append(confirmButton('Supprimer', () => deleteZone(z)));
    item.append(actions);
    list.append(item);
  }

  const info = $('#storage-info');
  info.textContent = '';
  try {
    const count = await store.countTiles();
    let text = fmtInt(count) + ' tuiles enregistrées dans l\'appareil';
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est.usage && est.quota) text += ', ' + fmtSize(est.usage) + ' utilisés sur ' + fmtSize(est.quota) + ' autorisés';
    }
    info.textContent = text + '.';
  } catch (e) { /* information facultative */ }
}

// ---------------------------------------------------------------------------
// Recherche de lieu (en ligne uniquement)
// ---------------------------------------------------------------------------
function resultLabel(p) {
  const pick = (v) => (Array.isArray(v) ? v[0] : v);
  const name = p.label || pick(p.toponym) || pick(p.name) || '';
  const city = pick(p.city);
  const extra = [pick(p.category), city && city !== name ? city : '', pick(p.postcode)].filter(Boolean).join(', ');
  return p.label ? name : name + (extra ? ' (' + extra + ')' : '');
}

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  const list = $('#search-results');
  list.replaceChildren();
  if (!q) return;
  $('#search-input').blur();

  // Coordonnées saisies directement : "45.9237, 6.8694"
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(q);
  if (m) {
    const lat = parseFloat(m[1].replace(',', '.'));
    const lon = parseFloat(m[2].replace(',', '.'));
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      openSheet('');
      map.flyTo({ center: [lon, lat], zoom: 14 });
      return;
    }
  }
  if (isOffline()) {
    list.append(el('li', { class: 'empty', text: 'La recherche de lieu demande une connexion.' }));
    return;
  }
  list.append(el('li', { class: 'empty', text: 'Recherche en cours' }));
  try {
    const base = 'https://data.geopf.fr/geocodage/search?limit=8&q=' + encodeURIComponent(q);
    let res = await fetch(base + '&index=address,poi');
    if (!res.ok) res = await fetch(base);
    if (!res.ok) throw new Error('Service indisponible');
    const data = await res.json();
    const feats = (data.features || []).filter((f) => f.geometry && f.geometry.type === 'Point');
    list.replaceChildren();
    if (!feats.length) {
      list.append(el('li', { class: 'empty', text: 'Aucun lieu trouvé.' }));
      return;
    }
    for (const f of feats) {
      list.append(el('li', {}, el('button', {
        type: 'button', class: 'result', text: resultLabel(f.properties || {}),
        onclick: () => {
          openSheet('');
          map.flyTo({ center: f.geometry.coordinates, zoom: 13 });
        }
      })));
    }
  } catch (err) {
    list.replaceChildren(el('li', { class: 'empty', text: 'Recherche impossible pour le moment.' }));
  }
});

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------
document.querySelectorAll('.segmented button').forEach((b) => {
  b.addEventListener('click', () => {
    settings.layer = b.dataset.layer;
    saveSettings();
    applyLayer();
    if (settings.layer === 'scan' && !settings.scanKey) {
      toast('Sans clé, le SCAN 25 n\'affiche que les zones déjà téléchargées', 4500);
    }
  });
});

$('#scan-key').value = settings.scanKey;
$('#scan-key').addEventListener('change', (e) => {
  settings.scanKey = e.target.value.trim();
  saveSettings();
  netDownUntil = 0;
  deniedKey = null;
  refreshTiles('scan');
});

$('#opt-offline').checked = settings.forceOffline;
$('#opt-offline').addEventListener('change', (e) => {
  settings.forceOffline = e.target.checked;
  saveSettings();
  updateNetChip();
  refreshTiles(settings.layer);
});

let wakeLock = null;
async function applyWake() {
  const want = settings.wake || dl.active;
  if (!('wakeLock' in navigator)) return;
  if (want && document.visibilityState === 'visible') {
    if (wakeLock && !wakeLock.released) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
  } else if (!want && wakeLock) {
    try { await wakeLock.release(); } catch (e) { /* déjà libéré */ }
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', applyWake);
$('#opt-wake').checked = settings.wake;
$('#opt-wake').addEventListener('change', (e) => {
  settings.wake = e.target.checked;
  saveSettings();
  applyWake();
  if (settings.wake && !('wakeLock' in navigator)) toast('Fonction non disponible sur ce navigateur');
});

// Installation
let installEvent = null;
const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => null);
  installEvent = null;
  $('#btn-install').hidden = true;
});
$('#install-hint').textContent = standalone
  ? 'L\'application est installée sur cet appareil.'
  : isIOS
    ? 'Sur iPhone et iPad' + NB + ': ouvrez cette page dans Safari, touchez Partager, puis « Sur l\'écran d\'accueil ». Téléchargez ensuite vos cartes depuis l\'application installée, car elle a son propre espace de stockage.'
    : 'Sur Android' + NB + ': ouvrez le menu du navigateur, puis « Installer l\'application » ou « Ajouter à l\'écran d\'accueil ».';
$('#version-info').textContent = 'Version ' + APP_VERSION;

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
applyLayer();
updateNetChip();
applyWake();

(async () => {
  try {
    await mapReady;
    tracks = (await store.getAll('tracks')).sort((a, b) => a.date - b.date);
    drawTracks();
    await loadZones();
  } catch (err) {
    toast('Stockage local indisponible' + NB + ': les cartes hors ligne ne fonctionneront pas (navigation privée ?)', 7000);
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* hors HTTPS : pas de mode hors ligne de l'application */ });
  });
}

// Accès pour le diagnostic et les tests.
window.__balise = { map, store, geo, settings, LAYERS, loadZones, runDownload };
