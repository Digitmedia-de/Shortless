/*
 * Builds browser-specific packages into dist/<target> and creates ZIPs
 * for store upload. Usage: node scripts/build.mjs
 */

import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const base = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const targets = {
  chrome: (m) => {
    // Chrome MV3 only supports background.service_worker
    delete m.background.scripts;
    return m;
  },
  firefox: (m) => {
    // Firefox MV3 only supports background.scripts
    delete m.background.service_worker;
    m.browser_specific_settings = {
      gecko: {
        id: 'shortless@digitmedia.de',
        strict_min_version: '121.0',
        // Required by addons.mozilla.org: Shortless collects no data at all.
        // https://mzl.la/firefox-builtin-data-consent
        data_collection_permissions: {
          required: ['none']
        }
      }
    };
    return m;
  },
  safari: (m) => m // safari-web-extension-converter accepts both keys
};

rmSync(DIST, { recursive: true, force: true });

for (const [name, transform] of Object.entries(targets)) {
  const dir = join(DIST, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'icons'), join(dir, 'icons'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(transform(structuredClone(base)), null, 2) + '\n');

  const zipName = `shortless-${name}-${base.version}.zip`;
  try {
    execSync(`zip -qr "../${zipName}" .`, { cwd: dir, stdio: 'inherit' });
    console.log(`✓ dist/${name} + dist/${zipName}`);
  } catch {
    console.warn(`✓ dist/${name} (zip skipped – "zip" not available)`);
  }
}
