// 중고차 시세 조회 앱 로직
// CAR_DATA는 assets/data.js에서 전역으로 로드됨

const form = document.getElementById("search-form");
const modelInput = document.getElementById("model-input");
const yearInput = document.getElementById("year-input");
const modelList = document.getElementById("model-list");

const resultSection = document.getElementById("result");
const resultTitle = document.getElementById("result-title");
const statCards = document.getElementById("stat-cards");
const resultBody = document.getElementById("result-body");

const emptyState = document.getElementById("empty-state");
const emptyMessage = document.getElementById("empty-message");
const suggestionsEl = document.getElementById("suggestions");

const YEAR_WINDOW = 6; // 연식 유사도 계산 시 감쇠 기준(년)
const CLOSE_MATCH_YEAR_RANGE = 2; // 시세 통계에 포함할 연식 오차 범위
const MODEL_SCORE_THRESHOLD = 0.45; // 이 값 미만인 모델은 결과에서 제외

function normalize(str) {
  return String(str).toLowerCase().replace(/\s+/g, "");
}

// 두 문자열 간 Levenshtein 거리
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function modelSimilarity(inputRaw, listing) {
  const input = normalize(inputRaw);
  const modelOnly = normalize(listing.model);
  const withMaker = normalize(listing.manufacturer + listing.model);

  if (!input) return 0;
  if (modelOnly === input) return 1;
  if (modelOnly.includes(input) || input.includes(modelOnly)) return 0.88;
  if (withMaker.includes(input)) return 0.7;

  const dist = levenshtein(input, modelOnly);
  const maxLen = Math.max(input.length, modelOnly.length);
  return Math.max(0, 1 - dist / maxLen);
}

function yearSimilarity(inputYear, listingYear) {
  const diff = Math.abs(listingYear - inputYear);
  return Math.max(0, 1 - diff / YEAR_WINDOW);
}

function formatPrice(manwon) {
  return `${manwon.toLocaleString("ko-KR")}만원`;
}

function formatMileage(km) {
  return `${km.toLocaleString("ko-KR")}km`;
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function populateModelDatalist() {
  const models = [...new Set(CAR_DATA.map((c) => c.model))].sort((a, b) =>
    a.localeCompare(b, "ko")
  );
  modelList.innerHTML = models.map((m) => `<option value="${m}"></option>`).join("");
}

function closestModelSuggestions(inputRaw, limit = 5) {
  const scored = [...new Set(CAR_DATA.map((c) => c.model))].map((model) => ({
    model,
    score: modelSimilarity(inputRaw, { model, manufacturer: "" }),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.model);
}

function renderStatCards(matches) {
  const prices = matches.map((m) => m.price);
  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const med = median(prices);

  statCards.innerHTML = `
    <div class="stat-card highlight">
      <div class="label">평균 시세</div>
      <div class="value">${formatPrice(avg)}</div>
    </div>
    <div class="stat-card">
      <div class="label">중간값</div>
      <div class="value">${formatPrice(med)}</div>
    </div>
    <div class="stat-card">
      <div class="label">최저가</div>
      <div class="value">${formatPrice(min)}</div>
    </div>
    <div class="stat-card">
      <div class="label">최고가</div>
      <div class="value">${formatPrice(max)}</div>
    </div>
    <div class="stat-card">
      <div class="label">매물 수</div>
      <div class="value">${matches.length}건</div>
    </div>
  `;
}

function renderTable(scoredListings) {
  resultBody.innerHTML = scoredListings
    .map((item) => {
      const pct = Math.round(item.totalScore * 100);
      return `
        <tr>
          <td>${item.manufacturer}</td>
          <td>${item.model}</td>
          <td>${item.year}년식</td>
          <td>${formatMileage(item.mileage)}</td>
          <td>${item.fuel}</td>
          <td>${item.region}</td>
          <td class="price-cell">${formatPrice(item.price)}</td>
          <td>
            <span class="similarity-bar">
              <span class="bar"><span class="fill" style="width:${pct}%"></span></span>
              ${pct}%
            </span>
          </td>
        </tr>
      `;
    })
    .join("");
}

function showEmptyState(inputModel) {
  resultSection.hidden = true;
  emptyState.hidden = false;
  emptyMessage.textContent = `'${inputModel}'와(과) 일치하거나 유사한 모델을 찾지 못했어요. 아래 모델 중 하나를 선택해보세요.`;
  const suggestions = closestModelSuggestions(inputModel);
  suggestionsEl.innerHTML = suggestions
    .map((m) => `<button type="button" data-model="${m}">${m}</button>`)
    .join("");
  suggestionsEl.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      modelInput.value = btn.dataset.model;
      form.requestSubmit();
    });
  });
}

function handleSearch(inputModel, inputYear) {
  const scored = CAR_DATA.map((listing) => {
    const modelScore = modelSimilarity(inputModel, listing);
    const yScore = yearSimilarity(inputYear, listing.year);
    const totalScore = modelScore * 0.65 + yScore * 0.35;
    return { ...listing, modelScore, yearScore: yScore, totalScore };
  })
    .filter((item) => item.modelScore >= MODEL_SCORE_THRESHOLD)
    .sort((a, b) => b.totalScore - a.totalScore);

  if (scored.length === 0) {
    showEmptyState(inputModel);
    return;
  }

  emptyState.hidden = true;
  resultSection.hidden = false;

  const bestModelScore = scored[0].modelScore;
  // 통계는 "같은 모델로 인정될 만한" 매물 중 연식이 가까운 것들로 계산
  let closeMatches = scored.filter(
    (item) =>
      item.modelScore >= Math.max(0.85, bestModelScore - 0.05) &&
      Math.abs(item.year - inputYear) <= CLOSE_MATCH_YEAR_RANGE
  );
  if (closeMatches.length === 0) {
    closeMatches = scored.filter(
      (item) => item.modelScore >= Math.max(0.85, bestModelScore - 0.05)
    );
  }
  if (closeMatches.length === 0) {
    closeMatches = scored.slice(0, Math.min(10, scored.length));
  }

  const displayModel = scored[0].model;
  resultTitle.textContent = `'${displayModel}' ${inputYear}년식 기준 시세`;
  renderStatCards(closeMatches);
  renderTable(scored.slice(0, 30));
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const inputModel = modelInput.value.trim();
  const inputYear = Number(yearInput.value);
  if (!inputModel || !inputYear) return;
  handleSearch(inputModel, inputYear);
});

populateModelDatalist();
