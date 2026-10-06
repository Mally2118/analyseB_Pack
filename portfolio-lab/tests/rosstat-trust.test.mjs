import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareRosstatTrust, ROOT_FINGERPRINT, validateOfficialChain } from '../configure-rosstat-trust.mjs';

const now = new Date('2026-10-06T12:00:00Z');
const bundle = await readFile(new URL('../certs/rosstat-ca.pem', import.meta.url), 'utf8');
const blocks = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
const fallbackFile = new URL('../certs/rosstat-ca.pem', import.meta.url);
async function outputFor(t) {
  const folder = await mkdtemp(join(tmpdir(), 'portfolio-ca-'));
  t.after(async () => {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('portfolio-ca-'));
    await rm(folder, { recursive: true, force: true });
  });
  return { folder, output: join(folder, 'rosstat-ca.pem') };
}
function officialFetch() {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(new URL(url).hostname, 'gu-st.ru');
      assert.equal(new URL(url).protocol, 'https:');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(url.includes('_root_') ? blocks[0] : blocks[1]);
    }
  };
}

test('bundled Rosstat chain has the pinned self-signed root and currently valid signed intermediate', () => {
  const { root, sub } = validateOfficialChain(bundle, now);
  assert.equal(root.fingerprint256.replace(/:/g, ''), ROOT_FINGERPRINT);
  assert.equal(sub.fingerprint256.replace(/:/g, ''), '2155785036C900DBB5F1BB2A1569C80C55595BD6BF94867A29BBDDBC7D88A3F2');
  assert.equal(root.ca, true);
  assert.equal(sub.ca, true);
  assert.equal(root.verify(root.publicKey), true);
  assert.equal(sub.checkIssued(root), true);
  assert.equal(sub.verify(root.publicKey), true);
});

test('trust validation rejects wrong roots, duplicated roots, incomplete bundles and extra material', () => {
  for (const wrong of [blocks[1] + '\n' + blocks[0], blocks[0] + '\n' + blocks[0], blocks[0], bundle + blocks[0], bundle + '\nPRIVATE KEY']) {
    assert.throws(() => validateOfficialChain(wrong, now));
  }
  assert.throws(() => validateOfficialChain(bundle, new Date('2001-01-01')), /not currently valid/);
  assert.throws(() => validateOfficialChain(bundle, new Date('2040-01-01')), /not currently valid/);
  assert.throws(() => validateOfficialChain(bundle, new Date('2029-07-20')), /not currently valid/);
});

test('a certificate with a modified intermediate signature cannot be trusted', () => {
  const base64 = blocks[1].replace(/-----[^-]+-----|\s/g, '');
  const der = Buffer.from(base64, 'base64');
  der[der.length - 1] ^= 1;
  const altered = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----`;
  assert.throws(() => validateOfficialChain(blocks[0] + '\n' + altered, now), /signatures/);
});

test('official downloads produce an atomically written validated bundle without temporary leftovers', async t => {
  const { folder, output } = await outputFor(t);
  const { requests, fetchImpl } = officialFetch();
  const result = await prepareRosstatTrust({ output, fetchImpl, now });
  assert.equal(result.refreshed, true);
  assert.equal(requests.length, 2);
  assert.equal((await readFile(output, 'utf8')), result.pem);
  assert.deepEqual(await readdir(folder), ['rosstat-ca.pem']);
});

test('an upstream outage uses only the independently validated bundled official pair', async t => {
  const { output } = await outputFor(t);
  const warnings = [];
  const result = await prepareRosstatTrust({ output, bundled: fallbackFile, now, fetchImpl: async () => { throw new Error('Unavailable'); }, warn: message => warnings.push(message) });
  assert.equal(result.refreshed, false);
  assert.equal(result.root.fingerprint256.replace(/:/g, ''), ROOT_FINGERPRINT);
  assert.equal(warnings.length, 1);
  assert.equal(validateOfficialChain(await readFile(output, 'utf8'), now).sub.fingerprint256, result.sub.fingerprint256);
});

test('oversized downloads fall back safely; an invalid fallback cannot overwrite the existing output', async t => {
  const { folder, output } = await outputFor(t);
  const result = await prepareRosstatTrust({ output, bundled: fallbackFile, now, fetchImpl: async () => new Response('x'.repeat(65537)), warn: () => {} });
  assert.equal(result.refreshed, false);
  const invalid = join(folder, 'invalid.pem');
  await writeFile(invalid, blocks[1] + '\n' + blocks[0]);
  await writeFile(output, 'Existing output');
  await assert.rejects(prepareRosstatTrust({ output, bundled: invalid, now, fetchImpl: async () => { throw new Error('Unavailable'); } }), /pinned root/);
  assert.equal(await readFile(output, 'utf8'), 'Existing output');
});
