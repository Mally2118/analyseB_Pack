import XLSX from './server-xlsx.mjs';

const CBR = 'https://www.cbr.ru';
const ROSSTAT = 'https://www.rosstat.gov.ru';
const MOEX = 'https://iss.moex.com';
const MONEY_URL = `${CBR}/vfs/statistics/credit_statistics/monetary_agg.xlsx`;
const CPI_PAGE = `${ROSSTAT}/statistics/price`;
const TTL = 6 * 60 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024;
const sourceCache = new Map();
const periodCache = new Map();

export class ProviderError extends Error {
  constructor(message, { status = 502, code = 'SOURCE_UNAVAILABLE', latestAvailable, missingMonth } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.latestAvailable = latestAvailable;
    this.missingMonth = missingMonth;
  }
}

const monthIndex = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const monthName = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
export const monthEnd = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

export function validatePeriod(from, to, now = new Date()) {
  if (![from, to].every(v => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v))) {
    throw new ProviderError('Укажите начало и конец периода в формате ГГГГ-ММ.', { status: 400, code: 'INVALID_PERIOD' });
  }
  const first = monthIndex(from), last = monthIndex(to);
  const closed = now.getUTCFullYear() * 12 + now.getUTCMonth() - 1;
  if (first < monthIndex('2011-01') || last > closed) {
    throw new ProviderError('Выберите полностью завершённые месяцы, начиная с января 2011 года.', { status: 400, code: 'INVALID_PERIOD' });
  }
  const count = last - first + 1;
  if (count < 13 || count > 121) {
    throw new ProviderError('Выберите от 13 до 121 месяца: от года до десяти лет доходностей.', { status: 400, code: 'INVALID_PERIOD' });
  }
  return Array.from({ length: count }, (_, i) => monthName(first + i));
}

function positive(value, label) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) throw new ProviderError(`${label}: источник вернул некорректное значение.`, { code: 'INVALID_SOURCE_DATA' });
  return n;
}

function xmlDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!match) throw new ProviderError('ЦБ: неизвестный формат даты.', { code: 'INVALID_SOURCE_DATA' });
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  if (new Date(iso).toISOString().slice(0, 10) !== iso) throw new ProviderError('ЦБ: некорректная дата.', { code: 'INVALID_SOURCE_DATA' });
  return iso;
}

export function parseCurrencyXML(xml) {
  if (!/<ValCurs\b/.test(xml)) throw new ProviderError('ЦБ: вместо валютных котировок получен другой ответ.', { code: 'INVALID_SOURCE_DATA' });
  const records = [];
  for (const match of xml.matchAll(/<Record\b([^>]*)>([\s\S]*?)<\/Record>/g)) {
    const date = /\bDate="([^"]+)"/.exec(match[1]);
    const nominal = /<Nominal>([^<]+)<\/Nominal>/.exec(match[2]);
    const value = /<Value>([^<]+)<\/Value>/.exec(match[2]);
    if (!date || !nominal || !value) throw new ProviderError('ЦБ: неполная валютная запись.', { code: 'INVALID_SOURCE_DATA' });
    records.push({ date: xmlDate(date[1]), value: positive(value[1], 'Курс ЦБ') / positive(nominal[1], 'Номинал валюты') });
  }
  if (!records.length) throw new ProviderError('ЦБ: валютные котировки за период отсутствуют.', { code: 'MISSING_DATA' });
  return records;
}

export function parseMetalXML(xml) {
  if (!/<Metall\b/.test(xml)) throw new ProviderError('ЦБ: вместо цен металлов получен другой ответ.', { code: 'INVALID_SOURCE_DATA' });
  const records = new Map(['1', '2', '3', '4'].map(code => [code, []]));
  for (const match of xml.matchAll(/<Record\b([^>]*)>([\s\S]*?)<\/Record>/g)) {
    const date = /\bDate="([^"]+)"/.exec(match[1]);
    const code = /\bCode="([^"]+)"/.exec(match[1]);
    const price = /<Buy>([^<]+)<\/Buy>/.exec(match[2]);
    if (!date || !code || !price) throw new ProviderError('ЦБ: неполная запись цены металла.', { code: 'INVALID_SOURCE_DATA' });
    if (records.has(code[1])) records.get(code[1]).push({ date: xmlDate(date[1]), value: positive(price[1], 'Цена металла ЦБ') });
  }
  if ([...records.values()].some(rows => !rows.length)) throw new ProviderError('ЦБ: цены одного из металлов за период отсутствуют.', { code: 'MISSING_DATA' });
  return records;
}

export function monthlyLast(records) {
  const result = new Map();
  for (const row of records) {
    const month = row.date.slice(0, 7), previous = result.get(month);
    if (!previous || row.date > previous.date) result.set(month, { ...row, value: positive(row.value, 'Котировка') });
  }
  return result;
}

function excelISO(value) {
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{2}\.\d{2}\.\d{4}$/.test(value.trim())) return xmlDate(value.trim());
  return null;
}

export function parseMoneyTable(table) {
  const dateRow = table.find(row => row.slice(1).filter(value => excelISO(value)?.endsWith('-01')).length >= 13);
  const valueRow = table.find(row => /^Денежный агрегат\s+[МM]2\s*$/.test(String(row[0] ?? '').trim()));
  if (!dateRow || !valueRow) throw new ProviderError('ЦБ: не найдена строка денежной массы М2.', { code: 'INVALID_SOURCE_DATA' });
  const result = new Map();
  for (let i = 1; i < dateRow.length; i++) {
    const publishedDate = excelISO(dateRow[i]);
    if (!publishedDate || !publishedDate.endsWith('-01') || valueRow[i] == null) continue;
    // The balance on the first day of the following month is the level at this month's end.
    const month = monthName(monthIndex(publishedDate.slice(0, 7)) - 1);
    result.set(month, { date: monthEnd(month), value: positive(valueRow[i], 'М2 ЦБ'), publishedDate });
  }
  if (!result.size) throw new ProviderError('ЦБ: временной ряд М2 пуст.', { code: 'INVALID_SOURCE_DATA' });
  return result;
}

const monthLabels = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export function parseCPITable(table) {
  const yearRow = table.find(row => row.filter(value => Number.isInteger(value) && value >= 1991 && value <= 2100).length >= 2);
  const start = table.findIndex(row => /к концу предыдущего месяца/i.test(String(row[0] ?? '')));
  if (!yearRow || start < 0) throw new ProviderError('Росстат: не найдены месячные индексы цен.', { code: 'INVALID_SOURCE_DATA' });
  const result = new Map();
  for (const row of table.slice(start + 1, start + 13)) {
    const m = monthLabels.indexOf(String(row[0] ?? '').trim().toLowerCase());
    if (m < 0) throw new ProviderError('Росстат: неизвестный месяц в таблице ИПЦ.', { code: 'INVALID_SOURCE_DATA' });
    for (let j = 1; j < yearRow.length; j++) {
      if (!Number.isInteger(yearRow[j]) || yearRow[j] < 1991 || yearRow[j] > 2100 || row[j] == null || row[j] === '') continue;
      result.set(`${yearRow[j]}-${String(m + 1).padStart(2, '0')}`, positive(row[j], 'ИПЦ Росстата') / 100);
    }
  }
  if (!result.size) throw new ProviderError('Росстат: ряд ИПЦ пуст.', { code: 'INVALID_SOURCE_DATA' });
  return result;
}

export function discoverCPIURL(html) {
  const match = /href=["']([^"']*\/storage\/mediabank\/ipc_mes[^"']*\.xlsx)["']/i.exec(html);
  if (!match) throw new ProviderError('Росстат: ссылка на месячный ИПЦ не найдена. Попробуйте загрузить Excel вручную.', { code: 'INVALID_SOURCE_DATA' });
  const url = new URL(match[1].replace(/&amp;/g, '&'), CPI_PAGE);
  if (!['rosstat.gov.ru', 'www.rosstat.gov.ru'].includes(url.hostname) || url.protocol !== 'https:' || !url.pathname.startsWith('/storage/mediabank/')) {
    throw new ProviderError('Росстат: неожиданная ссылка на файл ИПЦ.', { code: 'INVALID_SOURCE_DATA' });
  }
  return url.href;
}

export function parseMOEXCandles(payload, label = 'MOEX') {
  const candles = payload?.candles;
  if (!Array.isArray(candles?.columns) || !Array.isArray(candles?.data)) throw new ProviderError(`${label}: неизвестный формат ответа биржи.`, { code: 'INVALID_SOURCE_DATA' });
  const dateIndex = candles.columns.indexOf('begin'), valueIndex = candles.columns.indexOf('close');
  if (dateIndex < 0 || valueIndex < 0) throw new ProviderError(`${label}: в ответе отсутствует дата или цена.`, { code: 'INVALID_SOURCE_DATA' });
  const result = new Map();
  for (const row of candles.data) {
    const date = String(row[dateIndex] ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-01$/.test(date)) throw new ProviderError(`${label}: неизвестная дата месячной свечи.`, { code: 'INVALID_SOURCE_DATA' });
    if (row[valueIndex] != null) result.set(date.slice(0, 7), { date: monthEnd(date.slice(0, 7)), value: positive(row[valueIndex], label) });
  }
  return result;
}

function workbookTable(buffer, sheet) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const name = sheet ?? workbook.SheetNames[0];
  if (!workbook.Sheets[name]) throw new ProviderError('В источнике не найден нужный лист Excel.', { code: 'INVALID_SOURCE_DATA' });
  return XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null });
}

function cached(cache, key, limit, task) {
  const old = cache.get(key);
  if (old && old.expires > Date.now()) return old.promise;
  cache.delete(key);
  while (cache.size >= limit) cache.delete(cache.keys().next().value);
  const entry = { expires: Date.now() + TTL, promise: Promise.resolve().then(task) };
  cache.set(key, entry);
  entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return entry.promise;
}

async function download(url, label, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { Accept: '*/*' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('слишком большой ответ');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('слишком большой ответ'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    throw new ProviderError(`${label} недоступен (${error.name === 'TimeoutError' ? 'истекло время ожидания' : error.message}). Попробуйте позже или загрузите Excel.`, { code: 'SOURCE_UNAVAILABLE' });
  }
}

function missing(label, month, map) {
  const latestAvailable = [...map.keys()].sort().at(-1);
  throw new ProviderError(`${label}: данные за ${month} отсутствуют${latestAvailable ? `; последний доступный месяц — ${latestAvailable}` : ''}. Выберите другой период.`, { status: 422, code: 'MISSING_DATA', latestAvailable, missingMonth: month });
}

export function assembleMarketData(months, money, cpiRates, series, cpiURL, downloadedAt = new Date().toISOString()) {
  let cpi = 100;
  const rows = months.map((month, i) => {
    if (!money.has(month)) missing('М2 ЦБ', month, money);
    if (!cpiRates.has(month)) missing('ИПЦ Росстата', month, cpiRates);
    if (i) cpi *= cpiRates.get(month);
    const values = [money.get(month).value, ...series.map(s => {
      if (!s.values.has(month)) missing(s.name, month, s.values);
      return s.values.get(month).value;
    })];
    return { date: monthEnd(month), cpi, values };
  });
  return {
    names: ['Рублёвая масса М2', ...series.map(s => s.name)], rows, frequency: 12, demo: false,
    source: 'ЦБ · Росстат · MOEX ISS', period: { from: months[0], to: months.at(-1) }, downloadedAt,
    provenance: [
      { name: 'Банк России — М2', url: MONEY_URL, indicators: ['Рублёвая масса М2'], method: 'Млрд рублей. Остаток на 1-е число следующего месяца отнесён к концу отчётного месяца.' },
      { name: 'Банк России — валюты и металлы', url: `${CBR}/development/sxml/`, indicators: series.slice(0, 7).map(s => s.name), method: 'Последняя опубликованная котировка каждого месяца. Валюты: рублей за 1 единицу; металлы: рублей за грамм.' },
      { name: 'Росстат — месячный ИПЦ', url: cpiURL, indicators: ['ИПЦ'], method: 'Общий ИПЦ по России, к концу предыдущего месяца. Накопленный индекс: 100 на первом наблюдении конца месяца, далее произведение месячных индексов.' },
      { name: 'Московская биржа — ISS', url: 'https://www.moex.com/a2193', indicators: series.slice(7).map(s => s.name), method: 'Закрытие месячной свечи, рублёвые индексы в пунктах. IMOEX без дивидендов; RGBITR с купонным доходом.' }
    ],
    notes: ['М2 — макроэкономический индикатор, а не покупаемый актив.', 'Набор содержит четыре драгоценных металла, три валюты и два рублёвых биржевых индекса.', 'Все доходности приложение корректирует на накопленный ИПЦ. Пропуски не заполняются вымышленными значениями.']
  };
}

export async function loadMarketData(from, to, { fetchImpl = fetch, now = new Date(), useCache = true } = {}) {
  const months = validatePeriod(from, to, now);
  const task = async () => {
    const get = (url, label) => useCache ? cached(sourceCache, url, 64, () => download(url, label, fetchImpl)) : download(url, label, fetchImpl);
    const firstDate = `01/${from.slice(5)}/${from.slice(0, 4)}`;
    const lastDate = monthEnd(to).split('-').reverse().join('/');
    const range = `date_req1=${firstDate}&date_req2=${lastDate}`;
    const currencyCodes = ['R01235', 'R01239', 'R01375'];
    const moexURL = id => `${MOEX}/iss/engines/stock/markets/index/securities/${id}/candles.json?from=${from}-01&till=${monthEnd(to)}&interval=31&iss.meta=off&candles.columns=begin,end,close`;
    const [moneyBuffer, cpiHTML, metalsBuffer, currencyBuffers, moexBuffers] = await Promise.all([
      get(MONEY_URL, 'Банк России — М2'), get(CPI_PAGE, 'Росстат'),
      get(`${CBR}/scripts/xml_metall.asp?${range}`, 'Банк России — металлы'),
      Promise.all(currencyCodes.map(code => get(`${CBR}/scripts/XML_dynamic.asp?${range}&VAL_NM_RQ=${code}`, 'Банк России — валюты'))),
      Promise.all(['IMOEX', 'RGBITR'].map(id => get(moexURL(id), `Московская биржа — ${id}`)))
    ]);
    const cpiURL = discoverCPIURL(cpiHTML.toString('utf8'));
    const cpiBuffer = await get(cpiURL, 'Росстат — файл ИПЦ');
    const metals = parseMetalXML(metalsBuffer.toString('utf8'));
    const names = ['Золото', 'Серебро', 'Платина', 'Палладий', 'Доллар США', 'Евро', 'Юань', 'Индекс Мосбиржи / IMOEX', 'ОФЗ / RGBITR'];
    const values = [
      ...['1', '2', '3', '4'].map(code => monthlyLast(metals.get(code))),
      ...currencyBuffers.map(buffer => monthlyLast(parseCurrencyXML(buffer.toString('utf8')))),
      ...moexBuffers.map((buffer, i) => parseMOEXCandles(JSON.parse(buffer.toString('utf8')), ['IMOEX', 'RGBITR'][i]))
    ];
    return assembleMarketData(months, parseMoneyTable(workbookTable(moneyBuffer)), parseCPITable(workbookTable(cpiBuffer, '01')), names.map((name, i) => ({ name, values: values[i] })), cpiURL);
  };
  return useCache ? cached(periodCache, `${from}:${to}`, 16, task) : task();
}
