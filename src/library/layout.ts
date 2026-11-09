export interface LibraryColumn {
  group: string; header: string; width: number; note: string; align: "LEFT" | "RIGHT" | "CENTER";
  kind: "text" | "number" | "verdict"; verdict?: true;
}

export const LIBRARY_GROUPS: Array<{ title: string; start: number; end: number; band: string; head: string }> = [
  { title: "Тест", start: 0, end: 3, band: "#e8eaed", head: "#f1f3f4" },
  { title: "Запуск и плечи", start: 3, end: 8, band: "#e8eaed", head: "#f1f3f4" },
  { title: "Покупка / клик (CVR)", start: 8, end: 14, band: "#d2e3fc", head: "#e8f0fe" },
  { title: "Выручка / клик", start: 14, end: 17, band: "#c8ebe6", head: "#e6f4f1" },
  { title: "pLTV 3m (CW, прогноз)", start: 17, end: 22, band: "#e1d5f5", head: "#f3edfb" },
  { title: "Trial→paid (Binom)", start: 22, end: 26, band: "#fde2c4", head: "#fef1e3" },
  { title: "Примечания", start: 26, end: 27, band: "#e8eaed", head: "#f1f3f4" }
];

function column(group: number, header: string, width: number, align: LibraryColumn["align"], note: string,
  kind: LibraryColumn["kind"] = "text"): LibraryColumn {
  return { group: LIBRARY_GROUPS[group].title, header, width, align, note, kind, ...(kind === "verdict" ? { verdict: true } : {}) };
}
const cvrNote = "Покупки (интро-постбэк Binom) / уникальные клики за весь срок кампании.";
const revenueNote = "Выручка Binom / уникальные клики.";
const pltvNote = "Прогноз выручки CW за 3 месяца на одну подписку.";
const paidNote = "Доля оплативших среди интро-покупок в когортах, которые уже созрели.";

export const LIBRARY_COLUMNS: LibraryColumn[] = [
  column(0, "№", 44, "RIGHT", "Номер строки теста во вкладке «Тесты» (ссылка). Пусто — теста нет в реестре.", "number"),
  column(0, "Тест", 130, "LEFT", "Кампания Binom: E-номер из названия. [GLOBAL] — глобальная кампания, " +
    "(#id) — несколько кампаний с одним E-номером."),
  column(0, "Эксперимент", 250, "LEFT", "Название из вкладки «Тесты»; если теста там нет — полное название кампании в Binom."),
  column(1, "Статус", 100, "LEFT", "идёт — трафик был за последние 3 дня; стоп с ДД.ММ — первый день без трафика; " +
    "нет трафика — кампания не получала кликов."),
  column(1, "Старт", 64, "RIGHT", "Первый день трафика кампании (UTC)."),
  column(1, "Покупок за 3 дня", 84, "RIGHT", "Покупки кампании (все офферы) за 3 последних дня UTC, включая день отчёта. " +
    "Заполнено в первой строке кампании.", "number"),
  column(1, "Контроль", 84, "LEFT", "Плечо, с которым сравнивают: ручное переопределение, иначе родительская " +
    "прямая воронка, иначе оффер с меньшим T-номером. В таблице только плечи с ≥ 100 уникальных кликов и ≥ 5% трафика кампании."),
  column(1, "Вариант", 84, "LEFT", "Сравниваемое плечо. Если вариантов несколько — по строке на каждый."),
  column(2, "Контроль", 84, "RIGHT", cvrNote, "number"),
  column(2, "Вариант", 84, "RIGHT", cvrNote, "number"),
  column(2, "Эффект [90% ДИ]", 160, "RIGHT", "Относительная разница CVR варианта к контролю и 90% доверительный интервал."),
  column(2, "p", 56, "RIGHT", "z-тест двух долей. При нескольких вариантах — с поправкой Холма."),
  column(2, "Вывод", 150, "LEFT", "лучше / хуже — p < 0,10; нет разницы — p ≥ 0,10; мало данных — меньше 30 покупок в плече. " +
    "«(разный старт)» — плечи начали получать трафик в разные дни, сравнение за весь срок смещено.", "verdict"),
  column(2, "Покупок К / В", 104, "RIGHT", "Покупки в контроле / варианте."),
  column(3, "Контроль", 84, "RIGHT", revenueNote, "number"),
  column(3, "Вариант", 84, "RIGHT", revenueNote, "number"),
  column(3, "Вывод", 104, "LEFT", "Порог ±5% без статистического теста: лучше — вариант выше контроля больше чем на 5%. " +
    "Мало данных — меньше 30 покупок в плече.", "verdict"),
  column(4, "Подписок К / В", 104, "RIGHT", "Подписки CampaignsWell по разметке оффера (контроль / вариант)."),
  column(4, "Контроль", 84, "RIGHT", pltvNote, "number"),
  column(4, "Вариант", 84, "RIGHT", pltvNote, "number"),
  column(4, "Эффект", 76, "RIGHT", "pLTV варианта к контролю.", "number"),
  column(4, "Вывод", 104, "LEFT", "Порог ±5% без p, по прогнозу. Мало данных — меньше 30 подписок в плече.", "verdict"),
  column(5, "Контроль", 84, "RIGHT", paidNote, "number"),
  column(5, "Вариант", 84, "RIGHT", paidNote, "number"),
  column(5, "p", 56, "RIGHT", "z-тест; нужно ≥ 10 оплат в плече."),
  column(5, "Вывод", 104, "LEFT", "лучше / хуже — p < 0,10.", "verdict"),
  column(6, "Примечания", 640, "LEFT", "Особенности данных: малый трафик офферов, покрытие постбэков, " +
    "созревание trial→paid, разметка CW.")
];

export const LIBRARY_HEADER = LIBRARY_COLUMNS.map(({ group, header }) => `${group} · ${header}`);
export const LIBRARY_FROZEN_COLUMNS = 3;
