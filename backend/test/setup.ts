// Shared test setup — builds a temporary W3 Forge tree that mirrors the
// real layout, with a minimal config/apps/w3forge.yml and a scripts/
// directory containing harmless stub scripts that match the registry names.
// FORGE_ROOT is pointed at this tree via W3_FORGE_ROOT before importing
// any backend module.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeForgeTree(opts: { allowedScripts?: string[] } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  fs.mkdirSync(path.join(root, 'config', 'apps'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs', 'admin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), '0.4.0\n');

  const allowedScripts = opts.allowedScripts ?? [
    'w3-app-config-validate.sh',
    'w3-app-branch-check.sh',
    'w3-app-git-status.sh',
    'w3-app-status.sh',
    'w3-app-local-model-test.sh',
    'w3-app-inspect.sh',
    'w3-app-test.sh',
    'w3-app-workflow-status.sh',
    'w3-app-diff-summary.sh',
    'w3-app-review-report.sh',
    'w3-app-review-ready.sh'
  ];

  for (const name of allowedScripts) {
    const p = path.join(root, 'scripts', name);
    fs.writeFileSync(
      p,
      '#!/usr/bin/env bash\necho "stub: $0 $@"\nexit 0\n'
    );
    fs.chmodSync(p, 0o755);
  }

  const yml = [
    'app_id: w3forge',
    'name: W3 Forge',
    'version: 0.4.0',
    '',
    'repo:',
    '  default_dev_branch: dev/v0.4.0',
    "  allowed_branch_pattern: '^dev/v[0-9]+\\.[0-9]+\\.[0-9]+$'",
    '  blocked_branches:',
    '    - main',
    '    - master',
    '',
    'paths:',
    `  deploy: ${root}`,
    `  runtime: ${root}`,
    `  workspaces: ${root}`,
    `  scripts: ${path.join(root, 'scripts')}`,
    `  logs: ${path.join(root, 'logs')}`,
    `  backups: ${path.join(root, 'backups')}`,
    '',
    'authority:',
    '  may_deploy: false',
    '  may_tag_release: false',
    '  may_modify_production_data: false',
    '',
    'admin_console:',
    '  enabled: true',
    '  listen_host: 127.0.0.1',
    '  listen_port: 8765',
    '  audit_log: logs/admin/audit.jsonl',
    '  allowed_scripts:',
    ...allowedScripts.map((s) => `    - ${s}`),
    ''
  ].join('\n');

  fs.writeFileSync(path.join(root, 'config', 'apps', 'w3forge.yml'), yml);
  return root;
}
