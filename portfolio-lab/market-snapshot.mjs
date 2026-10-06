import { loadMarketData, monthEnd, ProviderError } from './data-providers.mjs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const FIRST_MONTH = '2011-01';
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const index = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
const monthAt = value => `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, '0')}`;
const closeEnough = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * 1e-9;
const fail = message => { throw new ProviderError(`Снимок статистики: ${message}`, { code: 'INVALID_SNAPSHOT' }); };

function validateRows(payload) {
  if (!payload || payload.demo !== false || payload.frequency !== 12 || !Array.isArray(payload.names) || payload.names.length !== 10 ||
      payload.names.some(name => typeof name !== 'string' || !name.trim() || name.length > 120) || new Set(payload.names).size !== 10 ||
      !/[МM]2/.test(payload.names[0])) fail('неверный набор официальных индикаторов.');
  const { from, to } = payload.period ?? {};
  if (!MONTH.test(from) || !MONTH.test(to) || from < FIRST_MONTH || to < from) fail('неверный период.');
  if (!Array.isArray(payload.rows) || payload.rows.length !== index(to) - index(from) + 1 || payload.rows.length < 13 || payload.rows.length > 1200) fail('месячный ряд неполон.');
  for (let i = 0; i < payload.rows.length; i++) {
    const row = payload.rows[i];
    if (row?.date !== monthEnd(monthAt(index(from) + i)) || !Number.isFinite(row.cpi) || row.cpi <= 0 ||
        !Array.isArray(row.values) || row.values.length !== 10 || row.values.some(value => !Number.isFinite(value) || value <= 0)) fail('пропуск или неверное значение в месячном ряду.');
  }
  if (!closeEnough(payload.rows[0].cpi, 100)) fail('ИПЦ должен начинаться со 100.');
  if (typeof payload.downloadedAt !== 'string' || !Number.isFinite(Date.parse(payload.downloadedAt)) ||
      typeof payload.source !== 'string' || !payload.source.trim() || !Array.isArray(payload.provenance) || payload.provenance.length < 3) fail('нет времени обновления или источников.');
  const families = new Set();
  for (const item of payload.provenance) {
    let url;
    try { url = new URL(item.url); } catch { fail('неверная ссылка на источник.'); }
    const family = ['cbr.ru', 'rosstat.gov.ru', 'moex.com'].find(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    if (url.protocol !== 'https:' || !family || url.username || url.password) fail('источник не является официальным.');
    families.add(family);
  }
  if (families.size !== 3) fail('не представлены ЦБ, Росстат и Мосбиржа.');
  return payload;
}

export function validateSnapshot(payload) {
  validateRows(payload);
  if (payload.schemaVersion !== 1 || payload.delivery !== 'github-actions' ||
      payload.availablePeriod?.from !== payload.period.from || payload.availablePeriod?.to !== payload.period.to) fail('неверная версия или доступный период.');
  return payload;
}

export function stitchMarketChunks(chunks, downloadedAt = new Date().toISOString()) {
  if (!Array.isArray(chunks) || !chunks.length) fail('нет данных для объединения.');
  const ordered = [...chunks].sort((a, b) => a.period.from.localeCompare(b.period.from));
  const first = ordered[0];
  const merged = new Map();
  let lastIndex;
  for (const chunk of ordered) {
    validateRows(chunk);
    if (chunk.names.some((name, i) => name !== first.names[i])) fail('состав индикаторов отличается между периодами.');
    const anchor = chunk.rows.find(row => merged.has(row.date));
    if (merged.size && !anchor) fail('периоды не перекрываются.');
    const scale = anchor ? merged.get(anchor.date).cpi / anchor.cpi : 1;
    for (const row of chunk.rows) {
      const adjusted = { date: row.date, cpi: row.cpi * scale, values: [...row.values] };
      const previous = merged.get(row.date);
      if (previous) {
        if (!closeEnough(previous.cpi, adjusted.cpi) || previous.values.some((value, i) => !closeEnough(value, adjusted.values[i]))) fail(`источники изменились при загрузке ${row.date.slice(0, 7)}. Повторите обновление.`);
      } else {
        const currentIndex = index(row.date.slice(0, 7));
        if (lastIndex !== undefined && currentIndex !== lastIndex + 1) fail('пропуск между периодами.');
        merged.set(row.date, adjusted);
        lastIndex = currentIndex;
      }
    }
  }
  const rows = [...merged.values()];
  const period = { from: rows[0].date.slice(0, 7), to: rows.at(-1).date.slice(0, 7) };
  // The final chunk carries the current CPI download URL and source descriptions.
  return validateSnapshot({ ...ordered.at(-1), rows, period, downloadedAt, schemaVersion: 1, delivery: 'github-actions', availablePeriod: { ...period } });
}

export async function buildMarketSnapshot({ now = new Date(), load = loadMarketData, firstMonth = FIRST_MONTH, maxPublicationLag = 6 } = {}) {
  if (!MONTH.test(firstMonth) || firstMonth < FIRST_MONTH) fail('неверный начальный месяц.');
  const closed = now.getUTCFullYear() * 12 + now.getUTCMonth() - 1;
  let terminal = closed;
  let latest;
  while (!latest) {
    const from = monthAt(Math.max(index(firstMonth), terminal - 120));
    const to = monthAt(terminal);
    try {
      latest = await load(from, to, { now });
    } catch (error) {
      const available = error.latestAvailable;
      if (error.code !== 'MISSING_DATA' || !MONTH.test(available) || !MONTH.test(error.missingMonth) ||
          index(available) >= terminal || error.missingMonth <= available || closed - index(available) > maxPublicationLag) throw error;
      terminal = index(available);
    }
  }
  const chunks = [];
  let start = index(firstMonth);
  const latestStart = index(latest.period.from);
  while (start < latestStart) {
    const end = Math.min(start + 120, terminal);
    chunks.push(await load(monthAt(start), monthAt(end), { now }));
    if (end >= latestStart) break;
    start = end;
  }
  chunks.push(latest);
  const snapshot = stitchMarketChunks(chunks, now.toISOString());
  if (snapshot.period.from !== firstMonth || snapshot.period.to !== monthAt(terminal)) fail('источники вернули другой период.');
  return snapshot;
}

async function atomicWrite(target, snapshot) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(snapshot) + '\n', { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function refreshSnapshot({ output, fallback, build = buildMarketSnapshot, strict = false, warn = () => {} } = {}) {
  const target = resolve(output);
  const paths = [target, ...(fallback ? [resolve(fallback)] : [])];
  const candidates = await Promise.all(paths.map(async path => {
    try { return { path, snapshot: validateSnapshot(JSON.parse(await readFile(path, 'utf8'))) }; }
    catch { return null; }
  }));
  const previous = candidates.filter(Boolean).sort((a, b) => Date.parse(b.snapshot.downloadedAt) - Date.parse(a.snapshot.downloadedAt))[0];
  try {
    const snapshot = validateSnapshot(await build());
    if (previous && snapshot.period.to < previous.snapshot.period.to) fail(`конец опубликованного ряда уменьшился с ${previous.snapshot.period.to} до ${snapshot.period.to}.`);
    await atomicWrite(target, snapshot);
    return { snapshot, refreshed: true };
  } catch (error) {
    if (strict || !previous) throw error;
    if (previous.path !== target) await atomicWrite(target, previous.snapshot);
    warn(`Обновление официальной статистики не выполнено: ${error.message} Сохранён снимок от ${previous.snapshot.downloadedAt} с данными по ${previous.snapshot.period.to}.`, error);
    return { snapshot: previous.snapshot, refreshed: false };
  }
}
