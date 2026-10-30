// ---------- Config ----------
const API = "http://localhost:5000";   // real backend (used later)
const USE_MOCK = true;                 // set to false when the backend is ready

// Approximate centre of Kampar and the study-area bounds (adjust to your chosen roads)
const KAMPAR_CENTER = [4.3085, 101.1530];
const STUDY_AREA = [[4.290, 101.125], [4.335, 101.175]]; // [[south, west], [north, east]]

// ---------- Map setup ----------
const map = L.map("map").setView(KAMPAR_CENTER, 14);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
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

// Marker colour by source/status (matches the legend in style.css)
function floodColor(flood) {
  if (flood.status === "verified") return "#dc3545";   // verified report
  if (flood.source === "user") return "#fd7e14";       // unverified user report
  return "#0d6efd";                                    // met / official data
}

function floodPopup(flood) {
  const when = new Date(flood.reported_at).toLocaleString("en-MY");
  const sample = flood.sample ? "<br><em>Sample data, not a live report</em>" : "";
  return `
    <strong>${flood.description || "Reported flood"}</strong><br>
    Source: ${flood.source}<br>
    Status: ${flood.status}<br>
    Reported: ${when}${sample}
  `;
}

function drawFloods(floods) {
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

loadFloods();

/*
fetch(`${API}/floods`)
fetch(`${API}/route`, { method: "POST",  })
*/