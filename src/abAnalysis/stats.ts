import {
  daySchema, type ComparisonResult, type Counts, type DailyLeadersResult, type DaysToDecision, type TestVerdict
} from "./contract.js";

// Pure A/B statistics for DEV-334: no I/O, no dependencies. Never returns NaN/Infinity; undefined values are null.
export type { Counts };

/** Descriptive window economics only: these values never participate in the statistical verdict. */
export function armGoalMetrics(arm: Pick<TestVerdict["arms"][number], "totals" | "value">) {
  const { totals, value } = arm;
  const arpu = value?.revenueNet != null && totals.uniqueClicks > 0 ? value.revenueNet / totals.uniqueClicks : null;
  const cpa = totals.cost != null && totals.purchases > 0 ? totals.cost / totals.purchases : null;
  return { arpu, pltv90: value?.pltv90 ?? null, cpa, cpaTargetMet: cpa === null ? null : cpa < 20 };
}

const INV_SQRT_PI = 5.6418958354775628695e-1;
// W. J. Cody, "Rational Chebyshev approximations for the error function" (CALERF), erfc branch.
const ERF_A = [3.16112374387056560e00, 1.13864154151050156e02, 3.77485237685302021e02, 3.20937758913846947e03,
  1.85777706184603153e-1];
const ERF_B = [2.36012909523441209e01, 2.44024637934444173e02, 1.28261652607737228e03, 2.84423683343917062e03];
const ERF_C = [5.64188496988670089e-1, 8.88314979438837594e00, 6.61191906371416295e01, 2.98635138197400131e02,
  8.81952221241769090e02, 1.71204761263407058e03, 2.05107837782607147e03, 1.23033935479799725e03,
  2.15311535474403846e-8];
const ERF_D = [1.57449261107098347e01, 1.17693950891312499e02, 5.37181101862009858e02, 1.62138957456669019e03,
  3.29079923573345963e03, 4.36261909014324716e03, 3.43936767414372164e03, 1.23033935480374942e03];
const ERF_P = [3.05326634961232344e-1, 3.60344899949804439e-1, 1.25781726111229246e-1, 1.60837851487422766e-2,
  6.58749161529837803e-4, 1.63153871373020978e-2];
const ERF_Q = [2.56852019228982242e00, 1.87295284992346725e00, 5.27905102951428412e-1, 6.05183413124413191e-2,
  2.33520497626869185e-3];

function erfc(x: number): number {
  const y = Math.abs(x);
  if (y <= 0.46875) {
    const ysq = y > 1.11e-16 ? y * y : 0;
    let num = ERF_A[4] * ysq;
    let den = ysq;
    for (let i = 0; i < 3; i += 1) {
      num = (num + ERF_A[i]) * ysq;
      den = (den + ERF_B[i]) * ysq;
    }
    return 1 - x * (num + ERF_A[3]) / (den + ERF_B[3]);
  }
  let result: number;
  if (y <= 4) {
    let num = ERF_C[8] * y;
    let den = y;
    for (let i = 0; i < 7; i += 1) {
      num = (num + ERF_C[i]) * y;
      den = (den + ERF_D[i]) * y;
    }
    result = (num + ERF_C[7]) / (den + ERF_D[7]);
  } else if (y >= 26.543) {
    result = 0;
  } else {
    const ysq = 1 / (y * y);
    let num = ERF_P[5] * ysq;
    let den = ysq;
    for (let i = 0; i < 4; i += 1) {
      num = (num + ERF_P[i]) * ysq;
      den = (den + ERF_Q[i]) * ysq;
    }
    result = (INV_SQRT_PI - ysq * (num + ERF_P[4]) / (den + ERF_Q[4])) / y;
  }
  if (result !== 0) {
    const ysq = Math.trunc(y * 16) / 16;
    const del = (y - ysq) * (y + ysq);
    result *= Math.exp(-ysq * ysq) * Math.exp(-del);
  }
  return x < 0 ? 2 - result : result;
}

/** Standard normal CDF. */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) throw new RangeError("normCdf: x must be a number");
  return 0.5 * erfc(-x / Math.SQRT2);
}

// P. J. Acklam's inverse normal CDF approximation, refined with one Halley step.
const INV_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02,
  -3.066479806614716e+01, 2.506628277459239e+00];
const INV_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01,
  -1.328068155288572e+01];
const INV_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00,
  4.374664141464968e+00, 2.938163982698783e+00];
const INV_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
const INV_P_LOW = 0.02425;

function acklamTail(q: number): number {
  return (((((INV_C[0] * q + INV_C[1]) * q + INV_C[2]) * q + INV_C[3]) * q + INV_C[4]) * q + INV_C[5])
    / ((((INV_D[0] * q + INV_D[1]) * q + INV_D[2]) * q + INV_D[3]) * q + 1);
}

/** Inverse standard normal CDF for 0 < p < 1. */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normInv: p must be in (0, 1), got ${p}`);
  let x: number;
  if (p < INV_P_LOW) {
    x = acklamTail(Math.sqrt(-2 * Math.log(p)));
  } else if (p <= 1 - INV_P_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((INV_A[0] * r + INV_A[1]) * r + INV_A[2]) * r + INV_A[3]) * r + INV_A[4]) * r + INV_A[5]) * q
      / (((((INV_B[0] * r + INV_B[1]) * r + INV_B[2]) * r + INV_B[3]) * r + INV_B[4]) * r + 1);
  } else {
    x = -acklamTail(Math.sqrt(-2 * Math.log(1 - p)));
  }
  const error = normCdf(x) - p;
  const u = error * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

function assertCounts(counts: Counts, label: string): void {
  const { x, n } = counts;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(n) || x < 0 || n < 0 || x > n) {
    throw new RangeError(`${label}: counts must be integers with 0 <= x <= n, got x=${x}, n=${n}`);
  }
}

function openProbability(value: number, label: string): number {
  if (!(value > 0 && value < 1)) throw new RangeError(`${label} must be in (0, 1), got ${value}`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  return value;
}

function assertAscendingDays(days: readonly { day: string }[], label: string): void {
  days.forEach((entry, index) => {
    if (!daySchema.safeParse(entry.day).success) throw new RangeError(`${label}: invalid day ${entry.day}`);
    if (index > 0 && days[index - 1].day >= entry.day) {
      throw new RangeError(`${label}: days must be strictly ascending (${days[index - 1].day} then ${entry.day})`);
    }
  });
}

const finite = (value: number): number | null => (Number.isFinite(value) ? value : null);
const rateOf = (counts: Counts): number | null => (counts.n > 0 ? counts.x / counts.n : null);

export type CompareOptions = { alpha?: number; minConversions?: number };

/**
 * Two-proportion comparison of a variant against control: pooled two-sided z-test, Katz log-ratio CI of the relative
 * lift, unpooled Wald CI of the absolute difference in percentage points and P(variant > control) by the unpooled
 * normal approximation. "insufficient" below minConversions (default 10) conversions in either arm.
 */
export function compareProportions(control: Counts, variant: Counts, opts: CompareOptions = {}): ComparisonResult {
  assertCounts(control, "control");
  assertCounts(variant, "variant");
  const alpha = openProbability(opts.alpha ?? 0.05, "alpha");
  const minConversions = nonNegativeInteger(opts.minConversions ?? 10, "minConversions");
  const controlRate = rateOf(control);
  const variantRate = rateOf(variant);
  const unmeasured = {
    lift: null, liftCiLow: null, liftCiHigh: null, diffPp: null, diffCiLowPp: null, diffCiHighPp: null,
    z: null, pValue: null, probVariantBetter: null
  };
  if (controlRate === null || variantRate === null || Math.min(control.x, variant.x) < minConversions) {
    return { controlRate, variantRate, ...unmeasured, status: "insufficient" };
  }
  const p1 = controlRate;
  const p2 = variantRate;
  const diff = p2 - p1;
  const lift = finite(p2 / p1 - 1);
  const pooled = (control.x + variant.x) / (control.n + variant.n);
  const pooledVariance = pooled * (1 - pooled) * (1 / control.n + 1 / variant.n);
  if (!(pooledVariance > 0)) {
    return { controlRate, variantRate, ...unmeasured, lift, diffPp: diff * 100, status: "inconclusive" };
  }
  const zCritical = normInv(1 - alpha / 2);
  const z = diff / Math.sqrt(pooledVariance);
  const pValue = Math.min(1, erfc(Math.abs(z) / Math.SQRT2));

  let liftCiLow: number | null = null;
  let liftCiHigh: number | null = null;
  if (control.x > 0 && variant.x > 0) {
    const logRatio = Math.log(p2 / p1);
    const logSe = Math.sqrt(1 / variant.x - 1 / variant.n + 1 / control.x - 1 / control.n);
    liftCiLow = finite(Math.exp(logRatio - zCritical * logSe) - 1);
    liftCiHigh = finite(Math.exp(logRatio + zCritical * logSe) - 1);
  }

  const unpooledSe = Math.sqrt(p1 * (1 - p1) / control.n + p2 * (1 - p2) / variant.n);
  const hasSpread = unpooledSe > 0;
  return {
    controlRate,
    variantRate,
    lift,
    liftCiLow,
    liftCiHigh,
    diffPp: diff * 100,
    diffCiLowPp: hasSpread ? (diff - zCritical * unpooledSe) * 100 : null,
    diffCiHighPp: hasSpread ? (diff + zCritical * unpooledSe) * 100 : null,
    z: finite(z),
    pValue: finite(pValue),
    probVariantBetter: hasSpread ? finite(normCdf(diff / unpooledSe)) : null,
    status: pValue < alpha ? "significant" : "inconclusive"
  };
}

export type SampleSizeOptions = { alpha?: number; power?: number; controlToTestRatio?: number };

/** Trials per arm, or test-arm trials with controlToTestRatio k, for a two-sided relative-lift planning test. */
export function requiredSamplePerArm(baselineRate: number, relativeLift: number, opts: SampleSizeOptions = {}): number {
  const p1 = openProbability(baselineRate, "baselineRate");
  if (!Number.isFinite(relativeLift) || relativeLift === 0) {
    throw new RangeError(`relativeLift must be a non-zero finite number, got ${relativeLift}`);
  }
  const p2 = p1 * (1 + relativeLift);
  if (!(p2 > 0 && p2 < 1)) throw new RangeError(`baselineRate * (1 + relativeLift) must be in (0, 1), got ${p2}`);
  const zAlpha = normInv(1 - openProbability(opts.alpha ?? 0.05, "alpha") / 2);
  const zPower = normInv(openProbability(opts.power ?? 0.8, "power"));
  const k = opts.controlToTestRatio ?? 1;
  if (!(Number.isFinite(k) && k > 0)) throw new RangeError("controlToTestRatio must be positive and finite");
  const pBar = (k * p1 + p2) / (k + 1);
  const numerator = zAlpha * Math.sqrt((1 + 1 / k) * pBar * (1 - pBar))
    + zPower * Math.sqrt(p1 * (1 - p1) / k + p2 * (1 - p2));
  return numerator ** 2 / (p2 - p1) ** 2;
}

export type DaysToDecisionInput = {
  control: Counts;
  variant: Counts;
  /** Average trials per arm per day, see recentDailyTrialsPerArm. */
  dailyTrialsPerArm: number;
  /** Planning relative lift (default 0.20, the owner's fixed "+20%" scenario). */
  minLift?: number;
  /** Control/test sample ratio; when present dailyTrialsPerArm is the test-arm daily speed. */
  controlToTestRatio?: number;
  /** "fixed" (default) plans for minLift; "max_observed" plans for max(|observed lift|, minLift). */
  liftPolicy?: "fixed" | "max_observed";
  maxDays?: number;
  minConversions?: number;
  alpha?: number;
  power?: number;
  /** Set false when a multiple-comparison correction rejects the raw significance. */
  significant?: boolean;
};

function planningBaseline(control: Counts, variant: Counts): number {
  const total = control.n + variant.n;
  const pooled = (control.x + variant.x) / total;
  const baseline = control.x > 0 ? control.x / control.n : pooled > 0 ? pooled : 1 / (total + 1);
  // All trials converted: keep the planning rate inside (0, 1).
  return baseline >= 1 ? 1 - 1 / (total + 1) : baseline;
}

/** Days until the comparison can be decided, at the planning lift with the current per-arm traffic. */
export function daysToDecision(input: DaysToDecisionInput): DaysToDecision {
  const { control, variant, dailyTrialsPerArm } = input;
  const minLift = input.minLift ?? 0.2;
  const maxDays = input.maxDays ?? 60;
  const minConversions = input.minConversions ?? 10;
  if (!Number.isFinite(dailyTrialsPerArm)) throw new RangeError(`dailyTrialsPerArm must be finite, got ${dailyTrialsPerArm}`);
  if (!(Number.isFinite(minLift) && minLift > 0)) throw new RangeError(`minLift must be a positive number, got ${minLift}`);
  if (!(Number.isFinite(maxDays) && maxDays > 0)) throw new RangeError(`maxDays must be a positive number, got ${maxDays}`);
  const comparison = compareProportions(control, variant, { alpha: input.alpha, minConversions });
  if (comparison.status === "significant" && input.significant !== false) return { kind: "decided" };
  if (control.n + variant.n === 0) return { kind: "no_traffic" };

  const baseline = planningBaseline(control, variant);
  const observedLift = control.x > 0 && variant.n > 0 ? variant.x / variant.n / (control.x / control.n) - 1 : null;
  let lift = input.liftPolicy === "max_observed" && observedLift !== null ? Math.max(Math.abs(observedLift), minLift) : minLift;
  // An upward lift that would exceed a 100% rate is planned as a drop of the same size (capped at -50%).
  if (baseline * (1 + lift) >= 1) lift = -Math.min(lift, 0.5);
  const requiredPerArm = Math.ceil(requiredSamplePerArm(baseline, lift, { alpha: input.alpha, power: input.power,
    controlToTestRatio: input.controlToTestRatio }));

  const volumeGap = Math.max(0, requiredPerArm - (input.controlToTestRatio === undefined ? Math.min(control.n, variant.n) : variant.n));
  const conversionGap = (arm: Counts): number => {
    if (arm.x >= minConversions) return 0;
    const armRate = arm.x > 0 ? arm.x / arm.n : baseline;
    return (minConversions - arm.x) / armRate;
  };
  const remaining = Math.ceil(Math.max(volumeGap, conversionGap(control) / (input.controlToTestRatio ?? 1), conversionGap(variant)));
  if (remaining === 0) return { kind: "enough_volume", requiredPerArm };
  if (dailyTrialsPerArm <= 0) return { kind: "no_traffic" };
  const days = Math.ceil(remaining / dailyTrialsPerArm);
  if (days > maxDays) return { kind: "too_small", requiredPerArm };
  return { kind: "wait", days, requiredPerArm };
}

export type DailyTrials = { day: string; control: number; variant: number };

/**
 * Average trials per arm per day over the last `window` (default 3) days with traffic; a younger test averages only
 * its own days with traffic. Returns 0 when no day has traffic.
 */
export function recentDailyTrialsPerArm(days: readonly DailyTrials[], opts: { window?: number } = {}): number {
  const window = opts.window ?? 3;
  if (!Number.isSafeInteger(window) || window < 1) throw new RangeError(`window must be a positive integer, got ${window}`);
  assertAscendingDays(days, "recentDailyTrialsPerArm");
  days.forEach(entry => {
    nonNegativeInteger(entry.control, `${entry.day} control`);
    nonNegativeInteger(entry.variant, `${entry.day} variant`);
  });
  const recent = days.filter(entry => entry.control + entry.variant > 0).slice(-window);
  if (recent.length === 0) return 0;
  return recent.reduce((sum, entry) => sum + entry.control + entry.variant, 0) / (2 * recent.length);
}

export type DailyCounts = { day: string; control: Counts; variant: Counts };

/**
 * Per-day winners by rate. A day counts only when both arms reach minDailyConversions (default 11, i.e. more than 10);
 * the streak is the run of counted days won by the leader of the last counted day (a tie ends it).
 */
export function dailyLeaders(days: readonly DailyCounts[], opts: { minDailyConversions?: number } = {}): DailyLeadersResult {
  const minDailyConversions = opts.minDailyConversions ?? 11;
  if (!Number.isSafeInteger(minDailyConversions) || minDailyConversions < 1) {
    throw new RangeError(`minDailyConversions must be a positive integer, got ${minDailyConversions}`);
  }
  assertAscendingDays(days, "dailyLeaders");
  const result: DailyLeadersResult = {
    controlDays: 0, variantDays: 0, ties: 0, skipped: 0, currentLeader: null, currentStreak: 0
  };
  for (const { day, control, variant } of days) {
    assertCounts(control, `${day} control`);
    assertCounts(variant, `${day} variant`);
    if (control.x < minDailyConversions || variant.x < minDailyConversions) {
      result.skipped += 1;
      continue;
    }
    // Exact rate comparison by cross-multiplication (n >= x >= 1 here).
    const order = variant.x * control.n - control.x * variant.n;
    if (order === 0) {
      result.ties += 1;
      result.currentLeader = null;
      result.currentStreak = 0;
      continue;
    }
    const winner = order > 0 ? "variant" : "control";
    if (winner === "variant") result.variantDays += 1;
    else result.controlDays += 1;
    result.currentStreak = winner === result.currentLeader ? result.currentStreak + 1 : 1;
    result.currentLeader = winner;
  }
  return result;
}

function sortedIndices(pValues: readonly number[]): number[] {
  pValues.forEach((p, index) => {
    if (!(p >= 0 && p <= 1)) throw new RangeError(`p-value #${index} must be in [0, 1], got ${p}`);
  });
  return pValues.map((_, index) => index).sort((left, right) => pValues[left] - pValues[right] || left - right);
}

/** Benjamini-Hochberg q-values in input order (step-up, monotone, capped at 1). */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const order = sortedIndices(pValues);
  const m = pValues.length;
  const qValues = new Array<number>(m);
  let running = 1;
  for (let rank = m - 1; rank >= 0; rank -= 1) {
    const index = order[rank];
    running = Math.min(running, (m * pValues[index]) / (rank + 1));
    qValues[index] = running;
  }
  return qValues;
}

/** Holm step-down adjusted p-values in input order (monotone, capped at 1). */
export function holm(pValues: readonly number[]): number[] {
  const order = sortedIndices(pValues);
  const m = pValues.length;
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach((index, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * pValues[index]));
    adjusted[index] = running;
  });
  return adjusted;
}

/** One Holm family per metric; comparisons without a raw p-value do not enter the family. */
export function adjustVariantComparisons<T extends { comparison: ComparisonResult }>(entries: readonly T[], variants: number) {
  const eligible = entries.filter(entry => entry.comparison.pValue !== null);
  const adjusted = variants >= 2 ? holm(eligible.map(entry => entry.comparison.pValue!)) : [];
  return entries.map(entry => {
    const adjustedP = adjusted[eligible.indexOf(entry)] ?? null;
    const comparison = { ...entry.comparison };
    if (comparison.status === "significant" && adjustedP !== null && adjustedP >= 0.05) comparison.status = "inconclusive";
    return { ...entry, comparison, adjustedP };
  });
}

export type SliceInput = { key: string; control: Counts; variant: Counts };
export type SliceFlagResult = { comparison: ComparisonResult; adjustedP: number | null; flag: "check" | null };
export type SliceFlagOptions = { alpha?: number; minConversions?: number };

/**
 * Compares every slice (pass all slices of one test, every dimension and variant, as one family). Slices with at least
 * minConversions (default 30) conversions per arm are Holm-adjusted together and flagged "check" when the adjusted p is
 * below alpha. Sorted by total conversions, largest first. A flag is a prompt to look, never a conclusion.
 */
export function flagSlices<T extends SliceInput>(
  slices: readonly T[], opts: SliceFlagOptions = {}
): Array<T & SliceFlagResult> {
  const alpha = openProbability(opts.alpha ?? 0.05, "alpha");
  const minConversions = opts.minConversions ?? 30;
  const comparisons = slices.map(slice => compareProportions(slice.control, slice.variant, { alpha, minConversions }));
  const eligible = comparisons.flatMap((comparison, index) => (comparison.pValue === null ? [] : [index]));
  const adjusted = holm(eligible.map(index => comparisons[index].pValue as number));
  const adjustedByIndex = new Map(eligible.map((index, position) => [index, adjusted[position]]));
  const flagged = slices.map((slice, index): T & SliceFlagResult => {
    const adjustedP = adjustedByIndex.get(index) ?? null;
    const flag = adjustedP !== null && adjustedP < alpha ? "check" : null;
    return { ...slice, comparison: comparisons[index], adjustedP, flag };
  });
  const volume = (slice: SliceInput) => [slice.control.x + slice.variant.x, slice.control.n + slice.variant.n];
  return flagged.sort((left, right) => {
    const [leftConversions, leftTrials] = volume(left);
    const [rightConversions, rightTrials] = volume(right);
    return rightConversions - leftConversions || rightTrials - leftTrials;
  });
}

/** Chi-square upper tail for integer degrees of freedom, using the incomplete-gamma recurrence (DLMF 8.8.2). */
export function chiSquareSurvival(statistic: number, df: number): number {
  if (!(Number.isFinite(statistic) && statistic >= 0 && Number.isSafeInteger(df) && df >= 1)) {
    throw new RangeError("Invalid chi-square statistic or degrees of freedom");
  }
  const x = statistic / 2;
  let a = df % 2 ? 0.5 : 1;
  let tail = df % 2 ? erfc(Math.sqrt(x)) : Math.exp(-x);
  let logGamma = df % 2 ? Math.log(Math.PI) / 2 : 0;
  for (; a < df / 2; a++) {
    logGamma += Math.log(a);
    tail += x === 0 ? 0 : Math.exp(a * Math.log(x) - x - logGamma);
  }
  return Math.min(1, Math.max(0, tail));
}

/** Pearson goodness-of-fit; null means too little traffic for the asymptotic check. */
export function sampleRatioP(observed: readonly number[], shares: readonly number[]): number | null {
  if (observed.length !== shares.length || observed.length < 2) return null;
  observed.forEach(value => nonNegativeInteger(value, "observed"));
  const total = observed.reduce((sum, n) => sum + n, 0);
  const weight = shares.reduce((sum, n) => sum + n, 0);
  if (!shares.every(n => Number.isFinite(n) && n > 0) || !weight) return null;
  const expected = shares.map(n => total * n / weight);
  if (expected.some(n => n < 5)) return null;
  return chiSquareSurvival(observed.reduce((sum, n, i) => sum + (n - expected[i]) ** 2 / expected[i], 0), observed.length - 1);
}

/** Pearson homogeneity of independent intro/click source arms, without continuity correction. */
export function homogeneityP(sources: readonly Counts[]): number | null {
  if (sources.length < 2) return null;
  sources.forEach(counts => assertCounts(counts, "source"));
  const total = sources.reduce((sum, row) => sum + row.n, 0);
  const successes = sources.reduce((sum, row) => sum + row.x, 0);
  if (!total) return null;
  const p = successes / total;
  if (sources.some(row => row.n * p < 5 || row.n * (1 - p) < 5)) return null;
  const statistic = sources.reduce((sum, row) => sum + (row.x - row.n * p) ** 2 / (row.n * p)
    + (row.n - row.x - row.n * (1 - p)) ** 2 / (row.n * (1 - p)), 0);
  return chiSquareSurvival(statistic, sources.length - 1);
}
