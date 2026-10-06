import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import XLSX from 'xlsx';
import { estimate } from '../dist/engine.js';
import {
  validatePeriod, monthEnd, parseCurrencyXML, parseMetalXML, monthlyLast,
  parseMoneyTable, parseCPITable, discoverCPIURL, parseMOEXCandles,
  assembleMarketData, loadMarketData
} from '../data-providers.mjs';

const now = new Date('2026-10-06T12:00:00Z');
const months = validatePeriod('2024-01', '2025-01', now);
const monthsRU = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const serial = date => (new Date(date + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000;
const nextStart = month => {
  const d = new Date(month + '-01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};
const moneyTable = [
  ['Денежные агрегаты*, млрд руб.', ...months.map(m => serial(nextStart(m)))],
  ['Денежный агрегат М0', ...months.map(() => 400)],
  ['Денежный агрегат М2', ...months.map((_, i) => 1000 + i * 30)],
  ['Денежный агрегат M2X\n(широкая денежная масса)', ...months.map(() => 5000)]
];
const cpiTable = [
  ['Индексы потребительских цен'], [null, 2024, 2025], ['к концу предыдущего месяца'],
  ...monthsRU.map((m, i) => [m, 100 + (i + 1) / 10, i === 0 ? 101.4 : null]),
  ['к декабрю предыдущего года'], ['декабрь', 108, '101,42)']
];

function workbook(table, name) {
  const w = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(table), name);
  return XLSX.write(w, { type: 'buffer', bookType: 'xlsx' });
}

const currencyXML = '<ValCurs>' + months.map((m, i) => `<Record Date="${monthEnd(m).split('-').reverse().join('.')}"><Nominal>10</Nominal><Value>${1000 + i * 8},00</Value></Record>`).join('') + '</ValCurs>';
const metalXML = '<Metall>' + months.map((m, i) => ['1','2','3','4'].map(code => `<Record Date="${monthEnd(m).split('-').reverse().join('.')}" Code="${code}"><Buy>${100 + i + Number(code)},50</Buy><Sell>${150 + i}</Sell></Record>`).join('')).join('') + '</Metall>';
const candles = { candles: { columns: ['close', 'end', 'begin'], data: months.map((m, i) => [200 + i * 4, `${monthEnd(m)} 00:00:00`, `${m}-01 00:00:00`]) } };

function fixtureFetch(overrides = {}) {
  const requested = [];
  const fake = async url => {
    requested.push(url);
    if (overrides.status) return new Response('Unavailable', { status: overrides.status });
    if (url.includes('/monetary_agg.xlsx')) return new Response(workbook(moneyTable, 'Денежные агрегаты'));
    if (url.endsWith('/statistics/price')) return new Response('<a href="/storage/mediabank/ipc_mes_01-2025.xlsx">Monthly CPI</a>');
    if (url.includes('/ipc_mes_')) return new Response(workbook(cpiTable, '01'));
    if (url.includes('/xml_metall.asp')) return new Response(metalXML);
    if (url.includes('/XML_dynamic.asp')) return new Response(currencyXML);
    if (url.includes('/candles.json')) return new Response(JSON.stringify(candles));
    throw new Error(`Unexpected URL ${url}`);
  };
  return { fake, requested };
}

test('market data periods require 13 to 121 complete months and reject malformed or future dates', () => {
  assert.equal(months.length, 13);
  assert.equal(monthEnd('2024-02'), '2024-02-29');
  assert.equal(validatePeriod('2016-01', '2026-01', now).length, 121);
  for (const [from, to] of [['2024-13','2025-01'], ['2024-1','2025-01'], ['2024-01','2024-12'], ['2010-12','2025-12'], ['2015-01','2026-01'], ['2024-01','2026-10'], ['2025-01','2024-01'], [null,'2025-01']]) {
    assert.throws(() => validatePeriod(from, to, now), error => error.status === 400 && error.code === 'INVALID_PERIOD');
  }
});

test('CBR currency parser normalizes the currency nominal and selects the last date without requiring sorted input', () => {
  const parsed = parseCurrencyXML('<ValCurs><Record Date="30.01.2024"><Nominal>10</Nominal><Value>920,50</Value></Record><Record Date="29.01.2024"><Nominal>10</Nominal><Value>900,00</Value></Record></ValCurs>');
  assert.equal(parsed[0].value, 92.05);
  assert.equal(monthlyLast(parsed).get('2024-01').date, '2024-01-30');
  assert.throws(() => parseCurrencyXML('<html>maintenance</html>'), /другой ответ/);
  assert.throws(() => parseCurrencyXML('<ValCurs><Record Date="31.02.2024"><Nominal>1</Nominal><Value>90</Value></Record></ValCurs>'), /некорректная дата/);
  assert.throws(() => parseCurrencyXML('<ValCurs><Record Date="01.01.2024"><Nominal>0</Nominal><Value>90</Value></Record></ValCurs>'), /некорректное значение/);
});

test('CBR metal parser retains all four official metal codes and never substitutes missing metal data', () => {
  const parsed = parseMetalXML(metalXML);
  assert.equal(parsed.size, 4);
  assert.equal(parsed.get('1')[0].value, 101.5);
  assert.throws(() => parseMetalXML('<Metall><Record Date="31.01.2024" Code="1"><Buy>100</Buy></Record></Metall>'), /одного из металлов/);
});

test('M2 monthly balance uses the following first day and selects M2 rather than M0 or M2X', () => {
  const parsed = parseMoneyTable(moneyTable);
  assert.equal(parsed.size, 13);
  assert.deepEqual(parsed.get('2024-01'), {date:'2024-01-31',value:1000,publishedDate:'2024-02-01'});
  assert.equal(parsed.get('2025-01').value, 1360);
  assert.throws(() => parseMoneyTable(moneyTable.filter(row => row[0] !== 'Денежный агрегат М2')), /не найдена строка/);
});

test('Rosstat CPI parser chooses previous-month rates, ignores annual totals and missing future publications', () => {
  const parsed = parseCPITable(cpiTable);
  assert.equal(parsed.size, 13);
  assert.equal(parsed.get('2024-01'), 1.001);
  assert.equal(parsed.get('2024-12'), 1.012);
  assert.equal(parsed.get('2025-01'), 1.014);
  assert.equal(parsed.has('2025-02'), false);
  assert.equal(discoverCPIURL('<a href="/storage/mediabank/ipc_mes_01-2025.xlsx">CPI</a>'), 'https://www.rosstat.gov.ru/storage/mediabank/ipc_mes_01-2025.xlsx');
  assert.throws(() => discoverCPIURL('<a href="https://untrusted.example/storage/mediabank/ipc_mes.xlsx">CPI</a>'), /неожиданная ссылка/);
});

test('MOEX parser follows column names and rejects missing values rather than filling a gap', () => {
  const parsed = parseMOEXCandles(candles, 'IMOEX');
  assert.equal(parsed.get('2024-02').value, 204);
  assert.equal(parsed.get('2024-02').date, '2024-02-29');
  const nullable = structuredClone(candles);
  nullable.candles.data[2][0] = null;
  assert.equal(parseMOEXCandles(nullable).has('2024-03'), false);
  assert.throws(() => parseMOEXCandles({history:{columns:[],data:[]}}), /неизвестный формат/);
});

test('data assembly compounds CPI correctly across the year boundary and rejects missing months', () => {
  const map = parseMOEXCandles(candles), money = parseMoneyTable(moneyTable), rates = parseCPITable(cpiTable);
  const series = Array.from({length:9}, (_, i) => ({name:`Indicator ${i+2}`, values:map}));
  const data = assembleMarketData(months, money, rates, series, 'https://www.rosstat.gov.ru/storage/mediabank/ipc_mes.xlsx');
  assert.equal(data.rows[0].cpi, 100);
  assert.equal(data.rows[1].cpi, 100.2);
  assert.ok(Math.abs(data.rows.at(-1).cpi / data.rows.at(-2).cpi - 1.014) < 1e-12);
  const model = estimate(data, 12, false);
  assert.ok(Math.abs(model.returns[0][0] - ((1030/1000)/1.002-1)) < 1e-12);
  assert.equal(data.demo, false);
  assert.equal(data.names.length, 10);
  assert.equal(data.provenance.length, 4);
  map.delete('2024-04');
  assert.throws(() => assembleMarketData(months, money, rates, series, 'CPI'), error => error.status === 422 && error.message.includes('2024-04') && error.latestAvailable === '2025-01');
});

test('provider orchestrates only official sources and returns a complete engine-compatible data set', async () => {
  const {fake,requested} = fixtureFetch();
  const data = await loadMarketData('2024-01','2025-01',{fetchImpl:fake,now,useCache:false});
  assert.equal(requested.length, 9);
  assert.ok(requested.every(url => ['www.cbr.ru','www.rosstat.gov.ru','iss.moex.com'].includes(new URL(url).hostname)));
  assert.equal(data.rows.length, 13);
  assert.equal(data.rows[0].values[0], 1000);
  assert.equal(data.rows[0].values[5], 100);
  assert.equal(data.rows[0].values[8], 200);
  assert.equal(data.names[0], 'Рублёвая масса М2');
  assert.equal(estimate(data,12).returns.length, 12);
});

test('upstream failure is explicit, and invalid periods make no network requests', async () => {
  const {fake,requested} = fixtureFetch({status:503});
  await assert.rejects(loadMarketData('2024-01','2025-01',{fetchImpl:fake,now,useCache:false}), error => {
    assert.equal(error.cause.message, 'HTTP 503');
    assert.equal(Object.keys(error).includes('cause'), false);
    assert.equal(JSON.stringify(error).includes('stack'), false);
    return error.status === 502 && error.code === 'SOURCE_UNAVAILABLE' && error.message.includes('HTTP 503');
  });
  const clean = fixtureFetch();
  await assert.rejects(loadMarketData('2024-12','2025-01',{fetchImpl:clean.fake,now,useCache:false}), error => error.status === 400);
  assert.equal(clean.requested.length, 0);
});

test('transient network failures recover after two retries using one shared request deadline', async () => {
  const { fake } = fixtureFetch();
  let attempts = 0;
  const signals = [];
  const fetchImpl = async (url, options) => {
    if (url.includes('/IMOEX/')) {
      attempts++;
      signals.push(options.signal);
      if (attempts < 3) throw new TypeError('fetch failed', { cause: Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }) });
    }
    return fake(url);
  };
  const data = await loadMarketData('2024-01', '2025-01', { fetchImpl, now, useCache: false });
  assert.equal(attempts, 3);
  assert.equal(data.rows.length, 13);
  assert.equal(new Set(signals).size, 1);
  assert.ok(signals[0] instanceof AbortSignal);
});

test('temporary HTTP rate limits and unavailable source responses are retried', async () => {
  const { fake } = fixtureFetch();
  let attempts = 0;
  const fetchImpl = async url => {
    if (url.includes('/IMOEX/')) {
      attempts++;
      if (attempts < 3) return new Response('Temporarily unavailable', { status: attempts === 1 ? 429 : 503 });
    }
    return fake(url);
  };
  assert.equal((await loadMarketData('2024-01', '2025-01', { fetchImpl, now, useCache: false })).rows.length, 13);
  assert.equal(attempts, 3);
});

test('certificate verification failures are fatal and never retried', async () => {
  const { fake } = fixtureFetch();
  let attempts = 0;
  const original = new TypeError('fetch failed', { cause: Object.assign(new Error('Unable to verify certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
  const fetchImpl = async url => {
    if (url.includes('/IMOEX/')) { attempts++; throw original; }
    return fake(url);
  };
  await assert.rejects(loadMarketData('2024-01', '2025-01', { fetchImpl, now, useCache: false }), error => error.code === 'SOURCE_UNAVAILABLE' && error.cause === original);
  assert.equal(attempts, 1);
});

test('exhausted transient retries preserve the final network cause and stop after three attempts', async () => {
  const { fake } = fixtureFetch();
  let attempts = 0, latest;
  const fetchImpl = async url => {
    if (url.includes('/IMOEX/')) {
      attempts++;
      latest = new TypeError('fetch failed', { cause: Object.assign(new Error(`Connection reset ${attempts}`), { code: 'ECONNRESET' }) });
      throw latest;
    }
    return fake(url);
  };
  await assert.rejects(loadMarketData('2024-01', '2025-01', { fetchImpl, now, useCache: false }), error => error.code === 'SOURCE_UNAVAILABLE' && error.cause === latest && error.cause.cause.code === 'ECONNRESET');
  assert.equal(attempts, 3);
});

test('malformed source payloads are rejected without network retries', async () => {
  const { fake } = fixtureFetch();
  let attempts = 0;
  const fetchImpl = async url => {
    if (url.includes('/IMOEX/')) { attempts++; return new Response(JSON.stringify({ invalid: true })); }
    return fake(url);
  };
  await assert.rejects(loadMarketData('2024-01', '2025-01', { fetchImpl, now, useCache: false }), error => error.code === 'INVALID_SOURCE_DATA');
  assert.equal(attempts, 1);
});

test('server exposes validation errors as JSON and keeps the static download route', async t => {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: {...process.env, PORT:'0'}, stdio:['ignore','pipe','pipe'] });
  t.after(() => child.kill());
  const output = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => {throw Error('Server exited before starting');})]);
  const port = /:(\d+)/.exec(output[0].toString())[1];
  const response = await fetch(`http://127.0.0.1:${port}/api/market-data?from=2025-01&to=2025-02`);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await response.json()).code, 'INVALID_PERIOD');
  const post = await fetch(`http://127.0.0.1:${port}/api/market-data`, {method:'POST'});
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
  const file = await fetch(`http://127.0.0.1:${port}/examples/portfolio-example.xlsx`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type'), /spreadsheetml/);
});
