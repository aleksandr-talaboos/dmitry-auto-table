import { z } from "zod";

// Shared DEV-334 A/B contract: experiment-report writes these rows and verdicts, the health-check panel reads them.

const isCalendarDay = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDay, "Invalid calendar day");
const idSchema = z.number().int().positive();
const countSchema = z.number().int().nonnegative();
const probabilitySchema = z.number().min(0).max(1);

export const countsSchema = z.strictObject({ x: countSchema, n: countSchema })
  .refine(counts => counts.x <= counts.n, "x must not exceed n");
export type Counts = z.infer<typeof countsSchema>;

export const armDayRowSchema = z.strictObject({
  day: daySchema,
  campaignId: idSchema,
  offerId: idSchema,
  uniqueClicks: countSchema,
  purchases: countSchema,
  // null = source unavailable or the arm has no observed paywall instrumentation in the test window.
  paywallViews: countSchema.nullable(),
  checkouts: countSchema.nullable(),
  // Purchase instrumentation is assessed independently; absent on older rows.
  posthogPurchases: countSchema.nullable().optional()
});
export type ArmDayRow = z.infer<typeof armDayRowSchema>;

export const sliceDimensionSchema = z.enum(["country", "os"]);
export type SliceDimension = z.infer<typeof sliceDimensionSchema>;

export const armSliceRowSchema = z.strictObject({
  fromDay: daySchema,
  toDay: daySchema,
  campaignId: idSchema,
  offerId: idSchema,
  dimension: sliceDimensionSchema,
  value: z.string().min(1).max(80),
  uniqueClicks: countSchema,
  purchases: countSchema
}).refine(row => row.fromDay <= row.toDay, "fromDay must not be after toDay");
export type ArmSliceRow = z.infer<typeof armSliceRowSchema>;

// CampaignsWell aggregates per arm for the test window.
export const armValueRowSchema = z.strictObject({
  campaignId: idSchema,
  offerId: idSchema,
  fromDay: daySchema,
  toDay: daySchema,
  predictedRevenue90: z.number().nullable().optional(),
  predictedRevenue180: z.number().nullable().optional(),
  revenueNet: z.number().nullable(),
  revenueGross: z.number().nullable(),
  pltv90: z.number().nullable(),
  pltv180: z.number().nullable(),
  subscribers: countSchema.nullable(),
  unattributedShare: probabilitySchema.nullable()
}).refine(row => row.fromDay <= row.toDay, "fromDay must not be after toDay");
export type ArmValueRow = z.infer<typeof armValueRowSchema>;

export const armPaidRowSchema = z.strictObject({
  campaignId: idSchema,
  offerId: idSchema,
  paidFrom: daySchema,
  paidTo: daySchema,
  maturedIntros: countSchema,
  payers: countSchema,
  maturedClicks: countSchema
}).refine(row => row.paidFrom <= row.paidTo && row.payers <= row.maturedIntros, "Invalid paid cohort");
export type ArmPaidRow = z.infer<typeof armPaidRowSchema>;

// paywall_reach = paywallViews / uniqueClicks; paywall_conversion = purchases / paywallViews;
// checkout_rate = checkouts / uniqueClicks; purchase_cr ("интро / уник. клик") = purchases / uniqueClicks.
export const metricKeySchema = z.enum([
  "paywall_reach", "paywall_conversion", "checkout_rate", "purchase_cr", "trial_to_paid", "paid_cr"
]);
export type MetricKey = z.infer<typeof metricKeySchema>;

export const comparisonStatusSchema = z.enum(["insufficient", "inconclusive", "significant"]);
export type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;

export const comparisonResultSchema = z.strictObject({
  controlRate: probabilitySchema.nullable(),
  variantRate: probabilitySchema.nullable(),
  lift: z.number().nullable(),
  liftCiLow: z.number().nullable(),
  liftCiHigh: z.number().nullable(),
  // Absolute difference variant - control in percentage points with its unpooled Wald CI.
  diffPp: z.number().nullable(),
  diffCiLowPp: z.number().nullable(),
  diffCiHighPp: z.number().nullable(),
  z: z.number().nullable(),
  pValue: probabilitySchema.nullable(),
  probVariantBetter: probabilitySchema.nullable(),
  status: comparisonStatusSchema
});
export type ComparisonResult = z.infer<typeof comparisonResultSchema>;

const requiredPerArmSchema = z.number().int().positive();
export const daysToDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("decided") }),
  z.strictObject({ kind: z.literal("enough_volume"), requiredPerArm: requiredPerArmSchema }),
  z.strictObject({ kind: z.literal("wait"), days: z.number().int().positive(), requiredPerArm: requiredPerArmSchema }),
  z.strictObject({ kind: z.literal("too_small"), requiredPerArm: requiredPerArmSchema }),
  z.strictObject({ kind: z.literal("no_traffic") })
]);
export type DaysToDecision = z.infer<typeof daysToDecisionSchema>;

export const dailyLeadersResultSchema = z.strictObject({
  controlDays: countSchema,
  variantDays: countSchema,
  ties: countSchema,
  skipped: countSchema,
  currentLeader: z.enum(["control", "variant"]).nullable(),
  currentStreak: countSchema
});
export type DailyLeadersResult = z.infer<typeof dailyLeadersResultSchema>;

const armTotalsSchema = z.strictObject({
  uniqueClicks: countSchema,
  purchases: countSchema,
  // Binom daily cost summed over the arm's comparison window; absent on older verdicts.
  cost: z.number().finite().nonnegative().optional(),
  paywallViews: countSchema.nullable(),
  checkouts: countSchema.nullable(),
  posthogPurchases: countSchema.nullable().optional()
});

export const controlSourceSchema = z.strictObject({ campaignId: idSchema, offerId: idSchema });
export const globalTestSchema = z.strictObject({
  parentId: idSchema, tableKind: z.enum(["default", "rule"]),
  windowFrom: daySchema, windowTo: daySchema, firstTrafficDay: daySchema,
  testShare: probabilitySchema, controlShare: probabilitySchema,
  sources: z.array(controlSourceSchema.extend({ clicks: countSchema, intro: countSchema })
    .refine(source => source.intro <= source.clicks, "source intro must not exceed clicks")).min(1)
}).refine(global => global.firstTrafficDay < global.windowFrom && global.windowFrom < global.windowTo,
  "global window must exclude first traffic and contain at least two days");
export type GlobalTest = z.infer<typeof globalTestSchema>;

const verdictArmSchema = z.strictObject({
  offerId: idSchema,
  pooled: z.boolean().optional(),
  controlSources: z.array(controlSourceSchema).optional(),
  controlKind: z.enum(["parent_direct", "pooled_siblings"]).optional(),
  offerName: z.string(),
  url: z.string().nullable(),
  totals: armTotalsSchema,
  pltvRenewalsMissing: z.boolean().optional(),
  cwCoverage: z.number().nonnegative().nullable().optional(),
  binomCoverage: z.number().nonnegative().nullable().optional(),
  economicsIncomplete: z.boolean().optional(),
  paid: armPaidRowSchema.optional(),
  paidContradicts: z.boolean().optional(),
  value: armValueRowSchema.nullable()
});

export const metricComparisonSchema = z.strictObject({
  offerId: idSchema,
  comparison: comparisonResultSchema,
  // Holm-adjusted p across the test's variants for this metric; null/absent with a single variant.
  adjustedP: probabilitySchema.nullable().optional(),
  decision: daysToDecisionSchema
});
export type MetricComparison = z.infer<typeof metricComparisonSchema>;
const paidMetricComparisonSchema = metricComparisonSchema.extend({ decision: daysToDecisionSchema.nullable() });

const leaderEntrySchema = z.strictObject({ offerId: idSchema, ...dailyLeadersResultSchema.shape });

export const verdictSliceSchema = z.strictObject({
  dimension: sliceDimensionSchema,
  offerId: idSchema,
  key: z.string().min(1).max(80),
  control: countsSchema,
  variant: countsSchema,
  comparison: comparisonResultSchema,
  // Holm-adjusted p-value across all eligible slices of one test; null when the slice is not eligible.
  adjustedP: probabilitySchema.nullable(),
  flag: z.literal("check").nullable()
});
export type VerdictSlice = z.infer<typeof verdictSliceSchema>;

export const overallSchema = z.enum(["winner", "leading", "early", "insufficient"]);
export type Overall = z.infer<typeof overallSchema>;

export const testVerdictSchema = z.strictObject({
  version: z.literal(1),
  day: daySchema,
  project: z.string().min(1),
  campaignId: idSchema,
  campaignName: z.string(),
  startedOn: daySchema,
  firstTrafficDay: daySchema.optional(),
  global: globalTestSchema.optional(),
  daysRunning: countSchema,
  controlOfferId: idSchema,
  controlSource: z.enum(["override", "parent", "t_number", "parent_direct", "pooled_siblings"]).optional(),
  paidAvailableOn: daySchema.optional(),
  arms: z.array(verdictArmSchema).min(2),
  metrics: z.strictObject({
    purchase_cr: z.array(metricComparisonSchema), paywall_reach: z.array(metricComparisonSchema),
    paywall_conversion: z.array(metricComparisonSchema), checkout_rate: z.array(metricComparisonSchema),
    trial_to_paid: z.array(paidMetricComparisonSchema).optional(), paid_cr: z.array(paidMetricComparisonSchema).optional()
  }),
  leaders: z.strictObject({ purchase_cr: z.array(leaderEntrySchema) }),
  slices: z.array(verdictSliceSchema),
  overall: overallSchema,
  winnerOfferId: idSchema.nullable(),
  dataGaps: z.array(z.string())
}).superRefine((verdict, ctx) => {
  const offerIds = verdict.arms.map(arm => arm.offerId);
  if (new Set(offerIds).size !== offerIds.length) ctx.addIssue({ code: "custom", message: "arm offerIds must be unique" });
  if (!offerIds.includes(verdict.controlOfferId)) {
    ctx.addIssue({ code: "custom", message: "controlOfferId must be one of the arms" });
  }
  if (verdict.startedOn > verdict.day) ctx.addIssue({ code: "custom", message: "startedOn must not be after day" });
  if (verdict.overall === "winner" && (verdict.winnerOfferId === null || !offerIds.includes(verdict.winnerOfferId))) {
    ctx.addIssue({ code: "custom", message: "a winner verdict needs winnerOfferId from the arms" });
  }
  if (verdict.overall !== "winner" && verdict.winnerOfferId !== null) {
    ctx.addIssue({ code: "custom", message: "winnerOfferId is set only for a winner verdict" });
  }
});
export type TestVerdict = z.infer<typeof testVerdictSchema>;

export type PurchaseCrEntry = { offerId: number; comparison: Pick<ComparisonResult, "status" | "lift" | "probVariantBetter"> };

/**
 * Overall verdict from the purchase_cr comparisons (each variant vs control). Insufficient comparisons do not block
 * "leading"/"early" when another variant has enough data.
 */
export function deriveOverall(
  metricsForPurchaseCr: readonly PurchaseCrEntry[], controlOfferId: number
): { overall: Overall; winnerOfferId: number | null } {
  const significant = metricsForPurchaseCr.filter(entry => entry.comparison.status === "significant");
  if (significant.length > 0) {
    const better = significant
      .filter(entry => (entry.comparison.lift ?? 0) > 0)
      .sort((left, right) => (right.comparison.lift ?? 0) - (left.comparison.lift ?? 0))[0];
    return { overall: "winner", winnerOfferId: better ? better.offerId : controlOfferId };
  }
  const measured = metricsForPurchaseCr.filter(entry => entry.comparison.status === "inconclusive");
  if (measured.length === 0) return { overall: "insufficient", winnerOfferId: null };
  const leaning = measured.some(({ comparison: { probVariantBetter: prob } }) => prob !== null && (prob >= 0.9 || prob <= 0.1));
  return { overall: leaning ? "leading" : "early", winnerOfferId: null };
}
