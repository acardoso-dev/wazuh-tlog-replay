'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ASSET_NAMES = ['app', 'menu'];
const ASSET_FILE = /^(app|menu)\.[0-9a-f]{12}\.js$/;

/** Lê os scripts e dá a cada um um nome com o hash do conteúdo: nova versão, novo endereço. */
function loadAssets(directory) {
  const manifest = {};
  const files = new Map();
  for (const name of ASSET_NAMES) {
    const content = fs.readFileSync(path.join(directory, `${name}.js`));
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
    const fileName = `${name}.${hash}.js`;
    manifest[name] = fileName;
    files.set(fileName, content);
  }
  return { manifest, files };
}

function parseAssetFile(name) {
  if (name !== 'manifest' && !ASSET_FILE.test(String(name))) {
    throw new Error('arquivo inválido');
  }
  return name;
}

module.exports = { loadAssets, parseAssetFile };
