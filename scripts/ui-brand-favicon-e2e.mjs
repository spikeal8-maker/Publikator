import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = path.join(root, 'public');
const html = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
const expected = [
  ['favicon.ico', 'image/x-icon'],
  ['favicon.svg', 'image/svg+xml'],
  ['apple-touch-icon.png', 'image/png'],
  ['favicon-192.png', 'image/png'],
  ['favicon-512.png', 'image/png'],
  ['site.webmanifest', 'application/manifest+json']
];
// The two Android raster sizes are referenced from the manifest, not the HTML head.
for (const [file] of expected.filter(([name]) => !/^favicon-(192|512)\.png$/.test(name))) {
  assert(html.includes(`/${file}?v=pk-1`), `${file} missing or unversioned in page head`);
}
assert(html.includes('name="theme-color"'), 'browser theme color not configured');
const source = await fs.readFile(path.join(publicDir, 'favicon.svg'), 'utf8');
assert.match(source, /^<svg\s/);
assert.match(source, /<title[^>]*>Publikator/);
assert.doesNotMatch(source, /<script\b|\bonload\s*=|\bhref\s*=\s*["']https?:/i);

const fingerprints = async () => Promise.all(expected.slice(0, 5).map(async ([file]) => {
  const data = await fs.readFile(path.join(publicDir, file));
  return crypto.createHash('sha256').update(data).digest('hex');
}));
const before = await fingerprints();
const generated = spawnSync(process.execPath, ['scripts/generate-favicons.mjs'], {
  cwd: root, encoding: 'utf8', timeout: 45_000
});
assert.equal(generated.status, 0, generated.stderr?.slice(-1000));
assert.deepEqual(await fingerprints(), before, 'brand assets must be reproducible on every build');

const ico = await fs.readFile(path.join(publicDir, 'favicon.ico'));
assert.equal(ico.readUInt16LE(0), 0);
assert.equal(ico.readUInt16LE(2), 1);
assert.equal(ico.readUInt16LE(4), 3);
for (const [index, size] of [16, 32, 48].entries()) {
  const at = 6 + index * 16;
  assert.equal(ico.readUInt8(at), size);
  assert.equal(ico.readUInt8(at + 1), size);
  assert.equal(ico.readUInt16LE(at + 6), 32);
  const bytes = ico.readUInt32LE(at + 8);
  const offset = ico.readUInt32LE(at + 12);
  assert(bytes > 100 && offset + bytes <= ico.length);
  assert.equal(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a');
  const metadata = await sharp(ico.subarray(offset, offset + bytes)).metadata();
  assert.equal(metadata.width, size);
  assert.equal(metadata.height, size);
}
for (const [size, file] of [[180, 'apple-touch-icon.png'], [192, 'favicon-192.png'], [512, 'favicon-512.png']]) {
  const metadata = await sharp(path.join(publicDir, file)).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, size);
  assert.equal(metadata.height, size);
}
const manifest = JSON.parse(await fs.readFile(path.join(publicDir, 'site.webmanifest'), 'utf8'));
assert.equal(manifest.name, 'Publikator');
assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-favicon-'));
const port = 18261;
Object.assign(process.env, {
  NODE_ENV: 'test', DATA_DIR: dataDir,
  ADMIN_PASSWORD: 'favicon-test-password',
  APP_MASTER_KEY: 'favicon-test-master-key-longer-than-32-characters',
  PUBLIC_BASE_URL: `http://127.0.0.1:${port}`
});
const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');
migrate();
const app = await buildApp();
let browser;
try {
  for (const [file, mime] of expected) {
    const response = await app.inject({ method: 'GET', url: `/${file}?v=pk-1` });
    assert.equal(response.statusCode, 200, `${file}: ${response.statusCode}`);
    const actual = String(response.headers['content-type'] || '');
    if (file === 'favicon.ico') assert.match(actual, /image\/(x-icon|vnd\.microsoft\.icon)/);
    else if (file === 'site.webmanifest') assert.match(actual, /application\/(manifest\+json|json|octet-stream)/);
    else assert(actual.startsWith(mime), `${file} has wrong mime: ${actual}`);
    assert.notEqual(response.headers['content-type'], 'text/html', `${file} fell back to SPA index`);
  }
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    const chrome = await page.evaluate(async () => {
      const svg = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
      const ico = document.querySelector('link[rel="icon"][type="image/x-icon"]');
      const apple = document.querySelector('link[rel="apple-touch-icon"]');
      const manifest = document.querySelector('link[rel="manifest"]');
      if (!svg || !ico || !apple || !manifest) return { valid: false };
      const image = new Image();
      image.src = svg.href;
      await image.decode();
      const urls = [svg.href, ico.href, apple.href, manifest.href];
      const status = await Promise.all(urls.map(url => fetch(url, { cache: 'no-store' }).then(res => res.status)));
      return { valid: image.naturalWidth > 0, status, customSvg: svg.href.includes('favicon.svg?v=pk-1') };
    });
    assert.equal(chrome.valid, true, `Chrome ${width} cannot decode favicon SVG`);
    assert.equal(chrome.customSvg, true);
    assert(chrome.status.every(code => code === 200), `Chrome ${width}: ${chrome.status}`);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(JSON.stringify({
    ok: true, checkpoint: 'UI-FAVICON-001', source: 'single SVG',
    generated: ['ICO 16/32/48', 'PNG 180/192/512'],
    stableBuildHashes: true, staticHttp200: expected.length,
    chromeDesktop: true, chromeMobile: true, browserErrors: 0
  }));
} finally {
  await browser?.close();
  await app.close();
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
