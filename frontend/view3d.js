// view3d.js: makes the 3D view (MapLibre) work like the 2D view.
// Adds start/destination markers, the route, the usual route, avoided and affected roads,
// click-to-pick, and report location picking. Load LAST, after localroute.js.
//
// It reuses the logic in route.js / report.js by forwarding 3D clicks to the 2D map,
// and wraps a few functions so the 3D view redraws whenever the shared state changes.

let lastRoute = null;        // latest route response, drawn in both views
let map3dReady = false;
let originMarker3d = null;
let destMarker3d = null;
let reportMarker3d = null;

const EMPTY_FC = { type: "FeatureCollection", features: [] };
const toLonLat = p => [p[1], p[0]];   // app uses [lat, lon], MapLibre needs [lon, lat]

function lineFeature(coords) {
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords.map(toLonLat) } };
}
function collection(features) {
  return { type: "FeatureCollection", features };
}

// ---------- Layers ----------
function setup3DLayers() {
  const addLine = (id, paint) => {
    map3d.addSource(id, { type: "geojson", data: EMPTY_FC });
    map3d.addLayer({
      id,
      type: "line",
      source: id,
      layout: { "line-cap": "round", "line-join": "round" },
      paint
    });
  };

  // Study area outline
  const [[s, w], [n, e]] = STUDY_AREA;
  map3d.addSource("fr-area", {
    type: "geojson",
    data: collection([lineFeature([[s, w], [s, e], [n, e], [n, w], [s, w]])])
  });
  map3d.addLayer({
    id: "fr-area",
    type: "line",
    source: "fr-area",
    paint: { "line-color": "#0b5ed7", "line-width": 2, "line-dasharray": [2, 2] }
  });

  addLine("fr-affected", { "line-color": "#dc3545", "line-width": 8, "line-opacity": 0.6 });
  addLine("fr-preferred", { "line-color": "#6c757d", "line-width": 5, "line-dasharray": [1.5, 2] });
  addLine("fr-blocked", { "line-color": "#dc3545", "line-width": 7, "line-dasharray": [2, 1.5] });
  addLine("fr-route", { "line-color": "#198754", "line-width": 6, "line-opacity": 0.9 });
}

// ---------- Markers ----------
function syncMarker(existing, latlng, color, title, which) {
  if (!latlng) {
    if (existing) existing.remove();
    return null;
  }
  if (!existing) {
    existing = new maplibregl.Marker({ color, draggable: !!which })
      .setLngLat([latlng.lng, latlng.lat])
      .addTo(map3d);
    existing.getElement().title = title;
    if (which) {
      existing.on("dragend", () => {
        const p = existing.getLngLat();
        setPoint(which, L.latLng(p.lat, p.lng));   // rejected points snap back in render3D()
        render3D();
      });
    }
  } else {
    existing.setLngLat([latlng.lng, latlng.lat]);
  }
  return existing;
}

// ---------- Redraw everything in 3D from the shared state ----------
function render3D() {
  if (!map3d || !map3dReady) return;

  const ok = lastRoute && lastRoute.status === "ok" && lastRoute.path && lastRoute.path.length > 1;

  map3d.getSource("fr-route").setData(ok ? lineFeature(lastRoute.path) : EMPTY_FC);
  map3d.getSource("fr-preferred").setData(
    ok && lastRoute.preferred_path ? lineFeature(lastRoute.preferred_path) : EMPTY_FC
  );
  map3d.getSource("fr-blocked").setData(
    ok ? collection((lastRoute.blocked_segments || []).map(lineFeature)) : EMPTY_FC
  );
  map3d.getSource("fr-affected").setData(
    collection((typeof affectedSegments !== "undefined" ? affectedSegments : []).map(s => lineFeature(s.coords)))
  );

  originMarker3d = syncMarker(originMarker3d, origin, "#0b5ed7", "Start (drag to move)", "origin");
  destMarker3d = syncMarker(destMarker3d, destination, "#6f42c1", "Destination (drag to move)", "destination");
  reportMarker3d = syncMarker(
    reportMarker3d,
    typeof reportMode !== "undefined" && reportMode ? reportLatLng : null,
    "#fd7e14",
    "Report location",
    null
  );
}

function fit3DToRoute(data) {
  if (!map3d || !data || data.status !== "ok" || !data.path || data.path.length < 2) return;
  const b = new maplibregl.LngLatBounds();
  data.path.forEach(p => b.extend(toLonLat(p)));
  map3d.fitBounds(b, { padding: 80, maxZoom: 17 });
}

// ---------- Wrap existing functions so 3D stays in sync ----------
// Moving a point (or placing a new one) makes the old route invalid.
const _setPoint = setPoint;
setPoint = function (which, latlng) {
  const ok = _setPoint(which, latlng);
  if (ok) lastRoute = null;
  render3D();
  return ok;
};

// Remember the route, draw it in 3D, and keep the 2D view from being messed up by fitBounds
// while its container is hidden.
const _showRoute = showRoute;
showRoute = function (data) {
  lastRoute = data;
  if (is3D) {
    const center = map.getCenter(), zoom = map.getZoom();
    _showRoute(data);
    map.setView(center, zoom, { animate: false });
    fit3DToRoute(data);
  } else {
    _showRoute(data);
  }
  render3D();
};

// Closing the report form removes its temporary marker
const _closeReport = closeReport;
closeReport = function () {
  _closeReport();
  render3D();
};
document.getElementById("report-cancel").addEventListener("click", render3D);

// Clear button: route.js has already reset the points by the time this runs
document.getElementById("clear-btn").addEventListener("click", () => {
  lastRoute = null;
  render3D();
});

// ---------- Hook into the 3D map when app.js creates it ----------
const _init3D = init3D;
init3D = function () {
  _init3D();

  map3d.on("load", () => {
    setup3DLayers();
    map3dReady = true;
    render3D();
  });

  // Forward 3D clicks to the 2D map's click handlers (route.js and report.js)
  map3d.on("click", e => {
    const t = e.originalEvent && e.originalEvent.target;
    if (t && t.closest && t.closest(".maplibregl-marker")) return;   // clicked a marker, not the map
    map.fire("click", { latlng: L.latLng(e.lngLat.lat, e.lngLat.lng) });
    render3D();
  });
};