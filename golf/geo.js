// 골프장 홀맵 - 순수 계산/데이터 가공 로직 (브라우저 + Node 테스트 공용)

(function (root) {
  const R = 6371008.8; // 지구 평균 반지름(m)
  const M_TO_YD = 1.0936133;

  const rad = (d) => (d * Math.PI) / 180;

  // 두 좌표({lat, lon}) 사이 거리(m)
  function distance(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function pathLength(points) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += distance(points[i - 1], points[i]);
    return sum;
  }

  // origin 기준 평면 좌표(m)로 변환 - 홀 하나 크기에서는 오차 무시 가능
  function toLocal(origin, p) {
    return {
      x: rad(p.lon - origin.lon) * R * Math.cos(rad(origin.lat)),
      y: rad(p.lat - origin.lat) * R,
    };
  }

  function centroid(points) {
    const pts =
      points.length > 1 &&
      points[0].lat === points[points.length - 1].lat &&
      points[0].lon === points[points.length - 1].lon
        ? points.slice(0, -1)
        : points;
    const sum = pts.reduce((s, p) => ({ lat: s.lat + p.lat, lon: s.lon + p.lon }), { lat: 0, lon: 0 });
    return { lat: sum.lat / pts.length, lon: sum.lon / pts.length };
  }

  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) {
        inside = !inside;
      }
    }
    return inside;
  }

  const toYd = (m) => m * M_TO_YD;

  function formatDist(m, unit) {
    if (m == null || !isFinite(m)) return "-";
    return unit === "yd" ? `${Math.round(toYd(m))}yd` : `${Math.round(m)}m`;
  }

  // ---------- 검색어 처리 ----------

  const SUFFIXES = [
    "컨트리클럽", "골프클럽", "골프앤리조트", "골프&리조트", "골프리조트", "골프장", "골프코스",
    "country club", "golf club", "golf resort", "golf course", "golf & resort",
    "c\\.c\\.?", "g\\.c\\.?", "cc", "gc",
  ];

  function normalizeQuery(q) {
    let s = String(q || "").trim().toLowerCase();
    for (const suf of SUFFIXES) s = s.replace(new RegExp(`\\s*${suf}\\s*$`, "i"), "");
    s = s.replace(/\s+/g, "");
    return s || String(q || "").trim().toLowerCase().replace(/\s+/g, "");
  }

  // Overpass(POSIX ERE)용 정규식: 글자 사이 공백 허용
  function overpassRegex(q) {
    const chars = [...normalizeQuery(q)];
    return chars
      .map((c) => (/[.^$*+?()[\]{}|\\]/.test(c) ? `\\${c}` : c))
      .map((c) => (c === '"' ? '\\"' : c))
      .join("[ ]*");
  }

  // ---------- 홀 데이터 가공 ----------

  function holeNumber(tags) {
    const raw = tags.ref || tags["golf:hole"] || tags.name || "";
    const m = String(raw).match(/(\d{1,2})/);
    return m ? parseInt(m[1], 10) : null;
  }

  // 홀 태그에서 코스 이름 추정 (예: "동코스 3번홀" -> "동코스")
  function courseKeyFromTags(tags) {
    const explicit = tags["golf:course:name"] || tags["golf:course"] || tags.course;
    if (explicit) return String(explicit).trim();
    const name = tags.name || "";
    const stripped = name
      .replace(/hole|no\.?|번홀|번|홀|#/gi, " ")
      .replace(/\d+/g, " ")
      .replace(/[-_:,()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped;
  }

  function wayPoints(el) {
    return (el.geometry || []).filter(Boolean).map((g) => ({ lat: g.lat, lon: g.lon }));
  }

  function num(v) {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/[^\d.]/g, ""));
    return isFinite(n) ? n : null;
  }

  // Overpass 응답 -> { holes, features }
  function parseElements(elements) {
    const holes = [];
    const features = [];
    for (const el of elements || []) {
      if (el.type !== "way" || !el.tags || !el.geometry) continue;
      const golf = el.tags.golf;
      const pts = wayPoints(el);
      if (pts.length < 2) continue;
      if (golf === "hole") {
        holes.push({
          id: el.id,
          tags: el.tags,
          ref: holeNumber(el.tags),
          par: num(el.tags.par),
          handicap: num(el.tags.handicap),
          taggedDist: num(el.tags.dist),
          courseKey: courseKeyFromTags(el.tags),
          points: pts,
          length: pathLength(pts),
        });
      } else if (golf) {
        features.push({ id: el.id, type: golf, points: pts });
      }
    }
    return { holes, features };
  }

  // 같은 번호의 홀이 여러 개면(27/36홀) 전 홀 그린 -> 다음 홀 티 거리로 체인을 만들어 코스 분리
  function chainHoles(holes) {
    const byRef = new Map();
    const noRef = [];
    for (const h of holes) {
      if (h.ref == null) noRef.push(h);
      else {
        if (!byRef.has(h.ref)) byRef.set(h.ref, []);
        byRef.get(h.ref).push(h);
      }
    }
    const refs = [...byRef.keys()].sort((a, b) => a - b);
    if (!refs.length) return noRef.length ? [noRef] : [];

    const chains = byRef.get(refs[0]).map((h) => [h]);
    for (const r of refs.slice(1)) {
      const cands = byRef.get(r).slice();
      const pairs = [];
      chains.forEach((chain, ci) => {
        const last = chain[chain.length - 1];
        const green = last.points[last.points.length - 1];
        cands.forEach((h, hi) => pairs.push({ ci, hi, d: distance(green, h.points[0]) }));
      });
      pairs.sort((a, b) => a.d - b.d);
      const usedC = new Set();
      const usedH = new Set();
      for (const p of pairs) {
        if (usedC.has(p.ci) || usedH.has(p.hi)) continue;
        usedC.add(p.ci);
        usedH.add(p.hi);
        chains[p.ci].push(cands[p.hi]);
      }
      // 체인보다 홀이 많으면 새 체인으로 시작
      cands.forEach((h, hi) => {
        if (!usedH.has(hi)) chains.push([h]);
      });
    }
    if (noRef.length) chains.push(noRef);
    return chains;
  }

  const GROUP_LETTERS = "ABCDEFGH";

  // 홀들을 코스(그룹)로 나눔: [{ key, label, holes: [...] }]
  function groupHoles(holes) {
    const byKey = new Map();
    for (const h of holes) {
      const k = h.courseKey || "";
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(h);
    }
    // 이름 키가 홀마다 제각각(예: 홀 고유 이름)이면 키를 무시
    const meaningful = [...byKey.entries()].filter(([k, hs]) => k && hs.length >= 3);
    const covered = meaningful.reduce((s, [, hs]) => s + hs.length, 0);
    let buckets;
    if (meaningful.length && covered >= holes.length * 0.8) {
      buckets = meaningful.map(([k, hs]) => ({ key: k, holes: hs }));
      const rest = [...byKey.entries()].filter(([k, hs]) => !(k && hs.length >= 3)).flatMap(([, hs]) => hs);
      if (rest.length) buckets.push({ key: "", holes: rest });
    } else {
      buckets = [{ key: "", holes }];
    }

    const groups = [];
    let letter = 0;
    for (const b of buckets) {
      const chains = chainHoles(b.holes);
      chains.forEach((chain) => {
        chain.sort((x, y) => (x.ref ?? 99) - (y.ref ?? 99));
        let label = b.key;
        if (!label || chains.length > 1) label = `${b.key ? b.key + " " : ""}코스 ${GROUP_LETTERS[letter] || letter + 1}`.trim();
        if (!b.key || chains.length > 1) letter++;
        groups.push({ key: label, label, holes: chain });
      });
    }
    groups.sort((a, b) => b.holes.length - a.holes.length || a.label.localeCompare(b.label));
    return groups;
  }

  const COURSE_ALIASES = {
    동: ["east", "동"], 서: ["west", "서"], 남: ["south", "남"], 북: ["north", "북"],
    east: ["east", "동"], west: ["west", "서"], south: ["south", "남"], north: ["north", "북"],
    out: ["out", "front", "전반"], in: ["in", "back", "후반"],
  };

  // 사용자가 입력한 코스 텍스트("동, 서" 등)로 그룹 선택 (입력 순서 유지)
  function matchGroups(groups, courseText) {
    const terms = String(courseText || "")
      .toLowerCase()
      .split(/[,/·+&]|\s+|그리고|및/)
      .map((t) => t.replace(/코스|course/g, "").trim())
      .filter(Boolean);
    const picked = [];
    for (const t of terms) {
      const variants = COURSE_ALIASES[t] || [t];
      const g = groups.find(
        (g) => !picked.includes(g) && variants.some((v) => g.label.toLowerCase().replace(/코스|course/g, "").includes(v))
      );
      if (g) picked.push(g);
    }
    return picked;
  }

  // 기본 선택: 18홀 이상 단일 코스가 있으면 그것, 아니면 앞에서부터 18홀 채우기
  function defaultGroups(groups) {
    if (!groups.length) return [];
    if (groups[0].holes.length >= 18) return [groups[0]];
    const picked = [];
    let n = 0;
    for (const g of groups) {
      if (n >= 18) break;
      picked.push(g);
      n += g.holes.length;
    }
    return picked;
  }

  // 선택한 그룹 -> 1~18 (이상) 번호가 매겨진 홀 목록
  function buildRound(groups) {
    const out = [];
    for (const g of groups) {
      for (const h of g.holes) out.push({ ...h, no: out.length + 1, groupLabel: g.label });
    }
    return out;
  }

  // 홀 끝점 근처의 그린 폴리곤 찾기
  function findGreen(hole, features) {
    const end = hole.points[hole.points.length - 1];
    let best = null;
    let bestD = Infinity;
    for (const f of features) {
      if (f.type !== "green") continue;
      if (pointInPolygon(end, f.points)) return f;
      const d = distance(end, centroid(f.points));
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return bestD < 40 ? best : null;
  }

  // 그린 앞/중앙/뒤 지점(진입 방향 기준) 계산
  function greenTargets(hole, green) {
    const pts = hole.points;
    const end = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const center = green ? centroid(green.points) : end;
    const base = pathLength(pts.slice(0, -1)); // 마지막 꺾임점까지 거리
    if (!green) {
      return { front: null, center, back: null, centerDist: hole.length, frontDist: null, backDist: null };
    }
    const c = toLocal(prev, center);
    const len = Math.hypot(c.x, c.y) || 1;
    const ux = c.x / len;
    const uy = c.y / len;
    let min = Infinity;
    let max = -Infinity;
    let minP = null;
    let maxP = null;
    for (const p of green.points) {
      const l = toLocal(prev, p);
      const along = l.x * ux + l.y * uy;
      if (along < min) { min = along; minP = p; }
      if (along > max) { max = along; maxP = p; }
    }
    // 진입선 위로 투영한 앞/뒤 지점
    const proj = (along) => ({
      lat: prev.lat + (along * uy) / R * (180 / Math.PI),
      lon: prev.lon + (along * ux) / (R * Math.cos(rad(prev.lat))) * (180 / Math.PI),
    });
    return {
      front: minP ? proj(min) : null,
      back: maxP ? proj(max) : null,
      center,
      frontDist: base + min,
      centerDist: base + distance(prev, center),
      backDist: base + max,
    };
  }

  // 특정 위치에서 그린 앞/중앙/뒤까지 거리
  function distancesFrom(pos, targets) {
    return {
      front: targets.front ? distance(pos, targets.front) : null,
      center: distance(pos, targets.center),
      back: targets.back ? distance(pos, targets.back) : null,
    };
  }

  function guessPar(lengthM) {
    if (lengthM < 230) return 3;
    if (lengthM < 430) return 4;
    return 5;
  }

  const api = {
    distance, pathLength, centroid, pointInPolygon, toYd, formatDist,
    normalizeQuery, overpassRegex, holeNumber, courseKeyFromTags, parseElements,
    chainHoles, groupHoles, matchGroups, defaultGroups, buildRound,
    findGreen, greenTargets, distancesFrom, guessPar,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof window !== "undefined" ? window : globalThis);
