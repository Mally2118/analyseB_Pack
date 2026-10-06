import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError, monthEnd, validatePeriod } from '../data-providers.mjs';
import { buildMarketSnapshot, refreshSnapshot, stitchMarketChunks, validateSnapshot } from '../market-snapshot.mjs';

const now = new Date('2026-10-06T12:00:00Z');
const index = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
const base = index('2011-01');
function fixture(from, to) {
  const months = validatePeriod(from, to, now);
  const offset = index(from) - base;
  return {
    names: ['Рублёвая масса М2', ...Array.from({ length: 9 }, (_, i) => `Индикатор ${i + 2}`)],
    frequency: 12, demo: false, source: 'ЦБ · Росстат · MOEX ISS', period: { from, to },
    downloadedAt: now.toISOString(),
    rows: months.map((month, i) => ({ date: monthEnd(month), cpi: 100 * 1.005 ** i, values: Array.from({ length: 10 }, (_, j) => (offset + i + 100) * (j + 1)) })),
    provenance: [
      { name: 'ЦБ М2', url: 'https://www.cbr.ru/vfs/statistics/credit_statistics/monetary_agg.xlsx' },
      { name: 'Росстат', url: 'https://www.rosstat.gov.ru/storage/mediabank/ipc_mes.xlsx' },
      { name: 'Мосбиржа', url: 'https://www.moex.com/a2193' }
    ]
  };
}

test('overlapping official chunks keep all observations and compound CPI across independently rebased windows', () => {
  const first = fixture('2011-01', '2021-01');
  const last = fixture('2016-08', '2026-08');
  const snapshot = stitchMarketChunks([last, first], now.toISOString());
  assert.equal(snapshot.rows.length, 188);
  assert.equal(snapshot.rows[0].cpi, 100);
  assert.ok(Math.abs(snapshot.rows.at(-1).cpi - 100 * 1.005 ** 187) < 1e-8);
  assert.equal(snapshot.rows[121].date, '2021-02-28');
  assert.equal(snapshot.rows[121].values[0], 221);
  assert.deepEqual(snapshot.availablePeriod, { from: '2011-01', to: '2026-08' });
  assert.equal(snapshot.demo, false);
  assert.equal(snapshot.delivery, 'github-actions');
});

test('stitching rejects gaps, changed historical values and incompatible inflation paths', () => {
  const first = fixture('2011-01', '2021-01');
  assert.throws(() => stitchMarketChunks([first, fixture('2021-02', '2026-08')]), /не перекрываются/);
  const changedPrice = fixture('2016-08', '2026-08');
  changedPrice.rows[12].values[3] += 1;
  assert.throws(() => stitchMarketChunks([first, changedPrice]), /источники изменились/);
  const changedCPI = fixture('2016-08', '2026-08');
  changedCPI.rows[12].cpi *= 1.01;
  assert.throws(() => stitchMarketChunks([first, changedCPI]), /источники изменились/);
});

test('builder finds the last jointly published month and fetches full history in valid provider windows', async () => {
  const calls = [];
  const snapshot = await buildMarketSnapshot({ now, load: async (from, to) => {
    calls.push([from, to]);
    validatePeriod(from, to, now);
    if (to === '2026-09') throw new ProviderError('M2 not yet published', { code: 'MISSING_DATA', status: 422, missingMonth: '2026-09', latestAvailable: '2026-08' });
    return fixture(from, to);
  } });
  assert.deepEqual(calls, [['2016-09', '2026-09'], ['2016-08', '2026-08'], ['2011-01', '2021-01']]);
  assert.equal(snapshot.period.to, '2026-08');
  assert.equal(snapshot.rows.length, 188);
});

test('builder handles a short history with one provider request', async () => {
  const calls = [];
  const snapshot = await buildMarketSnapshot({ now, firstMonth: '2024-01', load: async (from, to) => {
    calls.push([from, to]);
    return fixture(from, to);
  } });
  assert.deepEqual(calls, [['2024-01', '2026-09']]);
  assert.equal(snapshot.rows.length, 33);
});

test('publication fallback rejects internal historical gaps and publication delays over six months', async () => {
  for (const metadata of [
    { missingMonth: '2020-03', latestAvailable: '2026-08' },
    { missingMonth: '2026-03', latestAvailable: '2026-02' },
    { missingMonth: '2026-09', latestAvailable: 'not-a-month' }
  ]) {
    let calls = 0;
    const original = new ProviderError('Missing data', { code: 'MISSING_DATA', status: 422, ...metadata });
    await assert.rejects(buildMarketSnapshot({ now, load: async () => { calls++; throw original; } }), error => error === original);
    assert.equal(calls, 1);
  }
});

test('snapshot validator rejects demonstration data, unknown sources, duplicate months and invalid measurements', () => {
  const good = stitchMarketChunks([fixture('2024-01', '2025-01')], now.toISOString());
  assert.equal(validateSnapshot(good), good);
  for (const modify of [
    data => { data.demo = true; },
    data => { data.provenance[0].url = 'https://untrusted.example/data.json'; },
    data => { data.rows[1].date = data.rows[0].date; },
    data => { data.rows[1].values[1] = null; },
    data => { data.availablePeriod.to = '2025-02'; },
    data => { data.rows[0].cpi = 101; }
  ]) {
    const invalid = structuredClone(good);
    modify(invalid);
    assert.throws(() => validateSnapshot(invalid), error => error.code === 'INVALID_SNAPSHOT');
  }
});

test('refresh writes a fresh snapshot atomically and leaves no temporary files', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'portfolio-snapshot-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const output = join(folder, 'market-data.json');
  const fresh = stitchMarketChunks([fixture('2024-01', '2025-01')], now.toISOString());
  const result = await refreshSnapshot({ output, build: async () => fresh });
  assert.equal(result.refreshed, true);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), fresh);
  assert.deepEqual(await readdir(folder), ['market-data.json']);
});

test('upstream outage preserves the previous genuine snapshot and its original freshness timestamp', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'portfolio-snapshot-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const output = join(folder, 'market-data.json');
  const previous = stitchMarketChunks([fixture('2024-01', '2025-01')], '2025-02-07T12:00:00.000Z');
  const originalText = JSON.stringify(previous);
  await writeFile(output, originalText);
  const warnings = [];
  const build = async () => { throw new Error('Provider temporarily unavailable'); };
  const result = await refreshSnapshot({ output, build, warn: message => warnings.push(message) });
  assert.equal(result.refreshed, false);
  assert.equal(result.snapshot.downloadedAt, previous.downloadedAt);
  assert.equal(await readFile(output, 'utf8'), originalText);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2025-02-07.*2025-01/);
  await assert.rejects(refreshSnapshot({ output, build, strict: true }), /temporarily unavailable/);
  assert.equal(await readFile(output, 'utf8'), originalText);
});

test('failed refresh cannot silently succeed with absent or fabricated prior data', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'portfolio-snapshot-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const output = join(folder, 'market-data.json');
  const build = async () => { throw new Error('Unavailable'); };
  await assert.rejects(refreshSnapshot({ output, build }), /Unavailable/);
  await writeFile(output, JSON.stringify({ demo: true, rows: [] }));
  await assert.rejects(refreshSnapshot({ output, build }), /Unavailable/);
});

test('separate cache fallback is validated and only replaces an older published snapshot', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'portfolio-snapshot-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const output = join(folder, 'market-data.json'), fallback = join(folder, 'cache.json');
  const old = stitchMarketChunks([fixture('2024-01', '2025-01')], '2025-02-07T12:00:00.000Z');
  const recent = stitchMarketChunks([fixture('2024-01', '2025-03')], '2025-04-07T12:00:00.000Z');
  const build = async () => { throw new Error('Unavailable'); };
  await writeFile(output, JSON.stringify(recent));
  await writeFile(fallback, JSON.stringify(old));
  assert.deepEqual((await refreshSnapshot({ output, fallback, build })).snapshot, recent);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), recent);
  await writeFile(output, JSON.stringify(old));
  await writeFile(fallback, JSON.stringify(recent));
  const result = await refreshSnapshot({ output, fallback, build });
  assert.equal(result.refreshed, false);
  assert.equal(result.snapshot.downloadedAt, recent.downloadedAt);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), recent);
  await writeFile(fallback, JSON.stringify({ ...recent, demo: true }));
  await writeFile(output, JSON.stringify(old));
  assert.deepEqual((await refreshSnapshot({ output, fallback, build })).snapshot, old);
});

test('a shorter terminal period cannot overwrite the last valid history; revised source values at the same period can', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'portfolio-snapshot-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const output = join(folder, 'market-data.json');
  const previous = stitchMarketChunks([fixture('2024-01', '2025-03')], '2025-04-07T12:00:00.000Z');
  await writeFile(output, JSON.stringify(previous));
  const regression = stitchMarketChunks([fixture('2024-01', '2025-02')], '2025-05-07T12:00:00.000Z');
  const result = await refreshSnapshot({ output, build: async () => regression });
  assert.equal(result.refreshed, false);
  assert.deepEqual(result.snapshot, previous);
  const correction = structuredClone(previous);
  correction.rows[5].values[0] += 1;
  correction.downloadedAt = '2025-05-07T12:00:00.000Z';
  assert.equal((await refreshSnapshot({ output, build: async () => correction })).refreshed, true);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), correction);
});
