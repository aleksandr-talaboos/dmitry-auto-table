import { describe, expect, it } from "vitest";
import { cellText, effect, fullDate, money, pValue, pair, percent, shortDate, thousands } from "./format.js";

describe("library formatting", () => {
  it("formats percentages, confidence intervals, p-values and money for the sheet", () => {
    expect(percent(0.0248, 2)).toBe("2,48%");
    expect(percent(0.012, 1, true)).toBe("+1,2%");
    expect(percent(-0.117, 1, true)).toBe("-11,7%");
    expect(effect(-0.117, -0.513, 0.601)).toBe("-11,7% [-51,3%; +60,1%]");
    expect(effect(null, null, null)).toBe("—");
    expect(pValue(0.731)).toBe("0,731");
    expect(pValue(0.0009)).toBe("<0,001");
    expect(money(0.03, 2)).toBe("$0,03");
    expect(money(38.7, 1)).toBe("$38,7");
    expect(percent(0.327, 1)).toBe("32,7%");
    expect(pair(16, 14)).toBe("16 / 14");
    expect(pair(null, 25)).toBe("— / 25");
    expect(pair(3255, 3317)).toBe("3 255 / 3 317");
    expect(thousands(4947)).toBe("4 947");
    expect(shortDate("2026-11-02")).toBe("02.11");
    expect(fullDate("2026-11-02")).toBe("02.11.2026");
    expect(money(null, 2)).toBe("—");
    expect(cellText("текст")).toBe("текст");
    expect(cellText(1234)).toBe("1234");
    expect(cellText({ value: 1234, format: "int" })).toBe("1234");
    expect(cellText({ value: 1234, format: "count" })).toBe("1 234");
    expect(cellText({ value: 0.1234, format: "percent1" })).toBe("12,3%");
    expect(cellText({ value: 0.1234, format: "percent2" })).toBe("12,34%");
    expect(cellText({ value: 0.1234, format: "signedPercent1" })).toBe("+12,3%");
    expect(cellText({ value: 12.34, format: "usd1" })).toBe("$12,3");
    expect(cellText({ value: 12.34, format: "usd2" })).toBe("$12,34");
    expect(cellText({ value: Infinity, format: "int" })).toBe("—");
  });
});
