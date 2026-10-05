// 골프장 홀맵 - 화면/지도 로직
// Geo(geo.js), L(Leaflet)은 전역으로 로드됨

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const $ = (id) => document.getElementById(id);
const form = $("search-form");
const nameInput = $("name-input");
const courseInput = $("course-input");
const searchBtn = $("search-btn");
const statusEl = $("status");
const resultsEl = $("results");
const resultList = $("result-list");
const courseView = $("course-view");
const courseTitle = $("course-title");
const courseSub = $("course-sub");
const groupBox = $("group-box");
const groupChips = $("group-chips");
const holeTabs = $("hole-tabs");
const holeInfo = $("hole-info");
const scorecard = $("scorecard");
const gpsBtn = $("gps-btn");
const overviewBtn = $("overview-btn");

const state = {
  course: null, // { type, id, name, bounds }
  holes: [],
  features: [],
  groups: [],
  selected: [], // 선택한 그룹(순서 = 전반/후반)
  round: [], // 번호 매긴 홀 목록
  idx: 0,
  unit: "m",
  myPos: null,
  watchId: null,
  measurePts: [],
};

// ---------- 공통 ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function setStatus(msg, isError = false) {
  statusEl.hidden = !msg;
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", isError);
}

const fmt = (m) => Geo.formatDist(m, state.unit);
const fmtBoth = (m) =>
  m == null ? "-" : `${Math.round(m)}m <span class="muted">/ ${Math.round(Geo.toYd(m))}yd</span>`;

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass 요청 실패");
}

// ---------- 검색 ----------

async function searchCourses(name) {
  const rx = Geo.overpassRegex(name);
  const sel = (key) =>
    `way["leisure"="golf_course"]["${key}"~"${rx}",i](area.kr);relation["leisure"="golf_course"]["${key}"~"${rx}",i](area.kr);`;
  const q = `[out:json][timeout:40];area["ISO3166-1"="KR"][admin_level=2]->.kr;(${sel("name")}${sel("name:ko")}${sel("name:en")}${sel("alt_name")});out tags bb;`;

  const results = new Map();
  try {
    const data = await overpass(q);
    for (const el of data.elements || []) {
      results.set(`${el.type}/${el.id}`, {
        type: el.type,
        id: el.id,
        name: el.tags["name:ko"] || el.tags.name || el.tags["name:en"] || "(이름 없음)",
        nameEn: el.tags["name:en"] || "",
        holesTag: el.tags.holes || "",
        bounds: el.bounds,
      });
    }
  } catch (e) {
    console.warn("Overpass 검색 실패", e);
  }

  if (!results.size) {
    // Nominatim 보조 검색
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=kr&limit=15&accept-language=ko&q=${encodeURIComponent(name)}`;
      const list = await (await fetch(url)).json();
      for (const r of list) {
        if (r.type !== "golf_course" || r.osm_type === "node") continue;
        const [minlat, maxlat, minlon, maxlon] = r.boundingbox.map(Number);
        results.set(`${r.osm_type}/${r.osm_id}`, {
          type: r.osm_type,
          id: r.osm_id,
          name: r.name || r.display_name.split(",")[0],
          nameEn: "",
          holesTag: "",
          bounds: { minlat, maxlat, minlon, maxlon },
        });
      }
    } catch (e) {
      console.warn("Nominatim 검색 실패", e);
    }
  }
  return [...results.values()];
}

async function loadCourseData(course) {
  const sel = course.type === "relation" ? `rel(${course.id})` : `way(${course.id})`;
  const q = `[out:json][timeout:40];${sel}->.c;.c out geom;.c map_to_area->.a;way["golf"](area.a);out geom;`;
  let data = await overpass(q);
  let parsed = Geo.parseElements(data.elements);
  const boundary = (data.elements || []).find((e) => e.type === course.type && e.id === course.id);

  if (!parsed.holes.length && course.bounds) {
    // 영역 매칭이 안 될 때 범위(bbox)로 재시도
    const b = course.bounds;
    const pad = 0.002;
    const bbox = `${b.minlat - pad},${b.minlon - pad},${b.maxlat + pad},${b.maxlon + pad}`;
    data = await overpass(`[out:json][timeout:40];way["golf"](${bbox});out geom;`);
    parsed = Geo.parseElements(data.elements);
  }
  return { ...parsed, boundary };
}

// ---------- 지도 ----------

let map;
const layers = {};

function initMap() {
  if (map) return;
  map = L.map("map", { zoomControl: true, attributionControl: true, maxZoom: 20 }).setView([36.5, 127.8], 7);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 20,
    maxNativeZoom: 19,
    attribution: "Imagery © Esri · Data © OpenStreetMap contributors",
  }).addTo(map);
  layers.boundary = L.layerGroup().addTo(map);
  layers.features = L.layerGroup().addTo(map);
  layers.all = L.layerGroup().addTo(map);
  layers.hole = L.layerGroup().addTo(map);
  layers.measure = L.layerGroup().addTo(map);
  layers.me = L.layerGroup().addTo(map);
  map.on("click", onMapClick);
}

const ll = (p) => [p.lat, p.lon];

const FEATURE_STYLE = {
  green: { color: "#4ade80", weight: 1.5, fillOpacity: 0.25 },
  fairway: { color: "#bbf7d0", weight: 1, fillOpacity: 0.08 },
  tee: { color: "#a3e635", weight: 1.5, fillOpacity: 0.25 },
  bunker: { color: "#fde68a", weight: 1, fillOpacity: 0.3 },
  water_hazard: { color: "#60a5fa", weight: 1, fillOpacity: 0.25 },
  lateral_water_hazard: { color: "#f87171", weight: 1, fillOpacity: 0.2 },
};

function label(latlng, html, cls = "") {
  return L.marker(latlng, {
    interactive: false,
    icon: L.divIcon({ className: `map-label ${cls}`, html, iconSize: null }),
  });
}

function drawCourse(boundary) {
  layers.boundary.clearLayers();
  layers.features.clearLayers();
  if (boundary) {
    const rings =
      boundary.type === "way"
        ? [boundary.geometry || []]
        : (boundary.members || []).filter((m) => m.geometry).map((m) => m.geometry);
    for (const r of rings) {
      L.polyline(r.filter(Boolean).map((g) => [g.lat, g.lon]), { color: "#fff", weight: 1.5, dashArray: "4 4", opacity: 0.7, interactive: false }).addTo(layers.boundary);
    }
  }
  for (const f of state.features) {
    const style = FEATURE_STYLE[f.type];
    if (!style) continue;
    L.polygon(f.points.map(ll), { ...style, interactive: false }).addTo(layers.features);
  }
}

function drawAllHoles() {
  layers.all.clearLayers();
  state.round.forEach((h, i) => {
    const line = L.polyline(h.points.map(ll), { color: "#ffffff", weight: 3, opacity: 0.55 });
    line.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      selectHole(i);
    });
    line.addTo(layers.all);
    const tee = h.points[0];
    const m = L.marker(ll(tee), {
      icon: L.divIcon({ className: "hole-badge", html: String(h.no), iconSize: [24, 24] }),
    });
    m.on("click", () => selectHole(i));
    m.addTo(layers.all);
  });
}

function courseBounds() {
  const pts = state.round.length ? state.round.flatMap((h) => h.points) : state.holes.flatMap((h) => h.points);
  if (pts.length) return L.latLngBounds(pts.map(ll));
  const b = state.course && state.course.bounds;
  return b ? L.latLngBounds([b.minlat, b.minlon], [b.maxlat, b.maxlon]) : null;
}

function showOverview() {
  layers.hole.clearLayers();
  layers.measure.clearLayers();
  state.measurePts = [];
  const b = courseBounds();
  if (b) map.fitBounds(b, { padding: [20, 20] });
}

// ---------- 홀 표시 ----------

function currentHole() {
  return state.round[state.idx] || null;
}

function holeTargets(h) {
  if (!h._targets) h._targets = Geo.greenTargets(h, Geo.findGreen(h, state.features));
  return h._targets;
}

function selectHole(i) {
  if (!state.round.length) return;
  state.idx = Math.max(0, Math.min(state.round.length - 1, i));
  state.measurePts = [];
  layers.measure.clearLayers();
  renderTabs();
  renderHole(true);
}

function renderHole(fit) {
  const h = currentHole();
  layers.hole.clearLayers();
  if (!h) return;
  const t = holeTargets(h);

  L.polyline(h.points.map(ll), { color: "#facc15", weight: 4, opacity: 0.95, interactive: false }).addTo(layers.hole);

  // 꺾임점(도그렉) 누적/남은 거리
  let acc = 0;
  for (let i = 1; i < h.points.length - 1; i++) {
    acc += Geo.distance(h.points[i - 1], h.points[i]);
    const remain = Geo.distance(h.points[i], t.center);
    L.circleMarker(ll(h.points[i]), { radius: 4, color: "#facc15", fillOpacity: 1, interactive: false }).addTo(layers.hole);
    label(ll(h.points[i]), `${fmt(acc)}<br><small>남은 ${fmt(remain)}</small>`).addTo(layers.hole);
  }

  label(ll(h.points[0]), `TEE`, "tee").addTo(layers.hole);
  L.circleMarker(ll(t.center), { radius: 6, color: "#fff", fillColor: "#dc2626", fillOpacity: 1, weight: 2, interactive: false }).addTo(layers.hole);
  if (t.front) L.circleMarker(ll(t.front), { radius: 3, color: "#fff", fillOpacity: 1, interactive: false }).addTo(layers.hole);
  if (t.back) L.circleMarker(ll(t.back), { radius: 3, color: "#fff", fillOpacity: 1, interactive: false }).addTo(layers.hole);
  label(ll(t.center), `${h.no}번 · ${fmt(t.centerDist)}`, "pin").addTo(layers.hole);

  if (fit) {
    const pts = h.points.map(ll);
    if (t.back) pts.push(ll(t.back));
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 19, animate: false });
  }
  renderInfo();
}

function renderInfo() {
  const h = currentHole();
  if (!h) {
    holeInfo.innerHTML = `
      <h3>홀 데이터 없음</h3>
      <p class="muted">이 골프장은 OpenStreetMap에 홀 경로가 아직 등록되지 않았어요.
      위성사진에서 티 위치부터 차례로 탭하면 구간별·누적 거리를 잴 수 있어요.</p>
      <div id="measure-out"></div>
      <button type="button" class="ghost" id="measure-reset">측정 초기화</button>`;
    $("measure-reset").onclick = () => { state.measurePts = []; drawMeasure(); };
    drawMeasure();
    return;
  }
  const t = holeTargets(h);
  const par = h.par || Geo.guessPar(h.length);
  const parNote = h.par ? "" : ` <span class="muted small">(거리로 추정)</span>`;
  let mine = "";
  if (state.myPos) {
    const d = Geo.distancesFrom(state.myPos, t);
    mine = `
      <div class="mine">
        <p class="muted small">📍 내 위치에서</p>
        <div class="fcb">
          <div><span>앞</span><b>${fmt(d.front)}</b></div>
          <div class="c"><span>중앙</span><b>${fmt(d.center)}</b></div>
          <div><span>뒤</span><b>${fmt(d.back)}</b></div>
        </div>
      </div>`;
  }
  holeInfo.innerHTML = `
    <div class="hole-nav">
      <button type="button" class="ghost" id="prev-hole" ${state.idx === 0 ? "disabled" : ""}>◀</button>
      <h3>${h.no}번홀</h3>
      <button type="button" class="ghost" id="next-hole" ${state.idx === state.round.length - 1 ? "disabled" : ""}>▶</button>
    </div>
    <p class="muted small center">${esc(h.groupLabel)}${h.ref != null ? ` · ${h.ref}번` : ""}${h.tags.name && !/^\d+$/.test(h.tags.name) ? ` · ${esc(h.tags.name)}` : ""}</p>
    <dl class="kv">
      <dt>PAR</dt><dd>${par}${parNote}</dd>
      <dt>핸디캡</dt><dd>${h.handicap ?? "-"}</dd>
      <dt>거리(티→그린 중앙)</dt><dd>${fmtBoth(t.centerDist)}</dd>
      ${h.taggedDist ? `<dt>등록 거리</dt><dd>${Math.round(h.taggedDist)}</dd>` : ""}
    </dl>
    <p class="muted small">티에서 그린까지</p>
    <div class="fcb">
      <div><span>앞</span><b>${fmt(t.frontDist)}</b></div>
      <div class="c"><span>중앙</span><b>${fmt(t.centerDist)}</b></div>
      <div><span>뒤</span><b>${fmt(t.backDist)}</b></div>
    </div>
    ${mine}
    <div id="measure-out"></div>`;
  $("prev-hole").onclick = () => selectHole(state.idx - 1);
  $("next-hole").onclick = () => selectHole(state.idx + 1);
  drawMeasure();
}

// ---------- 지도 탭 거리 측정 ----------

function onMapClick(e) {
  const p = { lat: e.latlng.lat, lon: e.latlng.lng };
  if (currentHole()) state.measurePts = [p];
  else state.measurePts.push(p);
  drawMeasure();
}

function nearHole(pos, h) {
  return h.points.some((p) => Geo.distance(pos, p) < 700);
}

function drawMeasure() {
  layers.measure.clearLayers();
  const out = $("measure-out");
  const h = currentHole();
  if (!state.measurePts.length) {
    if (out) out.innerHTML = "";
    return;
  }
  if (h) {
    const target = state.measurePts[0];
    const t = holeTargets(h);
    const fromMe = state.myPos && nearHole(state.myPos, h);
    const origin = fromMe ? state.myPos : h.points[0];
    const d1 = Geo.distance(origin, target);
    const d2 = Geo.distance(target, t.center);
    L.polyline([ll(origin), ll(target), ll(t.center)], { color: "#38bdf8", weight: 2.5, dashArray: "6 6", interactive: false }).addTo(layers.measure);
    L.circleMarker(ll(target), { radius: 6, color: "#fff", fillColor: "#0ea5e9", fillOpacity: 1, weight: 2, interactive: false }).addTo(layers.measure);
    label(ll(target), `${fromMe ? "나" : "티"}→ ${fmt(d1)}<br>그린까지 ${fmt(d2)}`, "measure").addTo(layers.measure);
    if (out) {
      out.innerHTML = `<div class="measure-box"><p class="muted small">🎯 선택 지점</p>
        <p>${fromMe ? "내 위치" : "티"} → 지점 <b>${fmt(d1)}</b></p>
        <p>지점 → 그린 중앙 <b>${fmt(d2)}</b></p></div>`;
    }
  } else {
    const pts = state.measurePts;
    L.polyline(pts.map(ll), { color: "#38bdf8", weight: 3, interactive: false }).addTo(layers.measure);
    let acc = 0;
    pts.forEach((p, i) => {
      if (i) acc += Geo.distance(pts[i - 1], p);
      L.circleMarker(ll(p), { radius: 5, color: "#fff", fillColor: "#0ea5e9", fillOpacity: 1, weight: 2, interactive: false }).addTo(layers.measure);
      if (i) label(ll(p), fmt(acc), "measure").addTo(layers.measure);
    });
    if (out) {
      const last = pts.length > 1 ? Geo.distance(pts[pts.length - 2], pts[pts.length - 1]) : 0;
      out.innerHTML = `<div class="measure-box"><p>총 거리 <b>${fmt(acc)}</b> (${fmtBoth(acc)})</p>
        ${pts.length > 1 ? `<p class="muted small">마지막 구간 ${fmt(last)}</p>` : `<p class="muted small">다음 지점을 탭하세요</p>`}</div>`;
    }
  }
}

// ---------- 내 위치 ----------

function toggleGps() {
  if (state.watchId != null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    state.myPos = null;
    layers.me.clearLayers();
    gpsBtn.classList.remove("active");
    renderInfo();
    return;
  }
  if (!navigator.geolocation) {
    setStatus("이 브라우저는 위치 기능을 지원하지 않아요.", true);
    return;
  }
  gpsBtn.classList.add("active");
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.myPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      layers.me.clearLayers();
      L.circle(ll(state.myPos), { radius: pos.coords.accuracy, color: "#3b82f6", weight: 1, fillOpacity: 0.1, interactive: false }).addTo(layers.me);
      L.circleMarker(ll(state.myPos), { radius: 7, color: "#fff", fillColor: "#3b82f6", fillOpacity: 1, weight: 2, interactive: false }).addTo(layers.me);
      renderInfo();
    },
    (err) => {
      setStatus(`위치를 가져올 수 없어요: ${err.message}`, true);
      toggleGps();
    },
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
}

// ---------- 코스/홀 목록 ----------

function renderGroups() {
  groupBox.hidden = state.groups.length <= 1;
  groupChips.innerHTML = "";
  for (const g of state.groups) {
    const order = state.selected.indexOf(g);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (order >= 0 ? " active" : "");
    b.innerHTML = `${order >= 0 ? `<span class="order">${order === 0 ? "전반" : order === 1 ? "후반" : order + 1}</span>` : ""}${esc(g.label)} <span class="muted">${g.holes.length}홀</span>`;
    b.onclick = () => {
      if (order >= 0) state.selected.splice(order, 1);
      else state.selected.push(g);
      applySelection();
    };
    groupChips.appendChild(b);
  }
}

function applySelection() {
  state.round = Geo.buildRound(state.selected);
  state.idx = 0;
  renderGroups();
  renderTabs();
  renderScorecard();
  drawAllHoles();
  if (state.round.length) renderHole(true);
  else {
    layers.hole.clearLayers();
    showOverview();
    renderInfo();
  }
}

function renderTabs() {
  holeTabs.innerHTML = "";
  state.round.forEach((h, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hole-tab" + (i === state.idx ? " active" : "");
    b.textContent = h.no;
    b.onclick = () => selectHole(i);
    holeTabs.appendChild(b);
  });
  const active = holeTabs.querySelector(".active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
}

function renderScorecard() {
  const r = state.round;
  if (!r.length) {
    scorecard.innerHTML = `<tr><td class="muted">표시할 홀이 없어요.</td></tr>`;
    return;
  }
  const rows = r.map((h) => ({ no: h.no, par: h.par || Geo.guessPar(h.length), est: !h.par, m: holeTargets(h).centerDist, hcp: h.handicap }));
  const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
  const cols = [];
  const pushSub = (lbl, arr) => cols.push({ no: lbl, par: sum(arr, "par"), m: sum(arr, "m"), hcp: null, sub: true });
  if (r.length === 18) {
    rows.slice(0, 9).forEach((x) => cols.push(x));
    pushSub("OUT", rows.slice(0, 9));
    rows.slice(9).forEach((x) => cols.push(x));
    pushSub("IN", rows.slice(9));
  } else rows.forEach((x) => cols.push(x));
  pushSub("TOT", rows);

  const cell = (c, v) => `<td class="${c.sub ? "sub" : ""}${c.no === r[state.idx]?.no && !c.sub ? " cur" : ""}" ${c.sub ? "" : `data-no="${c.no}"`}>${v}</td>`;
  scorecard.innerHTML = `
    <tr><th>홀</th>${cols.map((c) => cell(c, c.no)).join("")}</tr>
    <tr><th>PAR</th>${cols.map((c) => cell(c, c.est ? `<i>${c.par}</i>` : c.par)).join("")}</tr>
    <tr><th>m</th>${cols.map((c) => cell(c, Math.round(c.m))).join("")}</tr>
    <tr><th>yd</th>${cols.map((c) => cell(c, Math.round(Geo.toYd(c.m)))).join("")}</tr>
    <tr><th>HCP</th>${cols.map((c) => cell(c, c.hcp ?? "")).join("")}</tr>`;
  scorecard.querySelectorAll("td[data-no]").forEach((td) => {
    td.onclick = () => selectHole(Number(td.dataset.no) - 1);
  });
}

// ---------- 흐름 ----------

async function openCourse(course) {
  state.course = course;
  resultsEl.hidden = true;
  courseView.hidden = false;
  courseTitle.textContent = course.name;
  courseSub.textContent = "홀 데이터를 불러오는 중…";
  initMap();
  map.invalidateSize();
  for (const k of Object.keys(layers)) layers[k].clearLayers();
  state.round = [];
  state.measurePts = [];
  holeTabs.innerHTML = "";
  scorecard.innerHTML = "";
  holeInfo.innerHTML = `<p class="muted">불러오는 중…</p>`;
  if (course.bounds) {
    map.fitBounds([[course.bounds.minlat, course.bounds.minlon], [course.bounds.maxlat, course.bounds.maxlon]]);
  }

  let data;
  try {
    data = await loadCourseData(course);
  } catch (e) {
    courseSub.textContent = "";
    setStatus(`홀 데이터를 불러오지 못했어요 (${e.message}). 잠시 후 다시 시도해 주세요.`, true);
    state.holes = [];
    state.features = [];
    state.groups = [];
    state.selected = [];
    applySelection();
    return;
  }
  state.holes = data.holes;
  state.features = data.features;
  state.groups = Geo.groupHoles(data.holes);
  drawCourse(data.boundary);

  const matched = Geo.matchGroups(state.groups, courseInput.value);
  state.selected = matched.length ? matched : Geo.defaultGroups(state.groups);

  const total = data.holes.length;
  courseSub.textContent = total
    ? `등록된 홀 ${total}개${state.groups.length > 1 ? ` · 코스 ${state.groups.length}개` : ""}${courseInput.value && !matched.length ? ` · '${courseInput.value}' 코스를 찾지 못해 기본 코스를 보여드려요` : ""}`
    : "OpenStreetMap에 홀 데이터가 없어 위성사진과 거리 측정만 제공돼요";
  setStatus("");
  applySelection();
  updateHash();
}

function renderResults(list) {
  resultList.innerHTML = "";
  for (const c of list) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<b>${esc(c.name)}</b>${c.nameEn && c.nameEn !== c.name ? ` <span class="muted">${esc(c.nameEn)}</span>` : ""}${c.holesTag ? ` <span class="tag">${esc(c.holesTag)}홀</span>` : ""}`;
    b.onclick = () => openCourse(c);
    li.appendChild(b);
    resultList.appendChild(li);
  }
  resultsEl.hidden = false;
}

async function runSearch() {
  const name = nameInput.value.trim();
  if (!name) return;
  searchBtn.disabled = true;
  courseView.hidden = true;
  resultsEl.hidden = true;
  setStatus(`'${name}' 검색 중… (최대 몇십 초 걸릴 수 있어요)`);
  try {
    const list = await searchCourses(name);
    if (!list.length) {
      setStatus(`'${name}'에 해당하는 골프장을 찾지 못했어요. 'CC'를 빼거나 다른 이름(영문 등)으로 검색해 보세요.`, true);
    } else if (list.length === 1) {
      await openCourse(list[0]);
    } else {
      setStatus("");
      renderResults(list);
    }
  } catch (e) {
    setStatus(`검색 중 오류가 발생했어요: ${e.message}`, true);
  } finally {
    searchBtn.disabled = false;
  }
}

function updateHash() {
  const p = new URLSearchParams();
  p.set("q", nameInput.value.trim());
  if (courseInput.value.trim()) p.set("c", courseInput.value.trim());
  if (state.course) p.set("id", `${state.course.type}/${state.course.id}`);
  history.replaceState(null, "", "#" + p.toString());
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});

document.querySelectorAll(".unit-toggle button").forEach((b) => {
  b.onclick = () => {
    state.unit = b.dataset.unit;
    document.querySelectorAll(".unit-toggle button").forEach((x) => x.classList.toggle("active", x === b));
    if (currentHole()) renderHole(false);
    else renderInfo();
  };
});

gpsBtn.onclick = toggleGps;
overviewBtn.onclick = showOverview;

document.addEventListener("keydown", (e) => {
  if (courseView.hidden || e.target.tagName === "INPUT") return;
  if (e.key === "ArrowRight") selectHole(state.idx + 1);
  if (e.key === "ArrowLeft") selectHole(state.idx - 1);
});

// 공유 링크(#q=...&c=...&id=way/123) 복원
(function restoreFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.get("q")) return;
  nameInput.value = p.get("q");
  courseInput.value = p.get("c") || "";
  const id = p.get("id");
  if (id && /^(way|relation)\/\d+$/.test(id)) {
    const [type, num] = id.split("/");
    openCourse({ type, id: Number(num), name: p.get("q"), nameEn: "", holesTag: "", bounds: null });
  } else runSearch();
})();
