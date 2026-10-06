const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 5 * 60 * 1000;
const snapshots = new WeakMap();
const INVALID_DATA = 'Источник вернул некорректные данные. Предыдущая выборка сохранена.';
const INVALID_SNAPSHOT = 'Подготовленная статистика повреждена. Повторите загрузку позже.';
const SNAPSHOT_UNAVAILABLE = 'Не удалось загрузить подготовленную статистику. Повторите загрузку или используйте Excel.';
const API_UNAVAILABLE = 'Не удалось получить официальные данные. Попробуйте другой период.';
const monthIndex = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const monthName = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
const monthEnd = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const defaultBaseURL = () => globalThis.document?.baseURI || globalThis.location?.href;

function requestedMonths(from, to, now) {
  if (![from, to].every(month => typeof month === 'string' && MONTH.test(month))) {
    throw Error('Укажите начало и конец периода в формате ГГГГ-ММ.');
  }
  const first = monthIndex(from), last = monthIndex(to);
  const closed = now.getUTCFullYear() * 12 + now.getUTCMonth() - 1;
  if (first < monthIndex('2011-01') || last > closed) {
    throw Error('Выберите полностью завершённые месяцы, начиная с января 2011 года.');
  }
  const count = last - first + 1;
  if (count < 13 || count > 121) {
    throw Error('Выберите от 13 до 121 месяца: от года до десяти лет доходностей.');
  }
  return Array.from({ length: count }, (_, i) => monthName(first + i));
}

function validateDataset(dataset, errorMessage = INVALID_DATA) {
  const invalid = () => { throw Error(errorMessage); };
  if (!dataset || dataset.demo !== false || dataset.frequency !== 12 ||
      typeof dataset.source !== 'string' || !dataset.source.trim() ||
      !Array.isArray(dataset.names) || dataset.names.length !== 10 ||
      dataset.names.some(name => typeof name !== 'string' || !name.trim() || name.length > 80) ||
      new Set(dataset.names).size !== 10 ||
      !Array.isArray(dataset.rows) || dataset.rows.length < 13 || dataset.rows.length > 1200 ||
      typeof dataset.downloadedAt !== 'string' || !Number.isFinite(Date.parse(dataset.downloadedAt))) invalid();
  let previous;
  for (const row of dataset.rows) {
    const month = typeof row?.date === 'string' ? row.date.slice(0, 7) : '';
    if (!MONTH.test(month) || row.date !== monthEnd(month) ||
        (previous !== undefined && monthIndex(month) !== previous + 1) ||
        !positive(row.cpi) || !Array.isArray(row.values) || row.values.length !== 10 ||
        !row.values.every(positive)) invalid();
    previous = monthIndex(month);
  }
  const actual = { from: dataset.rows[0].date.slice(0, 7), to: dataset.rows.at(-1).date.slice(0, 7) };
  if (dataset.period?.from !== actual.from || dataset.period?.to !== actual.to) invalid();
  return actual;
}

function validateSnapshot(snapshot) {
  const actual = validateDataset(snapshot, INVALID_SNAPSHOT);
  if (snapshot.schemaVersion !== 1 || snapshot.delivery !== 'github-actions' ||
      snapshot.availablePeriod?.from !== actual.from || snapshot.availablePeriod?.to !== actual.to ||
      !Array.isArray(snapshot.provenance) || !snapshot.provenance.length) throw Error(INVALID_SNAPSHOT);
  for (const source of snapshot.provenance) {
    let url;
    try { url = new URL(source?.url); } catch { throw Error(INVALID_SNAPSHOT); }
    if (url.protocol !== 'https:' || !['cbr.ru', 'rosstat.gov.ru', 'moex.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
      throw Error(INVALID_SNAPSHOT);
    }
  }
  return snapshot;
}

/** Select monthly levels from the published snapshot without changing their real returns. */
export function selectSnapshotPeriod(snapshot, from, to, { now = new Date() } = {}) {
  const months = requestedMonths(from, to, now);
  validateSnapshot(snapshot);
  const { availablePeriod } = snapshot;
  if (from < availablePeriod.from || to > availablePeriod.to) {
    const error = Error(`В подготовленной статистике доступен период с ${availablePeriod.from} по ${availablePeriod.to}. Выберите даты внутри этого периода.`);
    error.code = 'PERIOD_UNAVAILABLE';
    error.availablePeriod = { ...availablePeriod };
    throw error;
  }
  const offset = monthIndex(from) - monthIndex(availablePeriod.from);
  const selected = snapshot.rows.slice(offset, offset + months.length);
  const baseCPI = selected[0].cpi;
  const rows = selected.map((row, index) => ({
    date: row.date,
    cpi: index === 0 ? 100 : row.cpi / baseCPI * 100,
    values: [...row.values]
  }));
  if (rows.some(row => !positive(row.cpi))) throw Error(INVALID_SNAPSHOT);
  return { ...snapshot, names: [...snapshot.names], rows, period: { from, to }, availablePeriod: { ...availablePeriod }, delivery: 'github-actions' };
}

export function isStaticDataHost(baseURL = defaultBaseURL()) {
  const host = new URL(baseURL).hostname.toLowerCase();
  return host === 'github.io' || host.endsWith('.github.io');
}

async function readJSON(response, invalidMessage) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw Error(invalidMessage);
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw Error(invalidMessage);
  try { return JSON.parse(body); } catch { throw Error(invalidMessage); }
}

/** Read the same-origin snapshot once for the availability note and subsequent period selections. */
export async function readOfficialSnapshot({ fetchImpl = fetch, baseURL = defaultBaseURL(), useCache = true } = {}) {
  const url = new URL('data/market-data.json', baseURL).href;
  let cache = snapshots.get(fetchImpl);
  if (!cache) { cache = new Map(); snapshots.set(fetchImpl, cache); }
  const previous = cache.get(url);
  if (useCache && previous && Date.now() - previous.created < CACHE_MS) return previous.promise;
  const promise = (async () => {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' }, cache: 'no-cache' });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
      throw Error(SNAPSHOT_UNAVAILABLE);
    }
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) throw Error(SNAPSHOT_UNAVAILABLE);
    return validateSnapshot(await readJSON(response, INVALID_SNAPSHOT));
  })();
  const entry = { created: Date.now(), promise };
  if (useCache) cache.set(url, entry);
  try { return await promise; }
  catch (error) { if (cache.get(url) === entry) cache.delete(url); throw error; }
}

/** Keep the local Node API; static hosts use data prepared by the GitHub workflow. */
export async function loadOfficialMarketData(from, to, { fetchImpl = fetch, baseURL = defaultBaseURL(), now = new Date(), useCache = true } = {}) {
  const months = requestedMonths(from, to, now);
  const fromSnapshot = async () => selectSnapshotPeriod(await readOfficialSnapshot({ fetchImpl, baseURL, useCache }), from, to, { now });
  if (isStaticDataHost(baseURL)) return fromSnapshot();
  const url = new URL('api/market-data', baseURL);
  url.search = new URLSearchParams({ from, to }).toString();
  const response = await fetchImpl(url.href, { signal: AbortSignal.timeout(65000), headers: { Accept: 'application/json' } });
  const isJSON = (response.headers.get('content-type') || '').includes('application/json');
  if (response.status === 404 || response.status === 405 || (!isJSON && response.status !== 400 && response.status !== 422)) return fromSnapshot();
  if (!isJSON) throw Error(API_UNAVAILABLE);
  const dataset = await readJSON(response, INVALID_DATA);
  if (!response.ok) {
    const error = Error(typeof dataset?.error === 'string' ? dataset.error : API_UNAVAILABLE);
    error.status = response.status;
    error.code = dataset?.code;
    error.latestAvailable = dataset?.latestAvailable;
    throw error;
  }
  validateDataset(dataset);
  if (dataset.rows.length !== months.length || dataset.period.from !== from || dataset.period.to !== to) throw Error(INVALID_DATA);
  return { ...dataset, delivery: 'direct-api', availablePeriod: dataset.availablePeriod || { ...dataset.period } };
}
