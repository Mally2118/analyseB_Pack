import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { refreshSnapshot } from './market-snapshot.mjs';

const args = process.argv.slice(2);
let output = fileURLToPath(new URL('./dist/data/market-data.json', import.meta.url));
let strict = false;
let fallback;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--strict') strict = true;
  else if (args[i] === '--output' && args[i + 1]) output = resolve(args[++i]);
  else if (args[i] === '--fallback' && args[i + 1]) fallback = resolve(args[++i]);
  else throw new Error(`Unknown argument: ${args[i]}`);
}

try {
  const { snapshot, refreshed } = await refreshSnapshot({
    output, fallback, strict,
    warn: message => console.warn(`::warning::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`)
  });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `updated=${refreshed}\n`);
  console.log(`${refreshed ? 'Updated' : 'Retained'} official statistics: ${snapshot.rows.length} monthly observations, ${snapshot.period.from}–${snapshot.period.to}; downloaded ${snapshot.downloadedAt}.`);
} catch (error) {
  console.error(`::error::${error.message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  process.exitCode = 1;
}
