import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { demoData, parseTable, estimate, createOptimizer, metrics } from './dist/engine.js';

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const output = join(projectDirectory, 'dist', 'examples', 'portfolio-example.xlsx');
const demo = demoData();
const round = value => Math.round(value * 1e6) / 1e6;
const dataTable = [
  ['Дата', 'ИПЦ', ...demo.names],
  ...demo.rows.map(row => [row.date, round(row.cpi), ...row.values.map(round)]),
];

const instructions = [
  ['Учебный пример для анализа портфеля', 'Синтетические данные: это не реальные котировки и не прогноз.'],
  ['Период', '85 ежемесячных наблюдений: январь 2019 — январь 2026; даты на конец месяца.'],
  ['1. Загрузка', 'Откройте вкладку «Данные», выберите загрузку Excel и этот файл. Приложение читает первый лист «Данные».'],
  ['2. Периодичность', 'Выберите «Месячные данные» (12 периодов в год).'],
  ['3. Начальный капитал', '1 000 000 ₽.'],
  ['4. Ставка', '8% годовых. Для сравнения используйте одну и ту же ставку для всех портфелей.'],
  ['5. Марковиц', 'Коэффициент неприятия риска λ = 3.'],
  ['6. Эффективный риск', 'Целевая доходность = 10% годовых; приложение найдёт минимальный риск.'],
  ['7. Эффективная доходность', 'Лимит риска = 20% годовых; приложение найдёт максимальную доходность.'],
  ['8. Сравнение', 'Откройте вкладку «Сравнение» и нажмите «Сравнить 4 критерия».'],
  ['9. Результаты', 'Сравните четыре портфеля: Марковиц, максимум Шарпа, эффективный риск, эффективная доходность.'],
  ['10. Графики', 'Во вкладке «Графики» выберите портфель для просмотра отдельных рисунков; общий график находится внизу.'],
  ['Формат первого листа', '12 столбцов: Дата, ИПЦ и ровно 10 индикаторов. Одна строка на месяц, без пустых значений и повторов дат.'],
  ['ИПЦ', 'Накопленный индекс потребительских цен, январь 2019 = 100. Например, 105 означает рост цен на 5% относительно базы; это не месячная инфляция 105%.'],
  ['Значения индикаторов', 'Положительные уровни в рублёвом выражении; не проценты доходности. Все числа сохранены с точностью до 6 знаков после запятой.'],
  ['Поправка на инфляцию', 'Приложение рассчитывает доходности из изменений уровней и корректирует их на ИПЦ. Не вычитайте инфляцию заранее.'],
  ['Индикатор 1: М2', 'Рублёвая денежная масса М2 — макроэкономический учебный индикатор. Это не покупаемый актив; вес М2 служит для демонстрации расчётов.'],
  ['Замена на реальные ряды', 'Сохраните заголовки и структуру. Используйте одинаковые даты, периодичность и сопоставимые рублёвые уровни; замените также ИПЦ.'],
];

const descriptions = [
  ['№', 'Индикатор', 'Единицы / интерпретация', 'Источник', 'Примечание'],
  [1, demo.names[0], 'млрд ₽; учебный уровень денежной массы', 'Синтетический ряд demoData(), фиксированное зерно генератора', 'М2 — макроэкономический учебный индикатор, не торгуемый актив.'],
  [2, demo.names[1], '₽ за грамм; учебный уровень', 'Синтетический ряд demoData()', 'Не котировки золота.'],
  [3, demo.names[2], '₽ за 1 USD; учебный курс', 'Синтетический ряд demoData()', 'Не официальный валютный курс.'],
  [4, demo.names[3], '₽ за 1 EUR; учебный курс', 'Синтетический ряд demoData()', 'Не официальный валютный курс.'],
  [5, demo.names[4], '₽ за 1 CNY; учебный курс', 'Синтетический ряд demoData()', 'Не официальный валютный курс.'],
  [6, demo.names[5], 'Учебный рублёвый уровень индексной корзины', 'Синтетический ряд demoData()', 'Условная рублёвая стоимость; не значения биржевого индекса.'],
  [7, demo.names[6], 'Учебный рублёвый уровень облигационной корзины', 'Синтетический ряд demoData()', 'Условная рублёвая стоимость; не значения индекса RGBITR.'],
  [8, demo.names[7], 'Индекс рублёвых цен на жильё, январь 2019 = 100', 'Синтетический ряд demoData()', 'Учебная динамика стоимости жилья, без арендного дохода; не реальные цены недвижимости.'],
  [9, demo.names[8], '₽ за грамм; учебный уровень', 'Синтетический ряд demoData()', 'Не котировки серебра.'],
  [10, demo.names[9], 'Учебный рублёвый уровень индексной корзины', 'Синтетический ряд demoData()', 'Условная рублёвая стоимость S&P 500; не долларовый индекс.'],
  ['', 'ИПЦ', 'Накопленный индекс, январь 2019 = 100', 'Синтетический ряд demoData()', 'Один общий дефлятор для всех индикаторов.'],
  ['', 'Общий источник', 'Все уровни в рублёвом выражении', 'Учебный генератор приложения, без внешних источников', 'Все данные синтетические. Не использовать как исторические котировки или инвестиционные рекомендации.'],
];

const workbook = XLSX.utils.book_new();
workbook.Props = {
  Title: 'Портфель: синтетический учебный пример',
  Subject: '85 месячных наблюдений, ИПЦ и 10 индикаторов',
  Author: 'Portfolio Lab',
  Comments: 'Учебные синтетические данные, не реальные котировки.',
};

const dataSheet = XLSX.utils.aoa_to_sheet(dataTable);
dataSheet['!cols'] = [{ wch: 13 }, { wch: 15 }, ...demo.names.map(name => ({ wch: Math.max(20, name.length + 2) }))];
dataSheet['!autofilter'] = { ref: dataSheet['!ref'] };
for (let row = 1; row < dataTable.length; row++) {
  for (let column = 1; column < 12; column++) {
    dataSheet[XLSX.utils.encode_cell({ r: row, c: column })].z = '0.000000';
  }
}
const helpSheet = XLSX.utils.aoa_to_sheet(instructions);
helpSheet['!cols'] = [{ wch: 28 }, { wch: 135 }];
const descriptionSheet = XLSX.utils.aoa_to_sheet(descriptions);
descriptionSheet['!cols'] = [{ wch: 5 }, { wch: 28 }, { wch: 55 }, { wch: 70 }, { wch: 85 }];
XLSX.utils.book_append_sheet(workbook, dataSheet, 'Данные');
XLSX.utils.book_append_sheet(workbook, helpSheet, 'Как использовать');
XLSX.utils.book_append_sheet(workbook, descriptionSheet, 'Описание');

await mkdir(dirname(output), { recursive: true });
await writeFile(output, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', compression: true }));

// Validate the actual exported workbook with the same parser and calculations as the app.
const restored = XLSX.read(await readFile(output), { type: 'buffer' });
assert.deepEqual(restored.SheetNames, ['Данные', 'Как использовать', 'Описание']);
const restoredTable = XLSX.utils.sheet_to_json(restored.Sheets['Данные'], { header: 1, defval: null });
assert.deepEqual(restoredTable, dataTable);
const parsed = parseTable(restoredTable);
assert.deepEqual(parsed.names, demo.names);
assert.match(parsed.names[0], /М2/);
assert.equal(parsed.rows.length, 85);
assert.equal(parsed.rows[0].date, '2019-01-31');
assert.equal(parsed.rows.at(-1).date, '2026-01-31');
assert.ok(parsed.rows.every(row => row.cpi > 0 && row.values.length === 10 && row.values.every(value => Number.isFinite(value) && value > 0)));
const model = estimate(parsed, 12);
const optimizer = createOptimizer(model);
const nominalRate = 0.08;
const realRate = (1 + nominalRate) / (1 + model.inflation) - 1;
const parameters = { lambda: 3, rf: realRate, targetReturn: 0.10, targetRisk: 0.20 };
const results = ['markowitz', 'sharpe', 'risk', 'return'].map(mode => {
  const portfolio = optimizer.solve(mode, parameters);
  assert.ok(Math.abs(portfolio.weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-6);
  const report = metrics(model, portfolio.weights, parameters.rf, 1_000_000);
  for (const key of ['expectedReturn', 'risk', 'sharpe', 'cagr', 'totalReturn', 'maxDrawdown', 'maxRecovery', 'expectedIncome', 'finalCapital']) {
    assert.ok(Number.isFinite(report[key]), `${mode}: ${key} must be finite`);
  }
  assert.equal(report.wealth.length, 85);
  return `${mode}: доходность ${(report.expectedReturn * 100).toFixed(2)}%, риск ${(report.risk * 100).toFixed(2)}%`;
});
const file = await stat(output);
console.log(`Создан ${output} (${file.size} байт).`);
console.log('Проверено: Excel → parseTable; 85 месяцев; М2 первым; 4 критерия и все показатели рассчитаны.');
console.log(results.join('\n'));
