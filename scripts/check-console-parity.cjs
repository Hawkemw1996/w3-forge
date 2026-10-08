'use strict';
// Source identity checks supplement contract/browser tests; they do not replace them.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
let count = 0;
const shared = require('./admin-console.cjs').verify(root);
// The old frontend/backend provenance files are historical snapshots. Current
// code is verified against the single upstream commit/manifest instead.
for (const file of ['scripts/admin/console-provenance.json']) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const entry of manifest.files) {
    const target = path.resolve(root, entry.target);
    if (!target.startsWith(root + path.sep)) throw new Error('Invalid provenance target: ' + entry.target);
    if (hash(target) !== entry.sha256) throw new Error('Shared console source changed without parity review: ' + entry.target);
    count++;
  }
}
console.log('Verified ' + shared.files + ' upstream shared-console files at ' + shared.revision + ' and ' + count + ' app-owned operator scripts.');
