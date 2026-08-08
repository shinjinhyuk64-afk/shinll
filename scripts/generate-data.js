// 샘플 중고차 시세 데이터셋 생성 스크립트.
// 실행: node scripts/generate-data.js
// 출력: assets/data.js (CAR_DATA 배열을 정의하는 정적 JS 파일)
//
// 실제 엔카/KB차차차 등은 공식 무료 API가 없어, 여기서는 현실적인 감가율/주행거리
// 모델을 이용해 통계적으로 그럴듯한 샘플 시세 데이터를 생성한다.

const fs = require("fs");
const path = require("path");

const CURRENT_YEAR = 2026;

// 모델 정의: [제조사, 모델명, 신차가(만원), 차종]
const MODELS = [
  ["현대", "아반떼", 2000, "준중형"],
  ["현대", "쏘나타", 2800, "중형"],
  ["현대", "그랜저", 3800, "준대형"],
  ["현대", "투싼", 2900, "준중형SUV"],
  ["현대", "싼타페", 3500, "중형SUV"],
  ["현대", "팰리세이드", 4300, "대형SUV"],
  ["현대", "코나", 2500, "소형SUV"],
  ["기아", "K3", 2000, "준중형"],
  ["기아", "K5", 2700, "중형"],
  ["기아", "K8", 3700, "준대형"],
  ["기아", "스포티지", 2900, "준중형SUV"],
  ["기아", "쏘렌토", 3400, "중형SUV"],
  ["기아", "카니발", 3700, "미니밴"],
  ["기아", "셀토스", 2300, "소형SUV"],
  ["쉐보레", "스파크", 1400, "경차"],
  ["쉐보레", "말리부", 2600, "중형"],
  ["쉐보레", "트레일블레이저", 2100, "소형SUV"],
  ["르노코리아", "SM6", 2600, "중형"],
  ["르노코리아", "QM6", 2700, "중형SUV"],
  ["KG모빌리티", "티볼리", 2100, "소형SUV"],
  ["KG모빌리티", "렉스턴", 3800, "대형SUV"],
  ["제네시스", "G80", 6500, "준대형"],
  ["제네시스", "GV70", 5700, "중형SUV"],
  ["벤츠", "E클래스", 7500, "중형"],
  ["BMW", "5시리즈", 7800, "중형"],
  ["아우디", "A6", 7200, "중형"],
  ["토요타", "캠리", 4200, "중형"],
  ["혼다", "어코드", 3800, "중형"],
];

const HYBRID_MODELS = new Set(["쏘나타", "그랜저", "투싼", "싼타페", "캠리", "어코드", "K5", "K8"]);
const DIESEL_TYPES = new Set(["중형SUV", "대형SUV", "미니밴"]);
const REGIONS = [
  "서울", "경기", "인천", "부산", "대구", "대전", "광주", "울산",
  "경남", "경북", "전남", "전북", "충남", "충북", "강원", "제주",
];

// 재현 가능한 결과를 위한 간단한 시드 PRNG (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260808);
const randRange = (min, max) => min + rand() * (max - min);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function priceForAge(basePrice, age) {
  // 연 평균 약 13% 감가, 최저 신차가의 22%까지 하락
  const retention = Math.max(0.22, Math.pow(0.87, age));
  const noise = randRange(0.92, 1.08);
  return Math.round((basePrice * retention * noise) / 10) * 10;
}

function mileageForAge(age) {
  const perYear = randRange(11000, 17000);
  return Math.round((age * perYear + randRange(-3000, 3000)) / 100) * 100;
}

function fuelFor(model, bodyType) {
  if (HYBRID_MODELS.has(model) && rand() < 0.35) return "하이브리드";
  if (DIESEL_TYPES.has(bodyType) && rand() < 0.45) return "디젤";
  if (model === "스파크" && rand() < 0.1) return "LPG";
  return "가솔린";
}

let id = 1;
const listings = [];

for (const [manufacturer, model, basePrice, bodyType] of MODELS) {
  for (let year = 2016; year <= 2025; year++) {
    const age = Math.max(0, CURRENT_YEAR - year);
    const count = 1 + Math.floor(rand() * 3); // 연식당 1~3대
    for (let i = 0; i < count; i++) {
      listings.push({
        id: id++,
        manufacturer,
        model,
        bodyType,
        year,
        mileage: mileageForAge(age),
        price: priceForAge(basePrice, age),
        fuel: fuelFor(model, bodyType),
        region: pick(REGIONS),
      });
    }
  }
}

const header = `// 자동 생성된 샘플 중고차 시세 데이터입니다. 실제 매물 정보가 아닙니다.
// 생성 스크립트: scripts/generate-data.js
`;
const body = `const CAR_DATA = ${JSON.stringify(listings, null, 2)};\n`;

fs.writeFileSync(path.join(__dirname, "..", "assets", "data.js"), header + body);
console.log(`생성 완료: ${listings.length}건 -> assets/data.js`);
