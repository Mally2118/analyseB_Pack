import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { appendFile, readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { refreshSnapshot, validateSnapshot } from './market-snapshot.mjs';

const args = process.argv.slice(2);
let output = fileURLToPath(new URL('./dist/data/market-data.json', import.meta.url));
let strict = false;
let fallback;
let diagnose = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--strict') strict = true;
  else if (args[i] === '--diagnose-runner') diagnose = true;
  else if (args[i] === '--output' && args[i + 1]) output = resolve(args[++i]);
  else if (args[i] === '--fallback' && args[i + 1]) fallback = resolve(args[++i]);
  else throw new Error(`Unknown argument: ${args[i]}`);
}

// Diagnostics stay in the runner log. Do not print stacks, response bodies, environment, or request headers.
function logFailure(error, label = 'Provider failure') {
  const seen = new Set();
  let remaining = 12;
  const clean = value => String(value ?? '').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 240);
  function visit(value, path, depth) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4 || remaining-- <= 0) return;
    seen.add(value);
    console.warn(`${label} ${path}: ${JSON.stringify({ name: clean(value.name), code: clean(value.code), message: clean(value.message) })}`);
    visit(value.cause, `${path}.cause`, depth + 1);
    if (Array.isArray(value.errors)) value.errors.slice(0, 4).forEach((item, i) => visit(item, `${path}.errors[${i}]`, depth + 1));
  }
  visit(error, 'error', 0);
}

async function diagnoseRunner() {
  const urls = [
    'https://www.rosstat.gov.ru/statistics/price', 'https://rosstat.gov.ru/statistics/price',
    'https://www.cbr.ru/vfs/statistics/credit_statistics/monetary_agg.xlsx',
    'https://cbr.ru/vfs/statistics/credit_statistics/monetary_agg.xlsx',
    'https://iss.moex.com/iss/engines/stock/markets/index/securities/IMOEX/candles.json?from=2025-01-01&till=2025-02-28&interval=31&iss.meta=off&candles.columns=begin,end,close'
  ];
  try {
    const seed = validateSnapshot(JSON.parse(await readFile(output, 'utf8')));
    const cpi = seed.provenance.find(item => new URL(item.url).hostname.endsWith('rosstat.gov.ru'));
    if (cpi) {
      urls.push(cpi.url);
      const alternative = new URL(cpi.url);
      alternative.hostname = alternative.hostname === 'www.rosstat.gov.ru' ? 'rosstat.gov.ru' : 'www.rosstat.gov.ru';
      urls.push(alternative.href);
    }
  } catch { /* Fixed public endpoints still diagnose a missing or invalid initial snapshot. */ }
  console.log(`Runner diagnostics: node=${process.version} platform=${process.platform}.`);
  const hosts = [...new Set(urls.map(url => new URL(url).hostname))];
  const diagnostics = await Promise.allSettled([
    ...hosts.map(async hostname => {
      try {
        const records = await lookup(hostname, { all: true });
        console.log(`DNS ${hostname}: ${JSON.stringify(records.slice(0, 4))}`);
      } catch (error) { logFailure(error, `DNS ${hostname}`); }
    }),
    ...urls.map(async url => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: '*/*' } });
        console.log(`Probe ${url}: HTTP ${response.status}; type=${response.headers.get('content-type') ?? 'unknown'}; redirected=${response.redirected}.`);
        await response.body?.cancel();
      } catch (error) { logFailure(error, `Probe ${url}`); }
    })
  ]);
  for (const result of diagnostics) if (result.status === 'rejected') logFailure(result.reason, 'Diagnostic probe');
}

try {
  if (diagnose) await diagnoseRunner();
  const { snapshot, refreshed } = await refreshSnapshot({
    output, fallback, strict,
    warn: (message, error) => {
      console.warn(`::warning::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
      logFailure(error);
    }
  });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `updated=${refreshed}\n`);
  console.log(`${refreshed ? 'Updated' : 'Retained'} official statistics: ${snapshot.rows.length} monthly observations, ${snapshot.period.from}–${snapshot.period.to}; downloaded ${snapshot.downloadedAt}.`);
} catch (error) {
  logFailure(error);
  console.error(`::error::${error.message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  process.exitCode = 1;
}
