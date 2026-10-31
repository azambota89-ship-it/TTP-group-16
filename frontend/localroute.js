// localroute.js: road-following routing that runs in the browser.
// Loads Kampar roads from OpenStreetMap, builds a graph, runs Dijkstra, and
// avoids road segments near reported floods. Load AFTER app.js and route.js.
//
// This is an interim/fallback version of what B's backend will do. It returns the
// same shape as POST /route, plus a few optional extra fields.

const BLOCK_RADIUS_M = 40;       // a road segment within this distance of a flood point counts as affected
const MAX_SNAP_M = 200;          // clicks farther than this from any road are rejected
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const ROAD_TYPES = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";

let rawRoadData = null;
let graphPromise = null;
let affectedSegments = [];   // [{name, coords: [[lat, lon], [lat, lon]]}], also drawn by view3d.js
const affectedLayer = L.layerGroup().addTo(map);

// ---------- Load road data ----------
async function loadRoadData() {
  // 1) A saved copy makes the demo fast and works offline: put it at mock/roads.json
  try {
    const saved = await fetch("mock/roads.json");
    if (saved.ok) return (rawRoadData = await saved.json());
  } catch (e) { /* no saved copy, fall through */ }

  // 2) Otherwise ask OpenStreetMap (Overpass API) for roads inside the study area
  const [[s, w], [n, e]] = STUDY_AREA;
  const query =
    `[out:json][timeout:60];` +
    `way["highway"~"^(${ROAD_TYPES})$"]["service"!~"parking_aisle|driveway"]["access"!~"private|no"]` +
    `(${s},${w},${n},${e});out geom;`;
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return (rawRoadData = await res.json());
}

// Run downloadRoads() in the browser console once, then put the downloaded file at mock/roads.json
function downloadRoads() {
  if (!rawRoadData) { console.warn("Road data not loaded yet. Press Find route first."); return; }
  const blob = new Blob([JSON.stringify(rawRoadData)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "roads.json";
  a.click();
}

// ---------- Build the graph ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const x = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function buildGraph(data) {
  const nodes = new Map();   // id -> {lat, lon, main}
  const adj = new Map();     // id -> [{to, seg}]
  const segs = [];           // every road piece between two junction/shape nodes

  const addNode = (id, g) => {
    if (!nodes.has(id)) { nodes.set(id, { lat: g.lat, lon: g.lon, main: false }); adj.set(id, []); }
  };

  for (const way of data.elements || []) {
    if (way.type !== "way" || !way.geometry || way.geometry.length < 2) continue;
    const t = way.tags || {};
    const name = t.name || t.ref || `unnamed ${t.highway || "road"}`;
    const reverse = t.oneway === "-1";
    const oneway = ["yes", "true", "1"].includes(t.oneway) || t.junction === "roundabout";
    const forward = !reverse;
    const backward = reverse || !oneway;

    for (let i = 1; i < way.geometry.length; i++) {
      const ga = way.geometry[i - 1], gb = way.geometry[i];
      const a = way.nodes ? way.nodes[i - 1] : `${ga.lat},${ga.lon}`;
      const b = way.nodes ? way.nodes[i] : `${gb.lat},${gb.lon}`;
      addNode(a, ga);
      addNode(b, gb);
      const seg = { a, b, len: haversine(ga.lat, ga.lon, gb.lat, gb.lon), name, blocked: false };
      segs.push(seg);
      if (forward) adj.get(a).push({ to: b, seg });
      if (backward) adj.get(b).push({ to: a, seg });
    }
  }

  // Keep only the largest connected piece, so clicks never snap to an isolated road fragment
  const und = new Map();
  for (const s of segs) {
    (und.get(s.a) || und.set(s.a, []).get(s.a)).push(s.b);
    (und.get(s.b) || und.set(s.b, []).get(s.b)).push(s.a);
  }
  const seen = new Set();
  let best = [];
  for (const start of und.keys()) {
    if (seen.has(start)) continue;
    const comp = [start];
    seen.add(start);
    for (let i = 0; i < comp.length; i++) {
      for (const nb of und.get(comp[i])) {
        if (!seen.has(nb)) { seen.add(nb); comp.push(nb); }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  best.forEach(id => (nodes.get(id).main = true));

  return { nodes, adj, segs };
}

function getGraph() {
  if (!graphPromise) {
    graphPromise = loadRoadData().then(buildGraph).catch(err => { graphPromise = null; throw err; });
  }
  return graphPromise;
}

// ---------- Mark segments near floods as blocked ----------
function distToSegmentM(p, a, b) {
  const kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 110540;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function markBlocked(graph, floods) {
  for (const s of graph.segs) {
    const a = graph.nodes.get(s.a), b = graph.nodes.get(s.b);
    s.blocked = floods.some(f => distToSegmentM(f, a, b) <= BLOCK_RADIUS_M);
  }
}

// ---------- Dijkstra ----------
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function dijkstra(graph, src, dst, avoidBlocked) {
  const dist = new Map([[src, 0]]);
  const prev = new Map();
  const done = new Set();
  const heap = new MinHeap();
  heap.push(0, src);

  while (heap.size) {
    const [d, u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === dst) break;
    for (const { to, seg } of graph.adj.get(u) || []) {
      if (avoidBlocked && seg.blocked) continue;
      const nd = d + seg.len;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, { u, seg });
        heap.push(nd, to);
      }
    }
  }
  if (!dist.has(dst)) return null;

  const nodeIds = [dst], segs = [];
  let cur = dst;
  while (cur !== src) {
    const p = prev.get(cur);
    segs.push(p.seg);
    nodeIds.push(p.u);
    cur = p.u;
  }
  nodeIds.reverse();
  segs.reverse();
  return { nodeIds, segs, dist: dist.get(dst) };
}

// ---------- Snap a clicked point to the nearest road node ----------
function snapToRoad(graph, latlng) {
  let bestId = null, bestD = Infinity;
  for (const [id, n] of graph.nodes) {
    if (!n.main) continue;
    const d = haversine(latlng.lat, latlng.lng, n.lat, n.lon);
    if (d < bestD) { bestD = d; bestId = id; }
  }
  return { id: bestId, dist: bestD };
}

// ---------- Main function used by route.js ----------
async function localRoute(o, d) {
  const graph = await getGraph();
  markBlocked(graph, currentFloods);

  const s = snapToRoad(graph, o), t = snapToRoad(graph, d);
  if (s.id === null || t.id === null || s.dist > MAX_SNAP_M || t.dist > MAX_SNAP_M) {
    return { status: "no_route", reason: "far_from_road", path: [], distance: 0, blocked_segments: [] };
  }

  const preferred = dijkstra(graph, s.id, t.id, false);   // usual route, ignoring floods
  const alt = dijkstra(graph, s.id, t.id, true);          // route avoiding affected roads
  if (!preferred || !alt) {
    return { status: "no_route", reason: "no_path", path: [], distance: 0, blocked_segments: [] };
  }

  const toLatLon = ids => ids.map(id => { const n = graph.nodes.get(id); return [n.lat, n.lon]; });
  const hit = preferred.segs.filter(x => x.blocked);
  const rerouted = hit.length > 0;

  const result = {
    status: "ok",
    path: [[o.lat, o.lng], ...toLatLon(alt.nodeIds), [d.lat, d.lng]],
    distance: alt.dist,
    blocked_segments: hit.map(x => {
      const a = graph.nodes.get(x.a), b = graph.nodes.get(x.b);
      return [[a.lat, a.lon], [b.lat, b.lon]];
    }),
    // optional extras (not part of the agreed contract)
    rerouted,
    blocked_roads: [...new Set(hit.map(x => x.name))],
    note: "calculated in your browser from OpenStreetMap data"
  };
  if (rerouted) {
    result.preferred_path = toLatLon(preferred.nodeIds);
    result.preferred_distance = preferred.dist;
  }
  return result;
}

// ---------- Show affected roads on the map ----------
const affectedInfo = document.createElement("div");
affectedInfo.id = "affected-info";
document.getElementById("result").insertAdjacentElement("afterend", affectedInfo);

async function refreshAffectedRoads() {
  try {
    const graph = await getGraph();
    markBlocked(graph, currentFloods);
    affectedLayer.clearLayers();
    affectedSegments = [];

    const names = new Set();
    for (const s of graph.segs) {
      if (!s.blocked) continue;
      const a = graph.nodes.get(s.a), b = graph.nodes.get(s.b);
      names.add(s.name);
      affectedSegments.push({ name: s.name, coords: [[a.lat, a.lon], [b.lat, b.lon]] });
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: "#dc3545", weight: 7, opacity: 0.6 })
        .bindTooltip(`Affected road: ${s.name}`, { sticky: true })
        .addTo(affectedLayer);
    }
    affectedInfo.textContent = names.size
      ? `Roads near reported floods: ${[...names].join(", ")}`
      : "No roads currently marked as affected.";
    if (typeof render3D === "function") render3D();   // update the 3D view too
  } catch (err) {
    console.warn("Could not mark affected roads:", err);
    affectedInfo.textContent = "";
  }
}

// Redraw affected roads whenever the flood markers are (re)drawn, including new reports.
// (Wraps the drawFloods function from app.js so app.js does not need to change.)
const _drawFloods = drawFloods;
drawFloods = function (floods) {
  _drawFloods(floods);
  refreshAffectedRoads();
};