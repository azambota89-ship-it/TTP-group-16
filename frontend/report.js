// report.js: let users report a flood by clicking the map.
// Loaded AFTER app.js and route.js (uses map, API, USE_MOCK, studyBounds,
// currentFloods, drawFloods, draw3DFloods, loadFloods, setResult, map3d).

let reportMode = false;
let reportLatLng = null;
let reportMarker = null;

const reportBtn = document.getElementById("report-btn");

const TYPE_LABELS = {
  impassable: "Road flooded, impassable",
  passable: "Water over road, passable with care",
  standing: "Standing water after heavy rain"
};

// ---------- Build the form (hidden until "Report flood" is pressed) ----------
const reportForm = document.createElement("div");
reportForm.id = "report-form";
reportForm.hidden = true;
reportForm.innerHTML = `
  <h3>Report a flood</h3>
  <p id="report-location">Click the map to choose the location.</p>

  <label>What did you see?<br>
    <select id="report-type">
      <option value="impassable">${TYPE_LABELS.impassable}</option>
      <option value="passable">${TYPE_LABELS.passable}</option>
      <option value="standing">${TYPE_LABELS.standing}</option>
    </select>
  </label>

  <label>Road name (optional)<br>
    <input id="report-road" type="text" maxlength="80">
  </label>

  <label>Details (optional)<br>
    <textarea id="report-desc" rows="2" maxlength="200"></textarea>
  </label>

  <p class="report-note">Reports are unverified until checked and may expire.</p>

  <button id="report-submit" disabled>Submit report</button>
  <button id="report-cancel">Cancel</button>
`;
document.getElementById("result").insertAdjacentElement("beforebegin", reportForm);

const submitBtn = document.getElementById("report-submit");
const cancelBtn = document.getElementById("report-cancel");
const locationText = document.getElementById("report-location");

// ---------- Open / close report mode ----------
function openReport() {
  reportMode = true;
  reportLatLng = null;
  reportForm.hidden = false;
  submitBtn.disabled = true;
  locationText.textContent = "Click the map to choose the location.";
  map.getContainer().style.cursor = "crosshair";
  setResult("", "info");
}

function closeReport() {
  reportMode = false;
  reportLatLng = null;
  reportForm.hidden = true;
  if (reportMarker) { map.removeLayer(reportMarker); reportMarker = null; }
  document.getElementById("report-road").value = "";
  document.getElementById("report-desc").value = "";
  map.getContainer().style.cursor = "";
}

reportBtn.addEventListener("click", () => (reportMode ? closeReport() : openReport()));
cancelBtn.addEventListener("click", closeReport);

// ---------- Choose the location ----------
map.on("click", e => {
  if (!reportMode) return;

  if (!studyBounds.contains(e.latlng)) {
    locationText.textContent = "That spot is outside the study area. Pick a point inside the dashed box.";
    return;
  }
  reportLatLng = e.latlng;
  locationText.textContent = `Location: ${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
  submitBtn.disabled = false;

  if (reportMarker) reportMarker.setLatLng(e.latlng);
  else reportMarker = L.circleMarker(e.latlng, {
    radius: 10, color: "#fff", weight: 2, fillColor: "#fd7e14", fillOpacity: 0.9
  }).addTo(map);
});

// ---------- Submit ----------
submitBtn.addEventListener("click", async () => {
  if (!reportLatLng) return;

  const type = document.getElementById("report-type").value;
  const road = document.getElementById("report-road").value.trim();
  const details = document.getElementById("report-desc").value.trim();

  // Server should set reported_at and status itself; we only send what the user entered.
  const payload = {
    lat: reportLatLng.lat,
    lon: reportLatLng.lng,
    type,
    road_name: road,
    description: details
  };

  submitBtn.disabled = true;
  try {
    if (USE_MOCK) {
      const label = TYPE_LABELS[type] + (road ? ` (${road})` : "") + (details ? `: ${details}` : "");
      const fake = {
        id: Date.now(),
        lat: payload.lat,
        lon: payload.lon,
        source: "user",
        status: "pending",
        reported_at: new Date().toISOString(),
        description: label,
        sample: true
      };
      drawFloods([...currentFloods, fake]);
      draw3DFloods();
    } else {
      const res = await fetch(`${API}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadFloods();     // reload so the new pending report shows up
      draw3DFloods();
    }
    closeReport();
    setResult("Thank you. Your report was added as pending and is not yet verified.", "success");
  } catch (err) {
    console.error("Report failed:", err);
    submitBtn.disabled = false;
    setResult("Could not send your report. Please try again.", "error");
  }
});