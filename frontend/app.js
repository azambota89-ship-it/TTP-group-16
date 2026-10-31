// ---------- Config ----------
const API = "http://localhost:5000";   // real backend (used later)
const USE_MOCK = true;                 // set to false when the backend is ready

// Free CARTO basemap key (carto.com/basemaps/apikey). This one is meant for the browser.
const CARTO_KEY = "cb1_4y6j_1_17de6837e608954b74df71d6";

// Approximate centre of Kampar and the study-area bounds (adjust to your chosen roads)
const KAMPAR_CENTER = [4.3085, 101.1530];
const STUDY_AREA = [[4.290, 101.125], [4.335, 101.175]]; // [[south, west], [north, east]]

// ---------- Map setup ----------
const map = L.map("map").setView(KAMPAR_CENTER, 14);

// NOTE: tile.openstreetmap.org shows an "Access blocked" tile if the page has no
// valid Referer (e.g. opened from file://). CARTO tiles (built on OSM data) now
// need a free key, which is appended to the URL below.
L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, {
  maxZoom: 19,
  subdomains: "abcd",
  referrerPolicy: "strict-origin-when-cross-origin",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
}).addTo(map);

// Outline of the area the prototype covers
L.rectangle(STUDY_AREA, {
  color: "#0b5ed7",
  weight: 2,
  fill: false,
  dashArray: "6 6"
}).addTo(map).bindTooltip("Study area", { sticky: true });

// ---------- Flood markers ----------
const floodLayer = L.layerGroup().addTo(map);
let currentFloods = [];   // kept so the 3D view can draw the same data

// Marker colour by source/status (matches the legend in style.css)
function floodColor(flood) {
  if (flood.status === "verified") return "#dc3545";   // verified report
  if (flood.source === "user") return "#fd7e14";       // unverified user report
  return "#0d6efd";                                    // met / official data
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function floodPopup(flood) {
  const when = new Date(flood.reported_at).toLocaleString("en-MY");
  const sample = flood.sample ? "<br><em>Sample data, not a live report</em>" : "";
  return `
    <strong>${esc(flood.description) || "Reported flood"}</strong><br>
    Source: ${esc(flood.source)}<br>
    Status: ${esc(flood.status)}<br>
    Reported: ${esc(when)}${sample}
  `;
}

function drawFloods(floods) {
  currentFloods = floods;
  floodLayer.clearLayers();
  floods.forEach(f => {
    L.circleMarker([f.lat, f.lon], {
      radius: 9,
      color: "#fff",
      weight: 2,
      fillColor: floodColor(f),
      fillOpacity: 0.9
    }).bindPopup(floodPopup(f)).addTo(floodLayer);
  });
}

async function loadFloods() {
  const url = USE_MOCK ? "mock/floods.json" : `${API}/floods`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const floods = await res.json();
    drawFloods(floods);
  } catch (err) {
    console.error("Could not load flood data:", err);
    document.getElementById("result").textContent =
      "Could not load flood information. Please check official sources.";
  }
}

// ---------- 2D / 3D toggle ----------
// 2D = Leaflet (above). 3D = MapLibre GL with tilted view and 3D buildings.
let map3d = null;
let markers3d = [];
let is3D = false;

function draw3DFloods() {
  if (!map3d) return;
  markers3d.forEach(m => m.remove());
  markers3d = currentFloods.map(f => {
    const el = document.createElement("div");
    el.className = "flood-marker-3d";
    el.style.background = floodColor(f);
    const popup = new maplibregl.Popup({ offset: 12 }).setHTML(floodPopup(f));
    return new maplibregl.Marker({ element: el })
      .setLngLat([f.lon, f.lat])     // MapLibre uses [lon, lat], Leaflet uses [lat, lon]
      .setPopup(popup)
      .addTo(map3d);
  });
}

function init3D() {
  map3d = new maplibregl.Map({
    container: "map3d",
    style: "https://tiles.openfreemap.org/styles/liberty",
    center: [KAMPAR_CENTER[1], KAMPAR_CENTER[0]],
    zoom: 15.5,
    pitch: 60,
    bearing: -20
  });
  map3d.addControl(new maplibregl.NavigationControl());
  draw3DFloods();
}

document.getElementById("view-toggle-btn").addEventListener("click", () => {
  is3D = !is3D;
  document.getElementById("map").hidden = is3D;
  document.getElementById("map3d").hidden = !is3D;
  document.getElementById("view-toggle-btn").textContent = is3D ? "2D view" : "3D view";

  if (is3D) {
    if (!map3d) init3D(); else map3d.resize();
    draw3DFloods();
  } else {
    map.invalidateSize();   // Leaflet needs this after being hidden
  }
});

loadFloods();

/*
fetch(`${API}/floods`)
fetch(`${API}/route`, { method: "POST",  })
*/