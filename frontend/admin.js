// admin.js: admin login + report management.
//
// SECURITY NOTE: the browser cannot protect anything by itself. Every admin endpoint on the
// backend MUST check the token and return 401 when it is missing or wrong. This page only
// shows or hides screens; the real protection is on C's server.

// ---------- Config (keep API / USE_MOCK in sync with app.js) ----------
const API = "http://localhost:5000";
const USE_MOCK = true;                       // set to false when the backend is ready
const CARTO_KEY = "cb1_4y6j_1_17de6837e608954b74df71d6";
const KAMPAR_CENTER = [4.3085, 101.1530];

// Demo login, used ONLY while USE_MOCK is true. Never used against the real backend.
const DEMO_USER = "admin";
const DEMO_PASS = "admin123";

const STATUS_COLORS = {
  pending: "#fd7e14", verified: "#dc3545", rejected: "#6c757d", expired: "#adb5bd", reported: "#0d6efd"
};
const FILTERS = ["pending", "verified", "expired", "rejected", "all"];

// ---------- Small helpers ----------
const $ = id => document.getElementById(id);
const delay = ms => new Promise(r => setTimeout(r, ms));

function el(tag, props, text) {
  const node = document.createElement(tag);
  Object.assign(node, props || {});
  if (text !== undefined) node.textContent = text;   // textContent, never innerHTML: report text is untrusted
  return node;
}

const TOKEN_KEY = "fr_admin_token";
const USER_KEY = "fr_admin_user";
function storeSet(key, value) {
  try { value == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
}
function storeGet(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}

// ---------- State ----------
let token = null;
let username = null;
let reports = [];
let filter = "pending";
let selectedId = null;
let mockData = null;
let adminMap = null;
let markerLayer = null;
const markers = new Map();   // id -> Leaflet marker

// ---------- Messages ----------
function setMsg(text, type) {
  const box = $("status-msg");
  box.textContent = text || "";
  box.className = type || "";
}

// ---------- Login / logout ----------
function showLogin(message) {
  $("login-view").hidden = false;
  $("dashboard-view").hidden = true;
  $("session").hidden = true;
  $("login-error").textContent = message || "";
  $("password").value = "";
}

function showDashboard() {
  $("login-view").hidden = true;
  $("dashboard-view").hidden = false;
  $("session").hidden = false;
  $("whoami").textContent = `Logged in as ${username || "admin"}`;
  initMap();
  refresh();
}

function logout(message) {
  token = null;
  username = null;
  storeSet(TOKEN_KEY, null);
  storeSet(USER_KEY, null);
  showLogin(message);
}

async function doLogin(user, pass) {
  if (USE_MOCK) {
    await delay(300);
    if (user === DEMO_USER && pass === DEMO_PASS) return { token: "demo-token", username: user };
    const err = new Error("bad credentials");
    err.code = "BAD_CREDENTIALS";
    throw err;
  }
  const res = await fetch(`${API}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user, password: pass })
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error("bad credentials");
    err.code = "BAD_CREDENTIALS";
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();          // expected: { token: "...", username: "..." }
}

$("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true;
  $("login-error").textContent = "";
  try {
    const data = await doLogin($("username").value.trim(), $("password").value);
    token = data.token;
    username = data.username || $("username").value.trim();
    storeSet(TOKEN_KEY, token);
    storeSet(USER_KEY, username);
    showDashboard();
  } catch (err) {
    $("login-error").textContent = err.code === "BAD_CREDENTIALS"
      ? "Wrong username or password."
      : "Could not reach the server. Please try again.";
  } finally {
    btn.disabled = false;
    $("password").value = "";
  }
});

$("logout-btn").addEventListener("click", () => logout());

// ---------- API calls ----------
async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  if (res.status === 401 || res.status === 403) {
    logout("Your session has expired. Please log in again.");
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function loadReports() {
  if (USE_MOCK) {
    if (!mockData) {
      const res = await fetch("mock/floods.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mockData = await res.json();
      const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
      mockData.push(
        { id: 4, lat: 4.3125, lon: 101.1555, source: "user", status: "pending", reported_at: ago(1), description: "Standing water after heavy rain (sample)", sample: true },
        { id: 5, lat: 4.3070, lon: 101.1520, source: "user", status: "expired", reported_at: ago(30), description: "Water over road, passable with care (sample)", sample: true }
      );
    }
    return mockData;
  }
  return api("/admin/reports");        // expected: array of reports, all statuses
}

async function setStatus(report, status) {
  if (USE_MOCK) { report.status = status; return; }
  await api(`/admin/reports/${encodeURIComponent(report.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
  report.status = status;
}

async function removeReport(report) {
  if (USE_MOCK) {
    mockData = mockData.filter(r => r.id !== report.id);
    return;
  }
  await api(`/admin/reports/${encodeURIComponent(report.id)}`, { method: "DELETE" });
}

// ---------- Actions ----------
async function act(report, kind) {
  if (kind === "delete" && !confirm(`Delete report #${report.id} permanently?`)) return;

  setMsg("Saving...", "");
  document.querySelectorAll(".actions button").forEach(b => (b.disabled = true));
  try {
    if (kind === "delete") await removeReport(report);
    else await setStatus(report, kind);          // kind is verified | rejected | expired
    if (kind === "delete") reports = reports.filter(r => r.id !== report.id);
    setMsg(kind === "delete" ? `Report #${report.id} deleted.` : `Report #${report.id} marked ${kind}.`, "success");
  } catch (err) {
    if (err.message !== "unauthorized") setMsg("Could not save the change. Please try again.", "error");
  }
  render();
}

async function refresh() {
  setMsg("Loading reports...", "");
  try {
    reports = await loadReports();
    setMsg("", "");
  } catch (err) {
    if (err.message !== "unauthorized") setMsg("Could not load reports. Check that the server is running.", "error");
    reports = [];
  }
  render();
}

$("refresh-btn").addEventListener("click", refresh);

// ---------- Map ----------
function initMap() {
  if (adminMap) { adminMap.invalidateSize(); return; }
  adminMap = L.map("admin-map").setView(KAMPAR_CENTER, 14);
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`, {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(adminMap);
  markerLayer = L.layerGroup().addTo(adminMap);
}

function drawMarkers(list) {
  if (!markerLayer) return;
  markerLayer.clearLayers();
  markers.clear();
  list.forEach(r => {
    const m = L.circleMarker([r.lat, r.lon], {
      radius: r.id === selectedId ? 13 : 9,
      color: r.id === selectedId ? "#212529" : "#fff",
      weight: r.id === selectedId ? 3 : 2,
      fillColor: STATUS_COLORS[r.status] || "#0d6efd",
      fillOpacity: 0.9
    }).addTo(markerLayer);
    m.bindTooltip(`#${r.id} ${r.status}`);
    m.on("click", () => select(r.id, false));
    markers.set(r.id, m);
  });
}

function select(id, pan = true) {
  selectedId = id;
  render();
  const r = reports.find(x => x.id === id);
  if (r && pan && adminMap) adminMap.setView([r.lat, r.lon], Math.max(adminMap.getZoom(), 16));
  const row = document.querySelector(`tr[data-id="${CSS.escape(String(id))}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

// ---------- Rendering ----------
function visibleReports() {
  return filter === "all" ? reports : reports.filter(r => r.status === filter);
}

function renderFilters() {
  const counts = { all: reports.length };
  reports.forEach(r => (counts[r.status] = (counts[r.status] || 0) + 1));

  const box = $("filters");
  box.replaceChildren();
  FILTERS.forEach(f => {
    const b = el("button", { type: "button", className: "filter-btn" + (f === filter ? " active" : "") },
      `${f[0].toUpperCase() + f.slice(1)} (${counts[f] || 0})`);
    b.addEventListener("click", () => { filter = f; render(); });
    box.appendChild(b);
  });
}

function actionButtons(r) {
  const cell = el("td", { className: "actions" });
  if (r.source !== "user") {
    cell.appendChild(el("span", { className: "readonly" }, "Official data (read only)"));
    return cell;
  }
  const add = (label, cls, kind) => {
    const b = el("button", { type: "button", className: cls }, label);
    b.addEventListener("click", e => { e.stopPropagation(); act(r, kind); });
    cell.appendChild(b);
  };
  if (r.status !== "verified") add("Verify", "btn-verify", "verified");
  if (r.status !== "rejected") add("Reject", "btn-reject", "rejected");
  if (r.status !== "expired") add("Expire", "btn-expire", "expired");
  add("Delete", "btn-delete", "delete");
  return cell;
}

function render() {
  renderFilters();

  const list = visibleReports().slice().sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at));
  const body = $("report-rows");
  body.replaceChildren();

  list.forEach(r => {
    const tr = el("tr", { className: r.id === selectedId ? "selected" : "" });
    tr.dataset.id = r.id;
    tr.addEventListener("click", () => select(r.id));

    const when = new Date(r.reported_at).toLocaleString("en-MY");
    const details = [r.description, r.road_name ? `Road: ${r.road_name}` : ""].filter(Boolean).join(" | ");

    tr.appendChild(el("td", {}, `#${r.id}`));
    tr.appendChild(el("td", {}, when));
    tr.appendChild(el("td", {}, r.source));
    tr.appendChild(el("td", {}, details || "No details"));

    const statusCell = el("td");
    statusCell.appendChild(el("span", { className: `badge badge-${r.status}` }, r.status));
    tr.appendChild(statusCell);

    tr.appendChild(actionButtons(r));
    body.appendChild(tr);
  });

  $("empty-msg").hidden = list.length > 0;
  drawMarkers(list);
}

// ---------- Start ----------
if (USE_MOCK) {
  $("login-hint").hidden = false;
  $("login-hint").textContent = `Demo mode: log in with ${DEMO_USER} / ${DEMO_PASS}. This is not secure. With the real backend, login is checked by the server.`;
}

token = storeGet(TOKEN_KEY);
username = storeGet(USER_KEY);
if (token) showDashboard(); else showLogin();