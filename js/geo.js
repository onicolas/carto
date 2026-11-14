// Calculs géographiques : tuiles Web Mercator, distances, lecture GPX.

const R = 6371008.8;
const RAD = Math.PI / 180;
const MAX_LAT = 85.0511;

export function lon2x(lon, z) {
  const n = 2 ** z;
  return Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
}

export function lat2y(lat, z) {
  const n = 2 ** z;
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * RAD;
  const y = Math.floor(((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2) * n);
  return Math.min(n - 1, Math.max(0, y));
}

// bbox : [ouest, sud, est, nord]
export function tileRange(bbox, z) {
  return {
    x0: lon2x(bbox[0], z), x1: lon2x(bbox[2], z),
    y0: lat2y(bbox[3], z), y1: lat2y(bbox[1], z)
  };
}

export function countTilesForBBox(bbox, zmin, zmax) {
  let n = 0;
  for (let z = zmin; z <= zmax; z++) {
    const r = tileRange(bbox, z);
    n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  }
  return n;
}

// Renvoie les clés "z/x/y" couvrant la bbox.
export function tilesForBBox(bbox, zmin, zmax) {
  const out = [];
  for (let z = zmin; z <= zmax; z++) {
    const r = tileRange(bbox, z);
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) out.push(z + '/' + x + '/' + y);
    }
  }
  return out;
}

export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Ajoute des points intermédiaires pour qu'aucun segment ne dépasse maxM mètres.
function densify(points, maxM) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const q = points[i - 1];
      const d = haversine(q, p);
      const n = Math.floor(d / maxM);
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        out.push([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t]);
      }
    }
    out.push(p);
  }
  return out;
}

// Tuiles situées à moins de bufferM mètres des segments (couloir autour d'un tracé).
export function tilesForTrack(segments, bufferM, zmin, zmax) {
  const set = new Set();
  const dense = segments.map((s) => densify(s, 150));
  for (let z = zmin; z <= zmax; z++) {
    for (const seg of dense) {
      for (const p of seg) {
        const dLat = bufferM / 111320;
        const dLon = bufferM / (111320 * Math.max(0.05, Math.cos(p[1] * RAD)));
        const x0 = lon2x(p[0] - dLon, z), x1 = lon2x(p[0] + dLon, z);
        const y0 = lat2y(p[1] + dLat, z), y1 = lat2y(p[1] - dLat, z);
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) set.add(z + '/' + x + '/' + y);
        }
      }
    }
  }
  return Array.from(set);
}

export function bboxOfSegments(segments) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const seg of segments) {
    for (const p of seg) {
      if (p[0] < w) w = p[0];
      if (p[0] > e) e = p[0];
      if (p[1] < s) s = p[1];
      if (p[1] > n) n = p[1];
    }
  }
  return [w, s, e, n];
}

export function expandBBox(bbox, meters) {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const dLat = meters / 111320;
  const dLon = meters / (111320 * Math.max(0.05, Math.cos(midLat * RAD)));
  return [bbox[0] - dLon, bbox[1] - dLat, bbox[2] + dLon, bbox[3] + dLat];
}

// Polygone approchant un cercle (précision de la position).
export function circlePolygon(center, radiusM, steps = 48) {
  const ring = [];
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.max(0.05, Math.cos(center[1] * RAD)));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([center[0] + dLon * Math.cos(a), center[1] + dLat * Math.sin(a)]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

// Distance totale et dénivelés (seuil de 4 m pour filtrer le bruit d'altitude).
export function trackStats(segments) {
  let dist = 0, up = 0, down = 0, hasEle = false;
  for (const seg of segments) {
    let ref = null;
    for (let i = 0; i < seg.length; i++) {
      if (i > 0) dist += haversine(seg[i - 1], seg[i]);
      const ele = seg[i][2];
      if (typeof ele === 'number' && isFinite(ele)) {
        hasEle = true;
        if (ref === null) ref = ele;
        else if (ele - ref >= 4) { up += ele - ref; ref = ele; }
        else if (ref - ele >= 4) { down += ref - ele; ref = ele; }
      }
    }
  }
  return { dist, up: hasEle ? up : null, down: hasEle ? down : null };
}

function textOf(parent, tag) {
  if (!parent) return '';
  for (const c of parent.children) {
    if (c.localName === tag) return (c.textContent || '').trim();
  }
  return '';
}

function readPoint(el) {
  const lat = parseFloat(el.getAttribute('lat'));
  const lon = parseFloat(el.getAttribute('lon'));
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const ele = parseFloat(textOf(el, 'ele'));
  return isFinite(ele) ? [lon, lat, ele] : [lon, lat];
}

// Lecture d'un fichier GPX : traces (trk), itinéraires (rte) et points (wpt).
export function parseGPX(text, fallbackName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Fichier GPX illisible');
  }
  const all = (tag) => Array.from(doc.getElementsByTagNameNS('*', tag));
  const segments = [];
  for (const seg of all('trkseg')) {
    const pts = Array.from(seg.children).filter((c) => c.localName === 'trkpt').map(readPoint).filter(Boolean);
    if (pts.length > 1) segments.push(pts);
  }
  for (const rte of all('rte')) {
    const pts = Array.from(rte.children).filter((c) => c.localName === 'rtept').map(readPoint).filter(Boolean);
    if (pts.length > 1) segments.push(pts);
  }
  const waypoints = [];
  for (const w of all('wpt')) {
    const p = readPoint(w);
    if (p) waypoints.push({ coord: p, name: textOf(w, 'name') });
  }
  if (!segments.length && !waypoints.length) {
    throw new Error('Aucun tracé dans ce fichier');
  }
  const meta = all('metadata')[0];
  const trk = all('trk')[0] || all('rte')[0];
  const name = textOf(trk, 'name') || textOf(meta, 'name') || fallbackName || 'Tracé';
  return { name, segments, waypoints };
}
