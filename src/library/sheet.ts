import type { SheetsApi } from "../sheets/client.js";
import type { LibraryCell, LibraryNumberFormat, LibraryRow } from "./compute.js";
import { fullDate, shortDate } from "./format.js";
import { LIBRARY_COLUMNS, LIBRARY_FROZEN_COLUMNS, LIBRARY_GROUPS } from "./layout.js";

const decimalCommaTextColumns = new Set(LIBRARY_COLUMNS.flatMap((column, index) =>
  column.header === "Эффект [90% ДИ]" || column.header === "p" ? [index] : []));
const color = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const numberFormats: Record<LibraryNumberFormat, { type: string; pattern: string }> = {
  int: { type: "NUMBER", pattern: "0" }, count: { type: "NUMBER", pattern: "0" },
  percent1: { type: "PERCENT", pattern: "0.0%" }, percent2: { type: "PERCENT", pattern: "0.00%" },
  signedPercent1: { type: "PERCENT", pattern: "+0.0%;-0.0%;0.0%" },
  usd1: { type: "NUMBER", pattern: '"$"0.0' }, usd2: { type: "NUMBER", pattern: '"$"0.00' }
};
function dataCell(value: LibraryCell, column: number, noTraffic: boolean, registryLink?: string) {
  const normalized = typeof value === "number" && !Number.isFinite(value) ? "—"
    : typeof value === "object" && !Number.isFinite(value.value) ? "—" : value;
  const numeric = typeof normalized === "number" ? normalized : typeof normalized === "object" ? normalized.value : undefined;
  const userEnteredValue = numeric !== undefined ? { numberValue: numeric }
    : normalized === "" ? undefined : { stringValue: normalized };
  let foreground = "#202124";
  let background = "#ffffff";
  let bold = false;
  if (noTraffic) foreground = "#9aa0a6";
  else if (column === 3 && typeof normalized === "string") {
    foreground = normalized === "идёт" ? "#188038" : normalized.startsWith("стоп с ") ? "#5f6368" : "#9aa0a6";
  } else if (LIBRARY_COLUMNS[column].verdict && typeof normalized === "string") {
    if (normalized.startsWith("лучше")) { background = "#d9ead3"; foreground = "#1e5631"; bold = true; }
    else if (normalized.startsWith("хуже")) { background = "#f4cccc"; foreground = "#8b1a1a"; bold = true; }
    else if (normalized.startsWith("мало данных")) { background = "#fff2cc"; foreground = "#7a5c00"; }
    else if (normalized.startsWith("нет разницы")) foreground = "#3c4043";
    else if (normalized.startsWith("не сравнить") || normalized.startsWith("нет данных")) foreground = "#9aa0a6";
  }
  if (registryLink && numeric !== undefined && !noTraffic) foreground = "#1155cc";
  return { ...(userEnteredValue ? { userEnteredValue } : {}), userEnteredFormat: {
    horizontalAlignment: LIBRARY_COLUMNS[column].align, verticalAlignment: "MIDDLE", wrapStrategy: "CLIP",
    backgroundColor: color(background), textFormat: { foregroundColor: color(foreground), bold,
      ...(registryLink && numeric !== undefined ? { underline: true, link: { uri: registryLink } } : {}) },
    ...(typeof normalized === "object" ? { numberFormat: numberFormats[normalized.format] } : {})
  } };
}
export async function writeLibrarySheet(api: SheetsApi, spreadsheetId: string, options: { gid?: number; title: string;
  archive: boolean; registryTitle?: string; preliminary?: boolean }, day: string, rows: LibraryRow[], now = new Date()):
  Promise<{ title: string; sheetId: number; created: boolean }> {
  const spreadsheet = await api.getSpreadsheet(spreadsheetId);
  if (!Array.isArray(spreadsheet.sheets)) throw new Error("Google Sheets missing sheet properties");
  let decimalComma = true;
  if (spreadsheet.properties?.locale) {
    try {
      decimalComma = new Intl.NumberFormat(spreadsheet.properties.locale.replace("_", "-")).formatToParts(1.5)
        .find(part => part.type === "decimal")?.value === ",";
    } catch { /* Keep the existing text when the locale is missing or invalid. */ }
  }
  const matches = spreadsheet.sheets.map(sheet => sheet.properties).filter(sheet => options.gid !== undefined
    ? sheet?.sheetId === options.gid : sheet?.title === options.title);
  if (options.gid === undefined && matches.length > 1) throw new Error("Google Sheets library tab has duplicate titles");
  let properties = matches[0];
  let created = false;
  if (!properties && options.gid === undefined) {
    const gridProperties = { rowCount: Math.max(rows.length + 3, 100), columnCount: LIBRARY_COLUMNS.length,
      frozenRowCount: 3, frozenColumnCount: LIBRARY_FROZEN_COLUMNS };
    const response = await api.batchUpdate(spreadsheetId, [{ addSheet: { properties: { title: options.title, gridProperties } } }]);
    const reply = response.replies?.[0] as { addSheet?: { properties?: { sheetId?: unknown } } } | undefined;
    const sheetId = reply?.addSheet?.properties?.sheetId;
    if (typeof sheetId !== "number" || !Number.isSafeInteger(sheetId) || sheetId < 0) {
      throw new Error("Google Sheets addSheet response missing sheetId");
    }
    properties = { sheetId, title: options.title, index: spreadsheet.sheets.length, gridProperties };
    created = true;
  }
  if (!properties || properties.sheetId === undefined || properties.title === undefined || properties.index === undefined
    || properties.gridProperties?.rowCount === undefined
    || properties.gridProperties.columnCount === undefined) {
    throw new Error("Google Sheets library tab not found or missing grid properties");
  }
  const gid = properties.sheetId;
  if (options.archive && !properties.title.startsWith("драфт отчета (архив")
    && !spreadsheet.sheets.some(sheet => sheet.properties?.title?.startsWith("драфт отчета (архив"))) {
    await api.batchUpdate(spreadsheetId, [{ duplicateSheet: { sourceSheetId: gid, insertSheetIndex: properties.index + 1,
      newSheetName: `драфт отчета (архив ${now.toISOString().slice(0, 10)})` } }]);
  }
  const rowCount = Math.max(properties.gridProperties.rowCount, rows.length + 3);
  const columnCount = Math.max(properties.gridProperties.columnCount, LIBRARY_COLUMNS.length);
  const registryGid = options.registryTitle === undefined ? undefined
    : spreadsheet.sheets.find(sheet => sheet.properties?.title === options.registryTitle)?.properties?.sheetId;
  const basicFilter = spreadsheet.sheets.find(sheet => sheet.properties?.sheetId === gid)?.basicFilter;
  const existingFilter = basicFilter?.range?.startRowIndex === 2 &&
    basicFilter.range.endColumnIndex === LIBRARY_COLUMNS.length ? basicFilter : undefined;
  const requests: unknown[] = [];
  if (rowCount !== properties.gridProperties.rowCount || columnCount !== properties.gridProperties.columnCount) {
    requests.push({ updateSheetProperties: { properties: { sheetId: gid, gridProperties: { rowCount, columnCount } },
      fields: "gridProperties.rowCount,gridProperties.columnCount" } });
  }
  const wholeGrid = { sheetId: gid, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount };
  requests.push({ unmergeCells: { range: wholeGrid } });
  requests.push({ updateSheetProperties: { properties: { sheetId: gid,
    gridProperties: { frozenRowCount: 3, frozenColumnCount: LIBRARY_FROZEN_COLUMNS } },
    fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } });
  requests.push({ updateCells: { range: wholeGrid, fields: "userEnteredValue,userEnteredFormat,note" } });
  LIBRARY_COLUMNS.forEach((column, startIndex) => requests.push({ updateDimensionProperties: {
    range: { sheetId: gid, dimension: "COLUMNS", startIndex, endIndex: startIndex + 1 },
    properties: { pixelSize: column.width }, fields: "pixelSize" } }));
  for (const [startIndex, endIndex, pixelSize] of [[0, 1, 28], [1, 2, 24], [2, 3, 40], [3, rowCount, 21]]) {
    if (startIndex < endIndex) requests.push({ updateDimensionProperties: {
      range: { sheetId: gid, dimension: "ROWS", startIndex, endIndex }, properties: { pixelSize }, fields: "pixelSize" } });
  }
  const timestamp = now.toISOString();
  const titleNote = (options.preliminary
    ? `Предварительно: подписки и pLTV CW за ${shortDate(day)} ещё догружаются, финальное обновление — утром (UTC) · ` : "") +
    `Весь срок каждой кампании по ${fullDate(day)} включительно (UTC) · сортировка по покупкам кампании · ` +
    "пояснения — в примечаниях к заголовкам (наведите курсор)";
  const top = LIBRARY_COLUMNS.map((_, index) => {
    const preliminary = index === 3 && options.preliminary === true;
    const value = index === 0 ? `Обновлено ${fullDate(timestamp.slice(0, 10))} ${timestamp.slice(11, 16)} UTC`
      : index === 3 ? titleNote : "";
    return { ...(value ? { userEnteredValue: { stringValue: value } } : {}), userEnteredFormat: {
      verticalAlignment: "MIDDLE", wrapStrategy: "CLIP", backgroundColor: color("#ffffff"),
      textFormat: { foregroundColor: color(index < 3 ? "#202124" : preliminary ? "#b06000" : "#5f6368"),
        bold: index < 3 || preliminary } } };
  });
  const bands = LIBRARY_COLUMNS.map((_, index) => {
    const group = LIBRARY_GROUPS.find(item => item.start <= index && index < item.end)!;
    return { ...(index === group.start ? { userEnteredValue: { stringValue: group.title } } : {}), userEnteredFormat: {
      horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", backgroundColor: color(group.band),
      textFormat: { foregroundColor: color("#202124"), bold: true } } };
  });
  const headers = LIBRARY_COLUMNS.map((column, index) => {
    const group = LIBRARY_GROUPS.find(item => item.start <= index && index < item.end)!;
    return { userEnteredValue: { stringValue: column.header }, note: column.note, userEnteredFormat: {
      horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP", backgroundColor: color(group.head),
      textFormat: { foregroundColor: color("#202124"), bold: true, fontSize: 9 } } };
  });
  const data = rows.map(row => ({ values: row.cells.map((value, index) => {
    const cellValue = !decimalComma && decimalCommaTextColumns.has(index) && typeof value === "string"
      ? value.replace(/(\d),(\d)/g, "$1.$2") : value;
    const registryRow = typeof value === "number" ? value : typeof value === "object" ? value.value : undefined;
    const link = index === 0 && registryGid !== undefined && registryRow !== undefined
      ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${registryGid}&range=A${registryRow}` : undefined;
    return dataCell(cellValue, index, row.cells[3] === "нет трафика", link);
  }) }));
  requests.push({ updateCells: { start: { sheetId: gid, rowIndex: 0, columnIndex: 0 },
    rows: [{ values: top }, { values: bands }, { values: headers }, ...data],
    fields: "userEnteredValue,userEnteredFormat,note" } });
  for (const [startRowIndex, startColumnIndex, endColumnIndex] of [[0, 0, 3], [0, 3, LIBRARY_COLUMNS.length],
    ...LIBRARY_GROUPS.filter(group => group.end - group.start > 1).map(group => [1, group.start, group.end])]) {
    requests.push({ mergeCells: { range: { sheetId: gid, startRowIndex, endRowIndex: startRowIndex + 1,
      startColumnIndex, endColumnIndex }, mergeType: "MERGE_ALL" } });
  }
  const border = { style: "SOLID", color: color("#9aa0a6") };
  for (const group of LIBRARY_GROUPS.slice(1)) requests.push({ updateBorders: {
    range: { sheetId: gid, startRowIndex: 1, endRowIndex: rows.length + 3,
      startColumnIndex: group.start, endColumnIndex: group.start + 1 }, left: border } });
  requests.push({ updateBorders: { range: { sheetId: gid, startRowIndex: 2, endRowIndex: 3,
    startColumnIndex: 0, endColumnIndex: LIBRARY_COLUMNS.length }, bottom: border } });
  requests.push({ setBasicFilter: { filter: { range: { sheetId: gid, startRowIndex: 2, endRowIndex: rows.length + 3,
    startColumnIndex: 0, endColumnIndex: LIBRARY_COLUMNS.length },
    ...(existingFilter?.filterSpecs ? { filterSpecs: existingFilter.filterSpecs } : {}),
    ...(existingFilter?.sortSpecs ? { sortSpecs: existingFilter.sortSpecs } : {}) } } });
  await api.batchUpdate(spreadsheetId, requests);
  return { title: properties.title, sheetId: gid, created };
}
