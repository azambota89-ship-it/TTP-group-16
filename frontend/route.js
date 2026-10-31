// route.js: pick start/destination, request a route, draw it.
// Loaded AFTER app.js, so it can use map, API, USE_MOCK and STUDY_AREA from there.

const studyBounds = L.latLngBounds(STUDY_AREA);
const routeLayer = L.layerGroup().addTo(map);

let origin = null;        // L.LatLng
let destination = null;   // L.LatLng
let originMarker = null;
let destMarker = null;

const originText = document.getElementById("origin-text");
const destText = document.getElementById("dest-text");
const findBtn = document.getElementById("find-route-btn");
const clearBtn = document.getElementById("clear-btn");
const resultBox = document.getElementById("result");

// ---------- Helpers ----------
function fmt(latlng) {
  return `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
}

function setResult(message, type) {
  // type: "info" | "success" | "warning" | "error"
  const colors = {
    info: "#e7f1ff",
    success: "#d1e7dd",
    warning: "#fff3cd",
    error: "#f8d7da"
  };
  resultBox.textContent = message;
  resultBox.style.background = message ? (colors[type] || "transparent") : "transparent";
}

function refreshPanel() {
  originText.textContent = origin ? fmt(origin) : "not set";
  destText.textContent = destination ? fmt(destination) : "not set";
  findBtn.disabled = !(origin && destination);
}

function makeMarker(latlng, label, onMove) {
  const m = L.marker(latlng, { draggable: true }).addTo(map);
  m.bindTooltip(label, { permanent: true, direction: "top", offset: [-15, -20] });
  m.on("dragend", () => onMove(m.getLatLng()));
  return m;
}

function setPoint(which, latlng) {
  if (!studyBounds.contains(latlng)) {
    setResult("That point is outside the study area. Please pick a point inside the dashed box.", "warning");
    return false;
  }
  if (which === "origin") {
    origin = latlng;
    if (originMarker) originMarker.setLatLng(latlng);
    else originMarker = makeMarker(latlng, "Start", p => setPoint("origin", p));
  } else {
    destination = latlng;
    if (destMarker) destMarker.setLatLng(latlng);
    else destMarker = makeMarker(latlng, "Destination", p => setPoint("destination", p));
  }
  routeLayer.clearLayers();     // old route no longer matches the points
  setResult("", "info");
  refreshPanel();
  return true;
}

// ---------- Click on map to pick points ----------
map.on("click", e => {
  if (typeof reportMode !== "undefined" && reportMode) return;   // report.js is using the click
  if (!origin) setPoint("origin", e.latlng);
  else if (!destination) setPoint("destination", e.latlng);
  else setResult("Both points are set. Drag a marker to move it, or press Clear to start over.", "info");
});

// ---------- Clear ----------
clearBtn.addEventListener("click", () => {
  if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
  if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
  origin = null;
  destination = null;
  routeLayer.clearLayers();
  setResult("", "info");
  refreshPanel();
});

// ---------- Mock backend response ----------
// Same shape the real POST /route should return:
// { status: "ok" | "no_route", path: [[lat, lon], ...], distance: metres,
//   blocked_segments: [ [[lat, lon], [lat, lon]], ... ] }
function mockRoute(o, d, forceNoRoute) {
  if (forceNoRoute) return { status: "no_route", path: [], distance: 0, blocked_segments: [] };

  const mid = [(o.lat + d.lat) / 2 + 0.002, (o.lng + d.lng) / 2 + 0.002];   // fake detour
  const path = [[o.lat, o.lng], mid, [d.lat, d.lng]];
  let distance = 0;
  for (let i = 1; i < path.length; i++) {
    distance += map.distance(path[i - 1], path[i]);
  }
  const straightMid = [(o.lat + d.lat) / 2, (o.lng + d.lng) / 2];
  return {
    status: "ok",
    path,
    distance,
    blocked_segments: [[
      [straightMid[0] - 0.0005, straightMid[1] - 0.0005],
      [straightMid[0] + 0.0005, straightMid[1] + 0.0005]
    ]]
  };
}

// ---------- Find route ----------
async function findRoute(forceNoRoute) {
  findBtn.disabled = true;
  setResult("Finding route...", "info");
  routeLayer.clearLayers();

  try {
    let data;
    if (USE_MOCK) {
      if (forceNoRoute) {
        data = mockRoute(origin, destination, true);       // Shift+click test of the no-route message
      } else if (typeof localRoute === "function") {
        setResult("Loading road data and finding route...", "info");
        data = await localRoute(origin, destination);      // real roads, calculated in the browser (localroute.js)
      } else {
        await new Promise(r => setTimeout(r, 400));       // old fake route if localroute.js is not loaded
        data = mockRoute(origin, destination, false);
      }
    } else {
      const res = await fetch(`${API}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: { lat: origin.lat, lon: origin.lng },
          destination: { lat: destination.lat, lon: destination.lng }
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    }
    showRoute(data);
  } catch (err) {
    console.error("Route request failed:", err);
    setResult("Could not get a route right now. Please try again, and check official sources for road conditions.", "error");
  } finally {
    findBtn.disabled = !(origin && destination);
  }
}

function showRoute(data) {
  routeLayer.clearLayers();

  if (data.status !== "ok" || !data.path || data.path.length < 2) {
    const msg = data.reason === "far_from_road"
      ? "One of your points is too far from a mapped road. Move the marker closer to a road."
      : "No alternative route was found with the available data. Do not assume any route is safe; check official announcements.";
    setResult(msg, "warning");
    return;
  }

  // The usual route (grey dashed) is shown only when a flood forced a change
  if (data.preferred_path) {
    L.polyline(data.preferred_path, { color: "#6c757d", weight: 5, dashArray: "4 8" })
      .bindTooltip("Usual route (passes a reported flood)")
      .addTo(routeLayer);
  }

  const line = L.polyline(data.path, { color: "#198754", weight: 6, opacity: 0.85 }).addTo(routeLayer);

  (data.blocked_segments || []).forEach(seg => {
    L.polyline(seg, { color: "#dc3545", weight: 7, dashArray: "8 8" })
      .bindTooltip("Avoided: reported flood")
      .addTo(routeLayer);
  });

  map.fitBounds(line.getBounds(), { padding: [40, 40] });

  const km = (data.distance / 1000).toFixed(2);
  const note = data.note || (USE_MOCK ? "sample route for testing" : "");
  const noteText = note ? ` (${note})` : "";
  const roads = (data.blocked_roads || []).join(", ") || "a road near a reported flood";

  const msg = data.rerouted
    ? `Your usual route passes a reported flood on ${roads}. Alternative route: ${km} km${noteText}.`
    : `Route found: ${km} km${noteText}. No reported flood on this route.`;
  setResult(`${msg} This is a suggestion only. Conditions may change, so follow official warnings.`, data.rerouted ? "warning" : "success");
}

// Shift+click on "Find route" tests the no-route message while using mock data
findBtn.addEventListener("click", e => findRoute(USE_MOCK && e.shiftKey));

refreshPanel();