import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { BundleError, unpackBundle } from '../src/bundle.mjs';

const enc = strToU8;
async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'pdf-test-')); }
async function rejects(files) {
  const dir = await tmp();
  try {
    await assert.rejects(unpackBundle(zipSync(files), dir), (e) => e instanceof BundleError && e.code === 'bad-bundle');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('valid bundle is unpacked', async () => {
  const dir = await tmp();
  try {
    await unpackBundle(zipSync({ 'index.html': enc('<p>가나다</p>'), 'images/a.png': new Uint8Array([1, 2, 3]) }), dir);
    assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), '<p>가나다</p>');
    assert.deepEqual([...(await fs.readFile(path.join(dir, 'images/a.png')))], [1, 2, 3]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('bundle without images is unpacked', async () => {
  const dir = await tmp();
  try {
    await unpackBundle(zipSync({ 'index.html': enc('x') }), dir);
    assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), 'x');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('rejects path traversal', () => rejects({ 'index.html': enc('x'), '../x': enc('y') }));
test('rejects absolute path', () => rejects({ 'index.html': enc('x'), '/etc/x': enc('y') }));
test('rejects images/ traversal', () => rejects({ 'index.html': enc('x'), 'images/../x': enc('y') }));
test('rejects unexpected file', () => rejects({ 'index.html': enc('x'), 'script.js': enc('alert(1)') }));
test('rejects nested images path', () => rejects({ 'index.html': enc('x'), 'images/a/b.png': enc('y') }));
test('rejects images/. and images/..', async () => {
  await rejects({ 'index.html': enc('x'), 'images/.': enc('y') });
  await rejects({ 'index.html': enc('x'), 'images/..': enc('y') });
});
test('rejects too many entries', async () => {
  const files = { 'index.html': enc('x') };
  for (let i = 0; i < 20_000; i++) files[`images/a${i}.png`] = new Uint8Array(0);
  await rejects(files);
});
test('rejects missing index.html', () => rejects({ 'images/a.png': enc('y') }));

test('rejects non-zip bytes', async () => {
  const dir = await tmp();
  try {
    await assert.rejects(unpackBundle(new Uint8Array([1, 2, 3, 4, 5]), dir), (e) => e instanceof BundleError && e.code === 'bad-bundle');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('rejects a zip that declares more than the unpacked cap', async () => {
  const dir = await tmp();
  try {
    const zip = zipSync({ 'index.html': enc('x'), 'images/z.png': new Uint8Array(2 * 1024 * 1024) });
    await assert.rejects(unpackBundle(zip, dir, { maxUnpacked: 1024 * 1024 }), (e) => e instanceof BundleError && e.code === 'bad-bundle');
    await unpackBundle(zip, dir, { maxUnpacked: 4 * 1024 * 1024 }); // 상한 안이면 풀린다
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
