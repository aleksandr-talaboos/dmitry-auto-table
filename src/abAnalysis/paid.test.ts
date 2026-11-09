import { describe, expect, it } from "vitest";
import { abPaidLagDays, parseAbPaidLagDays } from "../config.js";
import { parsePaidStatuses } from "./paid.js";

const status = (offerId: number, name: string, purchases: number, clicks = 100) =>
  ({ campaignId: 41, offerId, offerName: "T017", name, clicks, purchases });

describe("mature Binom payment cohorts", () => {
  it("resolves product defaults, offer overrides, unknown products and max across arms", () => {
    const defaults = parseAbPaidLagDays(undefined);
    expect(defaults).toEqual({ IQ: 10, Zodeya: 16, Subcaddy: 14, "34": 19 });
    expect(abPaidLagDays("IQ", [{ offerId: 19 }], defaults)).toBe(10);
    expect(abPaidLagDays("Zodeya", [{ offerId: 19 }], defaults)).toBe(16);
    expect(abPaidLagDays("Other", [{ offerId: 19 }], defaults)).toBe(14);
    expect(abPaidLagDays("IQ", [{ offerId: 19 }, { offerId: 34 }], defaults)).toBe(19);
    const config = parseAbPaidLagDays('{"IQ":5,"19":0}');
    expect(abPaidLagDays("IQ", [{ offerId: 19 }], config)).toBe(0);
    expect(abPaidLagDays("IQ", [{ offerId: 19 }, { offerId: 24 }], config)).toBe(5);
    for (const raw of ['[]', '{"IQ":-1}', '{"IQ":1.5}', '{"IQ":"10"}', '{"oops":3}', 'invalid']) {
      expect(() => parseAbPaidLagDays(raw)).toThrow("PAID_LAG_DAYS");
    }
  });
  it("counts payers among matured intros and flags unknown or incomplete status rows", () => {
    const metrics = [{ campaignId: 41, offerId: 19, offerName: "T017", uniqueClicks: 10000, purchases: 1717 }];
    const breakdown = [status(19, "Unknown", 0, 8000), status(19, "subscriber", 900, 1200), status(19, "payer", 817, 800)];
    expect(parsePaidStatuses({ metrics, breakdown }, [{ campaignId: 41, offerId: 19 }], "T017"))
      .toEqual({ payers: 817, maturedIntros: 1717, maturedClicks: 10000 });
    expect(parsePaidStatuses({ metrics, breakdown: [...breakdown.slice(0, 2), status(19, "refunded", 817)] },
      [{ campaignId: 41, offerId: 19 }], "T017")).toEqual({ gap: "Binom paid data: unknown conversion status for T017" });
    expect(parsePaidStatuses({ metrics, breakdown: breakdown.slice(0, 2) }, [{ campaignId: 41, offerId: 19 }], "T017"))
      .toEqual({ gap: "Binom paid data: incomplete status rows for T017" });
  });
});
