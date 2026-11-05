'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAssets, parseAssetFile } = require('../src/lib/assets');

function directoryWith(app, menu) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tlog-assets-'));
  fs.writeFileSync(path.join(directory, 'app.js'), app);
  fs.writeFileSync(path.join(directory, 'menu.js'), menu);
  return directory;
}

test('o nome do arquivo muda só quando o conteúdo muda', () => {
  const first = loadAssets(directoryWith('app-v1', 'menu-v1'));
  const same = loadAssets(directoryWith('app-v1', 'menu-v1'));
  const next = loadAssets(directoryWith('app-v2', 'menu-v1'));

  assert.deepEqual(first.manifest, same.manifest);
  assert.notEqual(first.manifest.app, next.manifest.app);
  assert.equal(first.manifest.menu, next.manifest.menu);
});

test('o manifesto aponta para o conteúdo servido', () => {
  const { manifest, files } = loadAssets(directoryWith('A', 'M'));
  assert.equal(files.get(manifest.app).toString(), 'A');
  assert.equal(files.get(manifest.menu).toString(), 'M');
  assert.match(manifest.app, /^app\.[0-9a-f]{12}\.js$/);
});

test('só aceita nomes de arquivo esperados', () => {
  assert.equal(parseAssetFile('manifest'), 'manifest');
  assert.equal(parseAssetFile('app.0123456789ab.js'), 'app.0123456789ab.js');
  for (const name of ['../server/index.js', 'app.js', 'app.xyz.js', 'outro.0123456789ab.js', undefined]) {
    assert.throws(() => parseAssetFile(name), String(name));
  }
});
