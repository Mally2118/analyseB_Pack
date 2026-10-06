import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSnapshotPeriod, readOfficialSnapshot, loadOfficialMarketData, isStaticDataHost } from '../dist/market-data-client.js';

const now = new Date('2026-10-06T12:00:00Z');
const baseURL = 'https://mally2118.github.io/analyseB_Pack/';
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
function fixture() {
  const rows = Array.from({ length: 26 }, (_, i) => ({
    date: new Date(Date.UTC(2019 + Math.floor(i / 12), i % 12 + 1, 0)).toISOString().slice(0, 10),
    cpi: 100 * 1.004 ** i,
    values: Array.from({ length: 10 }, (_, j) => (1000 + j * 75) * (1.008 + j / 1000) ** i)
  }));
  return {
    schemaVersion: 1, delivery: 'github-actions', frequency: 12, demo: false,
    names: ['Рублёвая масса М2', ...Array.from({ length: 9 }, (_, i) => 'Индикатор ' + (i + 2))],
    rows, source: 'ЦБ · Росстат · MOEX ISS',
    period: { from: '2019-01', to: '2021-02' }, availablePeriod: { from: '2019-01', to: '2021-02' },
    downloadedAt: '2026-10-06T10:00:00.000Z',
    provenance: [
      { name: 'Банк России', url: 'https://www.cbr.ru/development/sxml/' },
      { name: 'Росстат', url: 'https://www.rosstat.gov.ru/statistics/price' },
      { name: 'Московская биржа', url: 'https://iss.moex.com/iss/' }
    ], notes: ['Test fixture; not official observations.']
  };
}
const requested = ['2019-12', '2020-12'];
const select = snapshot => selectSnapshotPeriod(snapshot, ...requested, { now });

test('snapshot selection rebases inflation without changing real returns or mutating the stored observations', () => {
  const original = fixture(), before = structuredClone(original), selected = select(original);
  assert.equal(selected.rows.length, 13);
  assert.equal(selected.rows[0].date, '2019-12-31');
  assert.equal(selected.rows.at(-1).date, '2020-12-31');
  assert.equal(selected.rows[0].cpi, 100);
  assert.deepEqual(selected.period, { from: requested[0], to: requested[1] });
  assert.deepEqual(selected.availablePeriod, original.availablePeriod);
  assert.equal(selected.downloadedAt, original.downloadedAt);
  assert.equal(selected.delivery, 'github-actions');
  for (let i = 1; i < selected.rows.length; i++) {
    const previous = original.rows[i + 10], current = original.rows[i + 11];
    for (let j = 0; j < 10; j++) {
      const realReturn = current.values[j] / previous.values[j] / (current.cpi / previous.cpi) - 1;
      const slicedReturn = selected.rows[i].values[j] / selected.rows[i - 1].values[j] / (selected.rows[i].cpi / selected.rows[i - 1].cpi) - 1;
      assert.ok(Math.abs(realReturn - slicedReturn) < 1e-12);
    }
  }
  selected.rows[0].values[0] = -1;
  selected.names[0] = 'Changed';
  selected.availablePeriod.from = '1900-01';
  assert.deepEqual(original, before);
});

test('invalid requested periods reject before fetching and unavailable periods explain the published bounds', async () => {
  for (const dates of [['2024-1','2025-01'],['2024-13','2025-01'],['2024-01','2024-12'],['2015-01','2026-01'],['2010-12','2011-12'],['2025-01','2026-10'],['2025-01','2024-01']]) {
    assert.throws(() => selectSnapshotPeriod(fixture(), ...dates, { now }));
    let calls = 0;
    await assert.rejects(loadOfficialMarketData(...dates, { now, baseURL, fetchImpl: async () => { calls++; return json(fixture()); } }));
    assert.equal(calls, 0);
  }
  assert.throws(() => selectSnapshotPeriod(fixture(), '2020-03', '2021-03', { now }), error =>
    error.code === 'PERIOD_UNAVAILABLE' && error.message.includes('2019-01') && error.message.includes('2021-02') && error.availablePeriod.to === '2021-02');
});

test('snapshot rejects gaps, duplicated dates, invalid month ends, malformed numeric values and mismatched metadata', () => {
  const corruptions = [
    data => data.rows.splice(7, 1),
    data => { data.rows[7].date = data.rows[6].date; },
    data => { data.rows[13].date = '2020-02-30'; },
    data => { data.rows[13].date = '2020-02-28'; },
    data => { data.rows[13].values[5] = NaN; },
    data => { data.rows[13].values[5] = Infinity; },
    data => { data.rows[13].values[5] = '100'; },
    data => { data.rows[13].values[5] = 0; },
    data => { data.rows[13].values.push(10); },
    data => { data.rows[13].cpi = -1; },
    data => { data.names[1] = data.names[0]; },
    data => { data.names.pop(); },
    data => { data.availablePeriod.to = '2021-03'; },
    data => { data.period.from = '2019-02'; },
    data => { data.schemaVersion = 2; },
    data => { data.delivery = 'direct-api'; },
    data => { data.demo = true; },
    data => { data.frequency = 252; },
    data => { data.downloadedAt = 'not a date'; },
    data => { data.provenance = []; },
    data => { data.provenance[0].url = 'https://cbr.ru.evil.example/'; },
    data => { data.provenance[0].url = 'http://www.cbr.ru/'; }
  ];
  for (const corrupt of corruptions) {
    const data = fixture(); corrupt(data);
    assert.throws(() => select(data), /Подготовленная статистика повреждена/);
  }
});

test('GitHub Pages uses the repository subdirectory and reuses the metadata prefetch for period selection', async () => {
  const calls = [], fetchImpl = async (url, options) => { calls.push({ url, options }); return json(fixture()); };
  const snapshot = await readOfficialSnapshot({ fetchImpl, baseURL });
  const selected = await loadOfficialMarketData(...requested, { fetchImpl, baseURL, now });
  assert.equal(snapshot.rows.length, 26);
  assert.equal(selected.rows.length, 13);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, baseURL + 'data/market-data.json');
  assert.equal(calls[0].options.cache, 'no-cache');
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(isStaticDataHost(baseURL), true);
  assert.equal(isStaticDataHost('https://github.io/example/'), true);
  assert.equal(isStaticDataHost('https://github.io.example.com/'), false);
  assert.equal(isStaticDataHost('http://localhost:4173/'), false);
});

test('concurrent snapshot requests share a successful read, explicit refresh bypasses cache, and failed reads are retryable', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return json(fixture()); };
  await Promise.all([readOfficialSnapshot({ fetchImpl, baseURL }), readOfficialSnapshot({ fetchImpl, baseURL })]);
  assert.equal(calls, 1);
  await readOfficialSnapshot({ fetchImpl, baseURL, useCache: false });
  assert.equal(calls, 2);
  let attempts = 0;
  const flaky = async () => ++attempts === 1 ? new Response('missing', { status: 404 }) : json(fixture());
  await assert.rejects(readOfficialSnapshot({ fetchImpl: flaky, baseURL }), /Не удалось загрузить подготовленную статистику/);
  assert.equal((await readOfficialSnapshot({ fetchImpl: flaky, baseURL })).rows.length, 26);
  assert.equal(attempts, 2);
});

test('a localhost Node API remains the first choice and validates the exact requested monthly response', async () => {
  const calls = [], payload = select(fixture());
  delete payload.schemaVersion; delete payload.delivery;
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return json(payload); };
  const selected = await loadOfficialMarketData(...requested, { fetchImpl, baseURL: 'http://127.0.0.1:4173/', now });
  assert.equal(selected.delivery, 'direct-api');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/market-data');
  assert.equal(url.searchParams.get('from'), requested[0]);
  assert.equal(url.searchParams.get('to'), requested[1]);
  assert.equal(calls[0].options.signal.aborted, false);
  const wrong = { ...payload, period: { from: '2019-01', to: '2020-01' } };
  await assert.rejects(loadOfficialMarketData(...requested, { fetchImpl: async () => json(wrong), baseURL: 'http://localhost:4173/', now }), /Источник вернул некорректные данные/);
});

test('ordinary static hosts fall back from API 404, 405 and HTML responses to their same-origin JSON snapshot', async () => {
  for (const makeResponse of [() => new Response('missing', { status: 404 }), () => json({ error: 'method' }, 405), () => new Response('<html>Static host</html>', { headers: { 'content-type': 'text/html' } })]) {
    const calls = [], staticURL = 'https://example.com/analysis/index.html';
    const fetchImpl = async url => { calls.push(url); return url.includes('/api/') ? makeResponse() : json(fixture()); };
    const selected = await loadOfficialMarketData(...requested, { fetchImpl, baseURL: staticURL, now });
    assert.equal(selected.delivery, 'github-actions');
    assert.equal(calls.length, 2);
    assert.equal(calls[1], 'https://example.com/analysis/data/market-data.json');
  }
});

test('API period and provider failures never fall back to static data and preserve their error details', async () => {
  for (const status of [400, 422, 500, 502]) {
    const calls = [];
    const fetchImpl = async url => { calls.push(url); return json({ error: 'Нет наблюдений за выбранный месяц.', code: 'MISSING_DATA', latestAvailable: '2025-12' }, status); };
    await assert.rejects(loadOfficialMarketData(...requested, { fetchImpl, baseURL: 'http://localhost:4173/', now }), error =>
      error.status === status && error.code === 'MISSING_DATA' && error.latestAvailable === '2025-12' && error.message.includes('Нет наблюдений'));
    assert.equal(calls.length, 1);
  }
  for (const status of [400, 422]) {
    let calls = 0;
    await assert.rejects(loadOfficialMarketData(...requested, { fetchImpl: async () => { calls++; return new Response('Invalid', { status }); }, baseURL: 'https://example.com/', now }));
    assert.equal(calls, 1);
  }
});

test('snapshot HTTP, network, format and size failures reject without substituting synthetic observations', async () => {
  const fetchers = [
    async () => new Response('Unavailable', { status: 503 }),
    async () => { throw new TypeError('Network unavailable'); },
    async () => new Response('<html>not JSON</html>', { headers: { 'content-type': 'text/html' } }),
    async () => new Response('{invalid}', { headers: { 'content-type': 'application/json' } }),
    async () => new Response(JSON.stringify(fixture()), { headers: { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) } }),
    async () => json({ ...fixture(), demo: true })
  ];
  for (const fetchImpl of fetchers) await assert.rejects(loadOfficialMarketData(...requested, { fetchImpl, baseURL, now }));
});
