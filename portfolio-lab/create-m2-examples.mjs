import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { demoData, parseTable, estimate, createOptimizer, metrics } from './dist/engine.js';
import { exampleDefinitions } from './dist/example-portfolios.js';

const directory = dirname(fileURLToPath(import.meta.url));
const observationCount = 85;
const periods = observationCount - 1;
const annualInflation = 0.05;
const nominalRate = 0.08;
const realRate = (1 + nominalRate) / (1 + annualInflation) - 1;
const standardDeviations = [0.06, 0.20, 0.15, 0.16, 0.13, 0.22, 0.10, 0.12, 0.26, 0.24];
const otherProportions = [0.16, 0.12, 0.08, 0.08, 0.13, 0.10, 0.10, 0.10, 0.13];
const diversifiedProportions = [0.20, 0.08, 0.04, 0.04, 0.10, 0.14, 0.28, 0.06, 0.06];
const demo = demoData();
const names = demo.names;
const modes = ['sharpe', 'markowitz', 'risk', 'return'];
const modeLabels = ['Максимум Шарпа', 'Марковиц, λ = 3', 'Эффективный риск, доходность ≥ 10%', 'Эффективная доходность, риск ≤ 20%'];
const rounded = number => Math.round(number * 1e9) / 1e9;

function createTable(m2Share) {
  const proportions = m2Share === 0.10 ? diversifiedProportions : otherProportions;
  const intendedWeights = [m2Share, ...proportions.map(proportion => (1 - m2Share) * proportion)];
  // Orthogonal monthly sine waves have zero sample cross-covariance. For a
  // diagonal covariance matrix, the maximum-Sharpe solution is proportional to
  // (mean - real risk-free rate) / variance. These means therefore produce the
  // requested M2 proportion through normal optimization, without weight limits
  // or overrides. The unmodified application engine verifies the exported file.
  const means = standardDeviations.map((deviation, index) => realRate + 35 * deviation ** 2 * intendedWeights[index]);
  const monthlyInflationFactor = (1 + annualInflation) ** (1 / 12);
  const waveScale = Math.sqrt(2 * (periods - 1) / (periods * 12));
  let values = [...demo.rows[0].values];
  let cpi = 100;
  const table = [['Дата', 'ИПЦ', ...names]];
  for (let period = 0; period < observationCount; period++) {
    if (period) {
      cpi *= monthlyInflationFactor;
      values = values.map((value, index) => {
        const realReturn = means[index] / 12 + standardDeviations[index] * waveScale * Math.sin(2 * Math.PI * (index + 1) * period / periods);
        return value * (1 + realReturn) * monthlyInflationFactor;
      });
    }
    const date = new Date(Date.UTC(2019, period + 1, 0)).toISOString().slice(0, 10);
    table.push([date, rounded(cpi), ...values.map(rounded)]);
  }
  return { table, intendedWeights };
}

function analyze(table, m2Share) {
  const data = parseTable(table);
  assert.equal(data.rows.length, observationCount);
  assert.equal(data.rows[0].date, '2019-01-31');
  assert.equal(data.rows.at(-1).date, '2026-01-31');
  assert.match(data.names[0], /М2/);
  const model = estimate(data, 12, false);
  const optimizer = createOptimizer(model);
  const parameters = { lambda: 3, rf: (1 + nominalRate) / (1 + model.inflation) - 1, targetReturn: 0.10, targetRisk: 0.20 };
  const results = modes.map(mode => {
    const solution = optimizer.solve(mode, parameters);
    const summary = metrics(model, solution.weights, parameters.rf, 1_000_000);
    assert.ok(solution.weights.every(weight => Number.isFinite(weight) && weight >= 0));
    assert.ok(Math.abs(solution.weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-8);
    for (const key of ['expectedReturn', 'risk', 'sharpe', 'cagr', 'totalReturn', 'maxDrawdown', 'maxRecovery', 'finalCapital']) {
      assert.ok(Number.isFinite(summary[key]), `${mode}: ${key} must be finite`);
    }
    return { mode, solution, summary };
  });
  assert.ok(Math.abs(results[0].solution.weights[0] - m2Share) < 0.000005, 'Exported workbook must optimize to the requested M2 share.');
  assert.equal((results[0].solution.weights[0] * 100).toFixed(2), (m2Share * 100).toFixed(2));
  return { data, model, parameters, results };
}

function makeWorkbook(m2Share) {
  const label = (m2Share * 100).toFixed(2).replace('.', ',');
  const profile = `m2-${label.replace(',', '-')}`;
  const { table, intendedWeights } = createTable(m2Share);
  const { model, parameters, results } = analyze(table, m2Share);
  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Title: `Учебный портфель: доля М2 ${label}% при максимуме Шарпа`,
    Subject: 'Синтетические уровни: 85 месяцев, ИПЦ и 10 индикаторов',
    Author: 'Portfolio Lab',
    Comments: 'Веса получены обычной оптимизацией, без принудительного ограничения доли М2. Это не реальные котировки.',
  };
  const dataSheet = XLSX.utils.aoa_to_sheet(table);
  dataSheet['!cols'] = [{ wch: 14 }, { wch: 17 }, ...names.map(name => ({ wch: Math.max(20, name.length + 2) }))];
  dataSheet['!autofilter'] = { ref: dataSheet['!ref'] };
  for (let row = 1; row < table.length; row++) {
    for (let column = 1; column < 12; column++) dataSheet[XLSX.utils.encode_cell({ r: row, c: column })].z = '0.000000000';
  }
  const instructions = [
    [`Учебный пример: доля М2 ${label}%`, 'Все данные синтетические. Это демонстрация модели, а не реальные котировки или прогноз.'],
    ['Как получена доля', 'Средние и дисперсии синтетических рядов подобраны так, чтобы обычный максимум коэффициента Шарпа дал указанную долю М2. Доля не задаётся ограничением и не подменяется после расчёта.'],
    ['1. Загрузка', 'Откройте «Данные» и загрузите этот файл либо нажмите кнопку соответствующего учебного примера. Приложение читает первый лист «Данные».'],
    ['2. Критерий', 'Выберите «Максимизация коэффициента Шарпа».'],
    ['3. Периодичность', 'Месячные данные: 12 периодов в год. 85 наблюдений: январь 2019 — январь 2026.'],
    ['4. Безрисковая ставка', '8% годовых, номинальная. Приложение само корректирует ставку на инфляцию; здесь ИПЦ соответствует 5% годовых.'],
    ['5. Первый индикатор', 'Рублёвая масса М2. Не заменяйте её рублёвым денежным остатком: это другой ряд доходностей.'],
    ['6. Расчёт', `Начальный капитал 1 000 000 ₽. Нажмите «Рассчитать портфель»: доля М2 при выбранных настройках округляется до ${label}%.`],
    ['7. Проверка', 'Посмотрите круговую диаграмму весов во вкладке «Графики» и лист «Ожидаемые веса» этого файла.'],
    ['8. Сравнение критериев', 'Нажмите «Сравнить 4 критерия»: Марковиц λ = 3, эффективный риск с доходностью 10%, эффективная доходность с риском 20%. В других критериях доля М2 может быть иной.'],
    ['9. Проверка по времени', 'При разделении на обучение и проверку веса оцениваются заново только на обучающем периоде, поэтому доля М2 может отличаться.'],
    ['Область применимости доли', `${label}% относится к максимуму Шарпа на полном периоде этого файла, при ставке 8%, месячных данных и использовании М2. Изменение периода, ставки, критерия или первого индикатора меняет результат.`],
    ['ИПЦ', 'Накопленный индекс потребительских цен, январь 2019 = 100. Это не месячные проценты инфляции.'],
    ['Уровни', 'Положительные уровни в условном рублёвом выражении, 9 знаков после запятой. Не вычитайте инфляцию заранее: приложение корректирует доходности на ИПЦ.'],
    ['М2', 'Рублёвая денежная масса — макроэкономический учебный индикатор, не покупаемый биржевой актив. Вес М2 здесь иллюстрирует оптимизацию.'],
  ];
  const helpSheet = XLSX.utils.aoa_to_sheet(instructions);
  helpSheet['!cols'] = [{ wch: 31 }, { wch: 145 }];
  const expected = [
    ['Индикатор', ...modeLabels, 'Расчётная реальная доходность, годовая', 'Расчётная волатильность, годовая', 'Целевая учебная доля для Шарпа'],
    ...names.map((name, index) => [name, ...results.map(result => result.solution.weights[index]), model.mu[index], Math.sqrt(model.cov[index][index]), intendedWeights[index]]),
    ['Сумма весов', ...results.map(result => result.solution.weights.reduce((sum, weight) => sum + weight, 0))],
    ['Ожидаемая реальная доходность', ...results.map(result => result.summary.expectedReturn)],
    ['Ожидаемая волатильность', ...results.map(result => result.summary.risk)],
    ['Коэффициент Шарпа', ...results.map(result => result.summary.sharpe)],
    ['Безрисковая ставка, реальная', parameters.rf],
    ['Безрисковая ставка, номинальная', nominalRate],
    ['Инфляция, годовая', model.inflation],
    ['Все веса рассчитаны движком приложения', 'Результаты остальных критериев приведены для сравнения; совпадение доли М2 требуется только для максимума Шарпа.'],
  ];
  const expectedSheet = XLSX.utils.aoa_to_sheet(expected);
  expectedSheet['!cols'] = [{ wch: 42 }, ...Array(7).fill({ wch: 32 })];
  for (let row = 1; row <= 13; row++) {
    for (let column = 1; column < expected[row].length; column++) {
      const cell = expectedSheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell?.t === 'n') cell.z = '0.00%';
    }
  }
  for (let row = 15; row <= 17; row++) expectedSheet[XLSX.utils.encode_cell({ r: row, c: 1 })].z = '0.00%';
  const descriptions = [
    ['Индикатор', 'Уровень / единицы', 'Источник'],
    ['Рублёвая масса М2', 'млрд ₽, условная денежная масса', 'Синтетический генератор create-m2-examples.mjs'],
    ['Золото', '₽ за грамм, условный уровень', 'Синтетический генератор'],
    ['Доллар США', '₽ за USD, условный курс', 'Синтетический генератор'],
    ['Евро', '₽ за EUR, условный курс', 'Синтетический генератор'],
    ['Юань', '₽ за CNY, условный курс', 'Синтетический генератор'],
    ['Индекс Мосбиржи', 'Условная рублёвая стоимость индексной корзины', 'Синтетический генератор'],
    ['ОФЗ / RGBITR', 'Условная рублёвая стоимость облигационной корзины', 'Синтетический генератор'],
    ['Индекс недвижимости', 'Индекс рублёвых цен на жильё, январь 2019 = 100; без арендного дохода', 'Синтетический генератор'],
    ['Серебро', '₽ за грамм, условный уровень', 'Синтетический генератор'],
    ['Индекс S&P 500', 'Условная рублёвая стоимость индексной корзины', 'Синтетический генератор'],
    ['ИПЦ', 'Накопленный индекс, январь 2019 = 100', 'Синтетические 5% годовых'],
    ['Метод генерации', 'Ортогональные колебания доходностей, калиброванные средние и дисперсии', 'Детерминированный учебный пример без внешних данных'],
  ];
  const descriptionSheet = XLSX.utils.aoa_to_sheet(descriptions);
  descriptionSheet['!cols'] = [{ wch: 29 }, { wch: 80 }, { wch: 65 }];
  const settingsSheet = XLSX.utils.aoa_to_sheet([
    ['Параметр', 'Значение'],
    ['Тип', 'Учебный пример · синтетические данные'],
    ['Профиль', profile],
    ['Критерий', 'sharpe'],
    ['Номинальная ставка, %', 8],
    ['Периодов в год', 12],
    ['Первый индикатор', 'm2'],
    ['Начальный капитал, ₽', 1_000_000],
    ['Ожидаемая доля М2', m2Share],
    ['Версия', 1],
  ]);
  settingsSheet['!cols'] = [{ wch: 29 }, { wch: 65 }];
  XLSX.utils.book_append_sheet(workbook, dataSheet, 'Данные');
  XLSX.utils.book_append_sheet(workbook, helpSheet, 'Как использовать');
  XLSX.utils.book_append_sheet(workbook, expectedSheet, 'Ожидаемые веса');
  XLSX.utils.book_append_sheet(workbook, descriptionSheet, 'Описание');
  XLSX.utils.book_append_sheet(workbook, settingsSheet, 'Параметры');
  return { workbook, profile, table };
}

await mkdir(join(directory, 'dist', 'examples'), { recursive: true });
for (const {m2Share} of exampleDefinitions) {
  const { workbook, profile, table } = makeWorkbook(m2Share);
  const filename = join(directory, 'dist', 'examples', `portfolio-${profile}.xlsx`);
  await writeFile(filename, XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', compression: true }));
  const restored = XLSX.read(await readFile(filename), { type: 'buffer' });
  const restoredTable = XLSX.utils.sheet_to_json(restored.Sheets['Данные'], { header: 1, defval: null });
  assert.deepEqual(restoredTable, table);
  const { results } = analyze(restoredTable, m2Share);
  console.log(`${filename}: М2 ${(results[0].solution.weights[0] * 100).toFixed(6)}%; 85 месяцев; все 4 критерия проверены.`);
}
