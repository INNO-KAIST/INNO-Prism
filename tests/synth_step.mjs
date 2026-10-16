/* 계단형 점화 생성기 — **엔진과 무관하게** 직접 만든다.
 *
 * 왜 fit2 의 synth 만으로는 부족한가: synth 는 적합 대상과 **같은 H 족**에서 생성한다.
 * 같은 족의 자료로 '족이 표현하지 못하는 실패'를 검증하면 순환이다(w lower bound만 스트레스된다).
 * 실제 PA 점화는 암준위 평탄부 → 급격한 점등 → 멱법칙이며, 이는 H 족의 꺾은선-힌지가
 * 아니라 계단(스위치)이다. 그래서 여기서는 스위치 형태를 직접 쓴다.
 *
 *   I(x) = D + A · f(x) · 10^{ nH (x − xs) },   f = [1 + exp(−(x−xs)/w)]^{-1}
 *
 * 참 s_max 는 잡음 없는 곡선에서 수치미분으로 직접 잰다 — 어떤 모델도 가정하지 않는다.
 */
export function stepTruth(sc) {
  const { D = 140, A = 2.5e3, nH = 3.2, xs = -2.9, w = 0.01 } = sc;
  const I = (x) => D + A * (1 / (1 + Math.exp(-(x - xs) / w))) * Math.pow(10, nH * (x - xs));
  return { I, D, A, nH, xs, w };
}
export function stepSMax(sc, xlo, xhi) {
  const { I } = stepTruth(sc);
  const N = 40001, h = (xhi - xlo) / (N - 1);
  let sm = -Infinity, xm = xlo, xLo = xlo, xHi = xhi;
  const s = new Array(N);
  for (let i = 1; i < N - 1; i++) {
    const x = xlo + i * h;
    s[i] = (Math.log10(I(x + h)) - Math.log10(I(x - h))) / (2 * h);
    if (s[i] > sm) { sm = s[i]; xm = x; }
  }
  const half = 0.5 * sm;
  let im = Math.round((xm - xlo) / h), lo = im, hi = im;
  while (lo > 1 && s[lo - 1] >= half) lo--;
  while (hi < N - 2 && s[hi + 1] >= half) hi++;
  xLo = xlo + lo * h; xHi = xlo + hi * h;
  return { sMax: sm, xAtMax: xm, bandDec: xHi - xLo, xLo, xHi };
}
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gaussR(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
/** branch 객체 생성. 잡음: σ² = a0² + a1·I (a1=1 이면 계수통계) */
export function stepBranch(sc, n, xlo, xhi, seed, noise) {
  const { I } = stepTruth(sc);
  const { a0 = 12, a1 = 1.0, reps = 3 } = noise || {};
  const rng = mulberry32(seed);
  const P = [], Iavg = [], R = [];
  for (let i = 0; i < n; i++) {
    const x = xlo + (xhi - xlo) * i / (n - 1);
    const mu = I(x);
    const sd = Math.sqrt(a0 * a0 + a1 * Math.max(mu, 0));
    const row = [];
    for (let k = 0; k < reps; k++) row.push(Math.max(mu + gaussR(rng) * sd, 1));
    P.push(Math.pow(10, x)); R.push(row);
    Iavg.push(row.reduce((s, v) => s + v, 0) / row.length);
  }
  return { powerAvg: P, intensityAvg: Iavg, powerStd: P.map(() => 0), intensityStd: Iavg.map(() => 0),
           intensityReplicates: R };
}
