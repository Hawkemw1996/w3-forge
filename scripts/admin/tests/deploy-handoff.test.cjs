'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scripts = path.resolve(__dirname, '..');
const bash = process.env.W3_TEST_BASH || (process.platform === 'win32'
  ? path.resolve(path.dirname(process.execPath), '../../native/git/usr/bin/sh.exe') : '/bin/bash');
function detachedLaunch(home) {
  const source = fs.readFileSync(path.join(scripts, 'pipeline-deploy-dev-package-w3forge-ui.sh'), 'utf8').replaceAll('\r\n', '\n');
  // Execute the actual launch command with systemd-run replaced by an argv recorder.
  // The guard, delegate, service, database and system manager are never invoked.
  const start = source.indexOf('\nsystemd-run \\\n');
  const end = source.indexOf('\nLAUNCH_RC=$?', start);
  assert.ok(start >= 0 && end > start, 'Detached launch command is present');
  const body = [
    'set -euo pipefail',
    'systemd-run() { printf "%s\\0" "$@"; }',
    'UNIT_NAME=w3forge-deploy-req-fixture',
    'LOG_PATH="/fixture/log path/deploy.log"',
    'EXEC_STOP_POST=fixture-recorder',
    'PP_REQUEST_ID=req_fixture',
    'PP_SOURCE_TAG=ui',
    'DELEGATE="/fixture/scripts path/deploy-w3forge-noninteractive.sh"',
    'DELEGATE_ARGS=(--non-interactive --yes-i-understand-this-replaces-runtime --request-id req_fixture --source ui --channel main --version v0.4.3)',
    source.slice(start, end),
  ].join('\n');
  const env = { ...process.env };
  if (home === undefined) delete env.HOME; else env.HOME = home;
  const result = spawnSync(bash, ['-s'], { input: body, env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.split('\0').filter(Boolean);
}
for (const [label, home] of [['missing', undefined], ['root', '/root'], ['unexpected', '/tmp/untrusted caller home']]) {
  test('detached deployment supplies its fixed root HOME when caller HOME is ' + label, () => {
    const args = detachedLaunch(home);
    assert.deepEqual(args.filter(arg => arg.startsWith('--setenv=')), [
      '--setenv=HOME=/root', '--setenv=W3_REQUEST_ID=req_fixture', '--setenv=W3_SOURCE=ui',
    ]);
    assert.ok(args.includes('--no-block'));
    assert.ok(args.includes('--collect'));
    assert.ok(args.includes('--service-type=oneshot'));
    assert.ok(args.includes('--property=TimeoutStartSec=900'));
    assert.ok(args.includes('--property=StandardOutput=append:/fixture/log path/deploy.log'));
    assert.deepEqual(args.slice(args.indexOf('--') + 1), [
      '/fixture/scripts path/deploy-w3forge-noninteractive.sh', '--non-interactive',
      '--yes-i-understand-this-replaces-runtime', '--request-id', 'req_fixture',
      '--source', 'ui', '--channel', 'main', '--version', 'v0.4.3',
    ]);
  });
}
