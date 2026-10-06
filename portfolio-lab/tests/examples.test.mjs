import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import XLSX from 'xlsx';
import { parseTable, estimate, createOptimizer, metrics } from '../dist/engine.js';

for (const [profile, expectedShare] of [['m2-90-67', 0.9067], ['m2-60-67', 0.6067]]) {
  test(`${profile}: actual Excel input optimizes to the advertised M2 share`, async () => {
    const workbook = XLSX.read(await readFile(new URL(`../dist/examples/portfolio-${profile}.xlsx`, import.meta.url)), { type: 'buffer' });
    const table = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null });
    const data = parseTable(table);
    assert.equal(data.rows.length, 85);
    assert.equal(data.rows[0].date, '2019-01-31');
    assert.equal(data.rows.at(-1).date, '2026-01-31');
    assert.match(data.names[0], /М2/);
    const model = estimate(data, 12, false);
    const parameters = { rf: 1.08 / (1 + model.inflation) - 1, lambda: 3, targetReturn: 0.10, targetRisk: 0.20 };
    const optimizer = createOptimizer(model);
    const sharpe = optimizer.solve('sharpe', parameters);
    assert.ok(Math.abs(sharpe.weights[0] - expectedShare) < 0.000005, `Actual M2 share ${sharpe.weights[0]} differs from ${expectedShare}`);
    assert.equal((sharpe.weights[0] * 100).toFixed(2), (expectedShare * 100).toFixed(2));
    assert.ok(sharpe.weights.slice(1).every(weight => weight > 0), 'Each of the other nine indicators participates in the example.');
    const expectedTable = XLSX.utils.sheet_to_json(workbook.Sheets['Ожидаемые веса'], { header: 1 });
    sharpe.weights.forEach((weight, index) => assert.ok(Math.abs(weight - expectedTable[index + 1][1]) < 1e-10));
    const metadata = Object.fromEntries(XLSX.utils.sheet_to_json(workbook.Sheets['Параметры'], { header: 1 }).slice(1));
    assert.equal(metadata['Профиль'], profile);
    assert.equal(metadata['Критерий'], 'sharpe');
    assert.equal(metadata['Номинальная ставка, %'], 8);
    assert.equal(metadata['Периодов в год'], 12);
    assert.equal(metadata['Первый индикатор'], 'm2');
    const markowitz = optimizer.solve('markowitz', parameters);
    assert.ok(Math.abs(markowitz.weights[0] - expectedShare) > 0.01, 'M2 share is obtained through the criterion, not forced for every portfolio.');
    for (const mode of ['markowitz', 'sharpe', 'risk', 'return']) {
      const result = optimizer.solve(mode, parameters);
      const report = metrics(model, result.weights, parameters.rf, 1_000_000);
      assert.ok(result.weights.every(weight => weight >= 0 && Number.isFinite(weight)));
      assert.ok(Math.abs(result.weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-8);
      assert.equal(report.wealth.length, 85);
      assert.ok(Number.isFinite(report.sharpe));
      assert.ok(Number.isFinite(report.maxRecovery));
      if (mode === 'risk') assert.ok(report.expectedReturn >= 0.10 - 1e-8);
      if (mode === 'return') assert.ok(report.risk <= 0.20 + 1e-8);
    }
  });
}
