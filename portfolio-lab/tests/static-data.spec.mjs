import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import XLSX from 'xlsx';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const snapshot = JSON.parse(await readFile(join(dist, 'data/market-data.json'), 'utf8'));
const subset = (from, to) => snapshot.rows.filter(row => row.date.slice(0, 7) >= from && row.date.slice(0, 7) <= to);
async function openTab(page, name) {
  await page.locator('#tab-' + name).click();
  await expect(page.locator('#panel-' + name)).toBeVisible();
}
async function dashboard(page) {
  return page.evaluate(() => ({
    title: document.getElementById('current-title').textContent,
    metrics: ['expected-income', 'expected-rate', 'risk-value', 'drawdown-value', 'recovery-value'].map(id => document.getElementById(id).textContent),
    charts: ['frontier-chart', 'equity-chart', 'weights-chart'].map(id => echarts.getInstanceByDom(document.getElementById(id)).getOption().series.map(series => series.data))
  }));
}
async function download(page, testInfo, filename) {
  const waiting = page.waitForEvent('download');
  await page.locator('#online-excel-button').click();
  const result = await waiting, path = testInfo.outputPath(filename);
  await result.saveAs(path);
  return XLSX.read(await readFile(path), { type: 'buffer' });
}
async function load(page, from = '2020-01', to = '2025-12') {
  await openTab(page, 'data');
  await page.locator('#online-from').fill(from);
  await page.locator('#online-to').fill(to);
  await page.locator('#online-load-button').click();
  await expect(page.locator('#online-load-button')).toBeEnabled();
  await expect(page.locator('#online-status')).not.toHaveClass(/error/);
  await expect(page.locator('#data-badge')).toHaveText('Официальные данные');
}

test('a static host loads official statistics without a backend and supports Excel, all optimization criteria and validation', async ({ page }, testInfo) => {
  const errors = [], apiCalls = [], snapshotCalls = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/market-data**', route => { apiCalls.push(route.request().url()); return route.fulfill({ status: 404, contentType: 'text/html', body: '<html>Static host</html>' }); });
  await page.route('**/data/market-data.json', route => { snapshotCalls.push(route.request().url()); return route.fulfill({ path: join(dist, 'data/market-data.json') }); });
  await page.goto('/');
  await expect(page.locator('#equity-chart svg')).toBeVisible();
  await load(page);
  const expected = subset('2020-01', '2025-12');
  expect(expected).toHaveLength(72);
  expect(apiCalls).toHaveLength(1);
  expect(snapshotCalls).toHaveLength(1);
  await expect(page.locator('#online-status')).toContainText('72');
  await expect(page.locator('#online-availability')).toContainText(snapshot.availablePeriod.from);
  await expect(page.locator('#online-availability')).toContainText(snapshot.availablePeriod.to);
  await expect(page.locator('#online-availability')).toContainText('ежедневно');
  await expect(page.locator('#online-provenance')).toContainText('Подготовленная официальная статистика');
  await expect(page.locator('#online-provenance a[href^="https://www.cbr.ru/"]')).toHaveCount(2);
  await expect(page.locator('#online-provenance a[href^="https://www.rosstat.gov.ru/"]')).toHaveCount(1);
  await expect(page.locator('#online-provenance a[href^="https://www.moex.com/"]')).toHaveCount(1);
  const workbook = await download(page, testInfo, 'static-official-data.xlsx');
  expect(workbook.SheetNames).toEqual(['Данные', 'Источники']);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Данные'], { header: 1 });
  expect(rows).toHaveLength(73);
  expect(rows[0]).toEqual(['Дата', 'ИПЦ', ...snapshot.names]);
  expect(rows[1]).toEqual([expected[0].date, 100, ...expected[0].values]);
  expect(rows.at(-1)[0]).toBe('2025-12-31');
  expect(rows.at(-1)[1]).toBeCloseTo(expected.at(-1).cpi / expected[0].cpi * 100, 10);
  const sources = XLSX.utils.sheet_to_json(workbook.Sheets['Источники'], { header: 1 });
  expect(sources.find(row => row[0] === 'Скачано')[1]).toBe(snapshot.downloadedAt);
  expect(sources.find(row => row[0] === 'Первый месяц')[1]).toBe('2020-01');
  expect(sources.find(row => row[0] === 'Последний месяц')[1]).toBe('2025-12');
  await openTab(page, 'comparison');
  await page.locator('#compare-target-return').fill('8');
  await page.locator('#compare-all-button').click();
  await expect(page.locator('#comparison-cards .portfolio-chip')).toHaveCount(4);
  await openTab(page, 'backtest');
  await page.locator('#backtest-target-return').fill('8');
  await page.locator('#backtest-run-button').click();
  await expect(page.locator('#backtest-run-button')).toBeEnabled();
  await expect(page.locator('#backtest-table tbody tr')).toHaveCount(5);
  for (const id of ['backtest-return-chart', 'backtest-drawdown-chart', 'backtest-weights-chart']) await expect(page.locator('#' + id + ' svg')).toBeVisible();
  expect(errors).toEqual([]);
});

test('GitHub Pages prefetches availability, keeps chosen dates, and reuses the snapshot across language changes and periods', async ({ page }, testInfo) => {
  let snapshotCalls = 0, apiCalls = 0;
  const errors = [], host = 'https://static-data-test.github.io/analyseB_Pack/';
  page.on('pageerror', error => errors.push(error.message));
  await page.route(host + '**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/analyseB_Pack/', '') || 'index.html';
    if (path.startsWith('api/')) { apiCalls++; return route.fulfill({ status: 404, body: 'No backend' }); }
    if (path === 'data/market-data.json') snapshotCalls++;
    return route.fulfill({ path: join(dist, path) });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(host);
  await expect(page.locator('#equity-chart svg')).toBeVisible();
  await openTab(page, 'data');
  await expect(page.locator('#online-availability')).toContainText(snapshot.availablePeriod.to);
  await expect(page.locator('#online-from')).toHaveAttribute('min', snapshot.availablePeriod.from);
  await expect(page.locator('#online-to')).toHaveAttribute('max', snapshot.availablePeriod.to);
  await expect(page.locator('#online-from')).toHaveValue('2020-01');
  await expect(page.locator('#online-to')).toHaveValue('2025-12');
  await load(page);
  expect(snapshotCalls).toBe(1);
  expect(apiCalls).toBe(0);
  await page.locator('#language-button').click();
  await expect(page.locator('#online-availability')).toContainText('checked daily');
  await expect(page.locator('#online-provenance')).toContainText('Prepared official statistics');
  await expect(page.locator('#online-status')).toContainText('Loaded 72 observations');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('#language-button').click();
  await load(page, '2025-08', '2026-08');
  await expect(page.locator('#online-status')).toContainText('13');
  const workbook = await download(page, testInfo, 'latest-published-year.xlsx');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Данные'], { header: 1 });
  expect(rows).toHaveLength(14);
  expect(rows[1][0]).toBe('2025-08-31');
  expect(rows[1][1]).toBe(100);
  expect(rows.at(-1)[0]).toBe('2026-08-31');
  expect(snapshotCalls).toBe(1);
  expect(apiCalls).toBe(0);
  expect(errors).toEqual([]);
});

test('a failed refreshed snapshot preserves the last successfully loaded data, provenance and validation results', async ({ page }) => {
  let corrupt = false, calls = 0;
  await page.route('**/api/market-data**', route => route.fulfill({ status: 404, contentType: 'text/html', body: 'Static host' }));
  await page.route('**/data/market-data.json', route => {
    calls++;
    return corrupt ? route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid}' }) : route.fulfill({ path: join(dist, 'data/market-data.json') });
  });
  await page.goto('/'); await expect(page.locator('#equity-chart svg')).toBeVisible();
  await load(page);
  await openTab(page, 'backtest');
  await page.locator('#backtest-target-return').fill('8');
  await page.locator('#backtest-run-button').click();
  await expect(page.locator('#backtest-run-button')).toBeEnabled();
  await expect(page.locator('#backtest-table tbody tr')).toHaveCount(5);
  const previous = await dashboard(page), validation = await page.locator('#backtest-table tbody').textContent();
  await openTab(page, 'data');
  const provenance = await page.locator('#online-provenance').textContent(), info = await page.locator('#data-info').textContent();
  // Advance the cache clock so this submission attempts to read the refreshed file.
  await page.evaluate(() => { const clock = Date.now; Date.now = () => clock() + 6 * 60 * 1000; });
  corrupt = true;
  await page.locator('#online-load-button').click();
  await expect(page.locator('#online-status')).toHaveClass(/error/);
  await expect(page.locator('#online-status')).toContainText('Подготовленная статистика повреждена');
  await expect(page.locator('#online-load-button')).toBeEnabled();
  await expect(page.locator('#online-excel-button')).toBeEnabled();
  await expect(page.locator('#online-provenance')).toHaveText(provenance);
  await expect(page.locator('#data-info')).toHaveText(info);
  expect(await dashboard(page)).toEqual(previous);
  expect(calls).toBe(2);
  await openTab(page, 'backtest');
  await expect(page.locator('#backtest-table tbody')).toHaveText(validation);
  await expect(page.locator('#backtest-export-button')).toBeEnabled();
});
