import { describe, expect, it, vi } from "vitest";
import type { SheetsApi } from "../sheets/client.js";
import type { LibraryCell, LibraryRow } from "./compute.js";
import { LIBRARY_COLUMNS, LIBRARY_GROUPS } from "./layout.js";
import { writeLibrarySheet } from "./sheet.js";

const tab = { properties: { sheetId: 1991356788, title: "Renamed", index: 1,
  gridProperties: { rowCount: 2, columnCount: 26 } } };
type Sheet = NonNullable<Awaited<ReturnType<SheetsApi["getSpreadsheet"]>>["sheets"]>[number];
function fake(sheets: Sheet[] = [tab], locale?: string) {
  const batchUpdate = vi.fn(async (_id: string, requests: unknown[]) =>
    requests.some(request => (request as Record<string, unknown>).addSheet)
      ? { replies: [{ addSheet: { properties: { sheetId: 42 } } }] } : {});
  const api: SheetsApi = { getSpreadsheet: vi.fn(async () => ({ ...(locale ? { properties: { locale } } : {}), sheets })),
    batchGetValues: vi.fn(), batchUpdate };
  return { api, batchUpdate };
}
function row(): LibraryRow {
  const cells: LibraryCell[] = Array(27).fill("");
  cells[0] = { value: 8, format: "int" }; cells[1] = "E001"; cells[3] = "идёт";
  cells[10] = "+2,1% [-1,9%; +6,3%]"; cells[11] = "0,399"; cells[24] = "<0,001";
  cells[5] = { value: 13, format: "count" }; cells[8] = { value: 0.1234, format: "percent2" };
  cells[12] = "лучше (разный старт)"; cells[16] = "хуже"; cells[21] = "мало данных"; cells[25] = "не сравнить";
  cells[14] = { value: 1.23, format: "usd2" }; cells[18] = { value: 2.3, format: "usd1" };
  cells[20] = { value: 0.2, format: "signedPercent1" }; cells[22] = { value: 0.5, format: "percent1" };
  return { campaignId: 1, controlKey: "o:1", variantKey: "o:2", cells };
}
function titleFormatting(sheetId: number, rowCount: number) {
  const widths = [44, 130, 250, 100, 64, 84, 84, 84, 84, 84, 160, 56, 150, 104, 84, 84, 104,
    104, 84, 84, 76, 104, 84, 84, 56, 104, 640];
  return [
    ...widths.map((pixelSize, startIndex) => ({ updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex, endIndex: startIndex + 1 },
      properties: { pixelSize }, fields: "pixelSize" } })),
    ...[[0, 1, 28], [1, 2, 24], [2, 3, 40], [3, rowCount, 21]].filter(([start, end]) => start < end)
      .map(([startIndex, endIndex, pixelSize]) => ({ updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex, endIndex }, properties: { pixelSize }, fields: "pixelSize" } }))
  ];
}
describe("library sheet writes", () => {
  it("finds an existing tab by title and applies the library formatting on every write", async () => {
    const filterSpecs = [{ columnIndex: 3, filterCriteria: { hiddenValues: ["нет трафика"] } }];
    const sortSpecs = [{ dimensionIndex: 5, sortOrder: "DESCENDING" }];
    const target = { ...tab, basicFilter: { range: { startRowIndex: 2, endColumnIndex: 27 }, filterSpecs, sortSpecs } };
    const registry = { ...tab, properties: { ...tab.properties, sheetId: 77, title: "Тесты" } };
    const empty = row();
    empty.cells[3] = "нет трафика";
    const { api, batchUpdate } = fake([target, registry], "en_US");
    const result = await writeLibrarySheet(api, "sheet", { title: "Renamed", archive: false, registryTitle: "Тесты" },
      "2026-11-01", [row(), empty], new Date("2026-11-02T02:05:00Z"));
    expect(result).toEqual({ title: "Renamed", sheetId: 1991356788, created: false });
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    const requests = batchUpdate.mock.calls[0][1] as Array<Record<string, any>>;
    expect(requests.some(request => request.addSheet || request.duplicateSheet)).toBe(false);
    expect(requests.filter(request => request.updateDimensionProperties)).toEqual(titleFormatting(1991356788, 5));
    expect(requests[0].updateSheetProperties).toEqual({ properties: { sheetId: 1991356788,
      gridProperties: { rowCount: 5, columnCount: 27 } }, fields: "gridProperties.rowCount,gridProperties.columnCount" });
    const wholeGrid = { sheetId: 1991356788, startRowIndex: 0, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 27 };
    expect(requests[1].unmergeCells).toEqual({ range: wholeGrid });
    expect(requests[2].updateSheetProperties).toEqual({ properties: { sheetId: 1991356788,
      gridProperties: { frozenRowCount: 3, frozenColumnCount: 3 } },
      fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" });
    expect(requests[3].updateCells).toEqual({ range: wholeGrid, fields: "userEnteredValue,userEnteredFormat,note" });
    const update = requests.find(request => request.updateCells?.start)?.updateCells;
    expect(update.fields).toBe("userEnteredValue,userEnteredFormat,note");
    expect(update.rows[0].values[0].userEnteredValue.stringValue).toBe("Обновлено 02.11.2026 02:05 UTC");
    expect(update.rows[0].values[3].userEnteredValue.stringValue).toBe(
      "Весь срок каждой кампании по 01.11.2026 включительно (UTC) · сортировка по покупкам кампании · " +
      "пояснения — в примечаниях к заголовкам (наведите курсор)");
    expect(update.rows[0].values[3].userEnteredFormat.textFormat).toEqual({
      foregroundColor: { red: 95 / 255, green: 99 / 255, blue: 104 / 255 }, bold: false });
    expect(LIBRARY_GROUPS.map(group => update.rows[1].values[group.start].userEnteredValue.stringValue))
      .toEqual(["Тест", "Запуск и плечи", "Покупка / клик (CVR)", "Выручка / клик", "pLTV 3m (CW, прогноз)",
        "Trial→paid (Binom)", "Примечания"]);
    expect(update.rows[1].values[8].userEnteredFormat.backgroundColor)
      .toEqual({ red: 210 / 255, green: 227 / 255, blue: 252 / 255 });
    expect(update.rows[2].values[8].userEnteredFormat.backgroundColor)
      .toEqual({ red: 232 / 255, green: 240 / 255, blue: 254 / 255 });
    expect(update.rows[2].values.map((cell: any) => cell.userEnteredValue.stringValue))
      .toEqual(LIBRARY_COLUMNS.map(column => column.header));
    expect(update.rows[2].values.every((cell: any) => cell.userEnteredFormat.textFormat.fontSize === 9)).toBe(true);
    expect(update.rows[2].values[0].note).toBe("Номер строки теста во вкладке «Тесты» (ссылка). Пусто — теста нет в реестре.");
    const cells = update.rows[3].values;
    expect(LIBRARY_COLUMNS.flatMap((column, index) =>
      column.header === "Эффект [90% ДИ]" || column.header === "p" ? [index] : [])).toEqual([10, 11, 24]);
    expect(cells[10].userEnteredValue.stringValue).toBe("+2.1% [-1.9%; +6.3%]");
    expect(cells[11].userEnteredValue.stringValue).toBe("0.399");
    expect(cells[24].userEnteredValue.stringValue).toBe("<0.001");
    expect(cells[0].userEnteredValue.numberValue).toBe(8);
    expect(cells[0].userEnteredFormat.numberFormat).toEqual({ type: "NUMBER", pattern: "0" });
    expect(cells[0].userEnteredFormat.textFormat).toMatchObject({ underline: true,
      foregroundColor: { red: 17 / 255, green: 85 / 255, blue: 204 / 255 },
      link: { uri: "https://docs.google.com/spreadsheets/d/sheet/edit#gid=77&range=A8" } });
    expect(cells[5].userEnteredValue.numberValue).toBe(13);
    expect(cells[5].userEnteredFormat.numberFormat).toEqual({ type: "NUMBER", pattern: "0" });
    expect(cells[8].userEnteredFormat.numberFormat).toEqual({ type: "PERCENT", pattern: "0.00%" });
    expect(cells[14].userEnteredFormat.numberFormat).toEqual({ type: "NUMBER", pattern: '"$"0.00' });
    expect(cells[18].userEnteredFormat.numberFormat).toEqual({ type: "NUMBER", pattern: '"$"0.0' });
    expect(cells[20].userEnteredFormat.numberFormat).toEqual({ type: "PERCENT", pattern: "+0.0%;-0.0%;0.0%" });
    expect(cells[22].userEnteredFormat.numberFormat).toEqual({ type: "PERCENT", pattern: "0.0%" });
    expect(cells[3].userEnteredFormat.textFormat.foregroundColor)
      .toEqual({ red: 24 / 255, green: 128 / 255, blue: 56 / 255 });
    expect(cells.map((cell: any) => cell.userEnteredFormat.horizontalAlignment))
      .toEqual(LIBRARY_COLUMNS.map(column => column.align));
    expect(cells[12].userEnteredFormat).toMatchObject({ backgroundColor: { red: 217 / 255, green: 234 / 255, blue: 211 / 255 },
      textFormat: { foregroundColor: { red: 30 / 255, green: 86 / 255, blue: 49 / 255 }, bold: true } });
    expect(cells[16].userEnteredFormat.backgroundColor).toEqual({ red: 244 / 255, green: 204 / 255, blue: 204 / 255 });
    expect(cells[21].userEnteredFormat.backgroundColor).toEqual({ red: 1, green: 242 / 255, blue: 204 / 255 });
    expect(cells[25].userEnteredFormat).toMatchObject({ backgroundColor: { red: 1, green: 1, blue: 1 },
      textFormat: { foregroundColor: { red: 154 / 255, green: 160 / 255, blue: 166 / 255 }, bold: false } });
    expect(update.rows[4].values.every((cell: any) => cell.userEnteredFormat.textFormat.foregroundColor.red === 154 / 255
      && cell.userEnteredFormat.textFormat.foregroundColor.green === 160 / 255
      && cell.userEnteredFormat.textFormat.foregroundColor.blue === 166 / 255)).toBe(true);
    expect(update.rows[4].values[12].userEnteredFormat.backgroundColor).toEqual({ red: 1, green: 1, blue: 1 });
    const merges = requests.filter(request => request.mergeCells).map(request => request.mergeCells.range);
    expect(merges).toHaveLength(8);
    expect(merges.every(range => !(range.startColumnIndex < 3 && range.endColumnIndex > 3))).toBe(true);
    expect(requests.filter(request => request.updateBorders)).toHaveLength(7);
    expect(requests.filter(request => request.updateBorders?.left).map(request => request.updateBorders.range.startColumnIndex))
      .toEqual([3, 8, 14, 17, 22, 26]);
    expect(requests.find(request => request.updateBorders?.bottom)?.updateBorders.range).toEqual({ sheetId: 1991356788,
      startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 27 });
    expect(requests.at(-1)?.setBasicFilter.filter).toEqual({ range: { sheetId: 1991356788, startRowIndex: 2,
      endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 27 }, filterSpecs, sortSpecs });
  });
  it("keeps decimal commas for Russian and missing spreadsheet locales", async () => {
    for (const locale of ["ru_RU", undefined]) {
      const { api, batchUpdate } = fake([tab], locale);
      await writeLibrarySheet(api, "sheet", { title: "Renamed", archive: false }, "2026-11-01", [row()]);
      const requests = batchUpdate.mock.calls[0][1] as Array<Record<string, any>>;
      const update = requests.find(request => request.updateCells?.start)?.updateCells;
      expect(update.rows[3].values[10].userEnteredValue.stringValue).toBe("+2,1% [-1,9%; +6,3%]");
      expect(update.rows[3].values[11].userEnteredValue.stringValue).toBe("0,399");
      expect(update.rows[3].values[24].userEnteredValue.stringValue).toBe("<0,001");
    }
  });
  it("drops filter and sort specs from a filter using the old layout", async () => {
    const target = { ...tab, basicFilter: { range: { startRowIndex: 0, endColumnIndex: 24 },
      filterSpecs: [{ columnIndex: 3 }], sortSpecs: [{ dimensionIndex: 5, sortOrder: "DESCENDING" }] } };
    const { api, batchUpdate } = fake([target]);
    await writeLibrarySheet(api, "sheet", { title: "Renamed", archive: false }, "2026-11-01", [row()]);
    const requests = batchUpdate.mock.calls[0][1] as Array<Record<string, any>>;
    expect(requests.at(-1)?.setBasicFilter.filter).toEqual({ range: { sheetId: 1991356788, startRowIndex: 2,
      endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 27 } });
  });
  it("marks the early write as preliminary in the top note", async () => {
    const { api, batchUpdate } = fake();
    await writeLibrarySheet(api, "sheet", { title: "Renamed", archive: false, preliminary: true }, "2026-11-01", [row()]);
    const requests = batchUpdate.mock.calls[0][1] as Array<Record<string, any>>;
    const cell = requests.find(request => request.updateCells?.start)?.updateCells.rows[0].values[3];
    expect(cell.userEnteredValue.stringValue).toBe(
      "Предварительно: подписки и pLTV CW за 01.11 ещё догружаются, финальное обновление — утром (UTC) · " +
      "Весь срок каждой кампании по 01.11.2026 включительно (UTC) · сортировка по покупкам кампании · " +
      "пояснения — в примечаниях к заголовкам (наведите курсор)");
    expect(cell.userEnteredFormat.textFormat).toEqual({
      foregroundColor: { red: 176 / 255, green: 96 / 255, blue: 0 }, bold: true });
  });
  it("creates a missing tab, then formats and writes data to the returned sheetId", async () => {
    const unnamed = { properties: { sheetId: 99, index: 2, gridProperties: { rowCount: 100, columnCount: 27 } } };
    const { api, batchUpdate } = fake([tab, unnamed]);
    const result = await writeLibrarySheet(api, "sheet", { title: "Драфт отчета по всем тестам - авто", archive: false },
      "2026-11-01", [row()], new Date("2026-11-02T02:05:00Z"));
    expect(result).toEqual({ title: "Драфт отчета по всем тестам - авто", sheetId: 42, created: true });
    expect(batchUpdate).toHaveBeenCalledTimes(2);
    expect(batchUpdate.mock.calls[0][1]).toEqual([{ addSheet: { properties: { title: "Драфт отчета по всем тестам - авто",
      gridProperties: { rowCount: 100, columnCount: 27, frozenRowCount: 3, frozenColumnCount: 3 } } } }]);
    const requests = batchUpdate.mock.calls[1][1] as Array<Record<string, any>>;
    expect(requests.filter(request => request.updateDimensionProperties)).toEqual(titleFormatting(42, 100));
    const updates = requests.filter(request => request.updateCells).map(request => request.updateCells);
    expect(updates.every(update => (update.start ?? update.range).sheetId === 42)).toBe(true);
    expect(updates[1].rows[3].values[0].userEnteredValue.numberValue).toBe(8);
    expect(updates[1].rows[3].values[0].userEnteredFormat.textFormat.link).toBeUndefined();
    expect(requests.some(request => request.duplicateSheet)).toBe(false);
  });
  it("uses gid in preference to a matching title, including gid zero", async () => {
    const other = { ...tab, properties: { ...tab.properties, sheetId: 0, title: "Other", index: 0 } };
    const duplicate = { ...tab, properties: { ...tab.properties, sheetId: 3 } };
    const { api, batchUpdate } = fake([tab, other, duplicate]);
    const result = await writeLibrarySheet(api, "sheet", { gid: 0, title: "Renamed", archive: false }, "2026-11-01", [row()]);
    expect(result).toEqual({ title: "Other", sheetId: 0, created: false });
    const requests = batchUpdate.mock.calls[0][1] as Array<Record<string, any>>;
    expect(requests.filter(request => request.updateDimensionProperties)).toEqual(titleFormatting(0, 4));
    expect(requests.filter(request => request.updateCells).every(request =>
      (request.updateCells.start ?? request.updateCells.range).sheetId === 0)).toBe(true);
  });
  it("archives the target once only when enabled", async () => {
    const { api, batchUpdate } = fake();
    await writeLibrarySheet(api, "sheet", { title: "Renamed", archive: true },
      "2026-11-01", [row()], new Date("2026-11-02T02:05:00Z"));
    expect(batchUpdate).toHaveBeenCalledTimes(2);
    expect(batchUpdate.mock.calls[0][1]).toEqual([{ duplicateSheet: { sourceSheetId: 1991356788, insertSheetIndex: 2,
      newSheetName: "драфт отчета (архив 2026-11-02)" } }]);
  });
  it("archives a newly created tab before its first data write when enabled", async () => {
    const { api, batchUpdate } = fake();
    await writeLibrarySheet(api, "sheet", { title: "New", archive: true },
      "2026-11-01", [row()], new Date("2026-11-02T02:05:00Z"));
    expect(batchUpdate).toHaveBeenCalledTimes(3);
    expect(batchUpdate.mock.calls[1][1]).toEqual([{ duplicateSheet: { sourceSheetId: 42, insertSheetIndex: 2,
      newSheetName: "драфт отчета (архив 2026-11-02)" } }]);
    const requests = batchUpdate.mock.calls[2][1] as Array<Record<string, any>>;
    expect(requests.filter(request => request.updateDimensionProperties)).toEqual(titleFormatting(42, 100));
    expect(requests.some(request => request.updateCells?.start?.sheetId === 42)).toBe(true);
  });
  it("sizes a new tab for large results and handles an empty result without empty wrap ranges", async () => {
    const large = fake();
    await writeLibrarySheet(large.api, "sheet", { title: "Large", archive: false }, "2026-11-01", Array(101).fill(row()));
    expect(large.batchUpdate.mock.calls[0][1]).toEqual([{ addSheet: { properties: { title: "Large",
      gridProperties: { rowCount: 104, columnCount: 27, frozenRowCount: 3, frozenColumnCount: 3 } } } }]);
    const empty = fake();
    await writeLibrarySheet(empty.api, "sheet", { title: "Empty", archive: false }, "2026-11-01", []);
    const requests = empty.batchUpdate.mock.calls[1][1] as Array<Record<string, any>>;
    expect(requests.filter(request => request.updateDimensionProperties)).toEqual(titleFormatting(42, 100));
    expect(requests.at(-1)?.setBasicFilter.filter).toEqual({ range: { sheetId: 42, startRowIndex: 2,
      endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 27 } });
  });
  it("fails without writing data if the addSheet response has no sheetId", async () => {
    const { api, batchUpdate } = fake();
    batchUpdate.mockResolvedValueOnce({});
    await expect(writeLibrarySheet(api, "sheet", { title: "New", archive: false }, "2026-11-01", []))
      .rejects.toThrow("addSheet response missing sheetId");
    expect(batchUpdate).toHaveBeenCalledTimes(1);
  });
  it("does not rearchive and clears old rows without shrinking the grid", async () => {
    const large = { ...tab, properties: { ...tab.properties, gridProperties: { rowCount: 100, columnCount: 31 } } };
    const archive = { ...tab, properties: { ...tab.properties, sheetId: 2, title: "драфт отчета (архив 2026-01-01)" } };
    const { api, batchUpdate } = fake([large, archive]);
    await writeLibrarySheet(api, "sheet", { gid: 1991356788, title: "Renamed", archive: true }, "2026-11-01", [row()]);
    expect(batchUpdate).toHaveBeenCalledTimes(1);
    const requests = batchUpdate.mock.calls[0][1] as Array<Record<string, any>>;
    expect(requests.some(request => request.updateSheetProperties?.fields.includes("gridProperties.rowCount"))).toBe(false);
    expect(requests.find(request => request.updateCells?.range)?.updateCells.range).toEqual({ sheetId: 1991356788,
      startRowIndex: 0, endRowIndex: 100, startColumnIndex: 0, endColumnIndex: 31 });
  });
  it("fails before writing if the gid is missing", async () => {
    const { api, batchUpdate } = fake();
    await expect(writeLibrarySheet(api, "sheet", { gid: 9, title: "Renamed", archive: false },
      "2026-11-01", [])).rejects.toThrow("not found");
    expect(batchUpdate).not.toHaveBeenCalled();
  });
  it("fails before writing if the title is duplicated", async () => {
    const duplicate = { ...tab, properties: { ...tab.properties, sheetId: 2 } };
    const { api, batchUpdate } = fake([tab, duplicate]);
    await expect(writeLibrarySheet(api, "sheet", { title: "Renamed", archive: false },
      "2026-11-01", [])).rejects.toThrow("duplicate titles");
    expect(batchUpdate).not.toHaveBeenCalled();
  });
});
