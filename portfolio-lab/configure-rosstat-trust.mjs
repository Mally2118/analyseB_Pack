import { X509Certificate, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_FINGERPRINT = 'D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31';
const SOURCES = ['root', 'sub'].map(kind => `https://gu-st.ru/content/lending/russian_trusted_${kind}_ca_pem.crt`);
const BUNDLED = fileURLToPath(new URL('./certs/rosstat-ca.pem', import.meta.url));
const DEFAULT_OUTPUT = fileURLToPath(new URL('./artifacts/rosstat-ca.pem', import.meta.url));

export function validateOfficialChain(pem, now = new Date()) {
  const blocks = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length !== 2 || blocks.reduce((rest, block) => rest.replace(block, ''), String(pem)).trim()) throw new Error('Expected exactly the official root and intermediate certificates.');
  const [root, sub] = blocks.map(block => new X509Certificate(block));
  if (root.fingerprint256.replace(/:/g, '') !== ROOT_FINGERPRINT || root.fingerprint256 === sub.fingerprint256 || !root.ca || !sub.ca ||
      !root.checkIssued(root) || !root.verify(root.publicKey) || !sub.checkIssued(root) || !sub.verify(root.publicKey)) throw new Error('Official certificate chain does not match the pinned root or signatures.');
  for (const cert of [root, sub]) if (Date.parse(cert.validFrom) > now.getTime() || Date.parse(cert.validTo) <= now.getTime()) throw new Error('Official certificate chain is not currently valid.');
  return { pem: root.toString() + '\n' + sub.toString() + '\n', root, sub };
}

async function download(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error(`Certificate download returned HTTP ${response.status}.`);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if ((size += value.length) > 64 * 1024) { await reader.cancel(); throw new Error('Certificate download exceeded 64 KiB.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function prepareRosstatTrust({ output = DEFAULT_OUTPUT, bundled = BUNDLED, fetchImpl = fetch, now = new Date(), warn = console.warn } = {}) {
  let chain, refreshed = true;
  try { chain = validateOfficialChain((await Promise.all(SOURCES.map(url => download(url, fetchImpl)))).join('\n'), now); }
  catch (error) {
    chain = validateOfficialChain(await readFile(bundled, 'utf8'), now);
    refreshed = false;
    warn(`Official certificate refresh failed (${error.message}); using the validated bundled chain.`);
  }
  const target = resolve(output), temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try { await writeFile(temporary, chain.pem, { flag: 'wx' }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { ...chain, output: target, refreshed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node configure-rosstat-trust.mjs [--output path]');
  try {
    const result = await prepareRosstatTrust({ output: args[1] ? resolve(args[1]) : DEFAULT_OUTPUT });
    console.log(`Validated Rosstat CA chain: root SHA-256 ${ROOT_FINGERPRINT}; intermediate SHA-256 ${result.sub.fingerprint256.replace(/:/g, '')}; source=${result.refreshed ? 'official download' : 'bundled copy'}.`);
  } catch (error) { console.error(`Certificate preparation failed: ${error.message}`); process.exitCode = 1; }
}
