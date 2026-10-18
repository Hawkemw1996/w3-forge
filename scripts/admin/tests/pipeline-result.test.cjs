'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const { parseStructuredTrailer, resolveStructuredStatus } = require(path.join(root, 'backend/dist/console/controls/safeRunner.js'));
const common = path.join(root, 'scripts/admin/_w3forge-pipeline-common.sh').replaceAll('\\', '/');
const bash = process.env.W3_TEST_BASH || (process.platform === 'win32'
  ? path.resolve(path.dirname(process.execPath), '../../native/git/usr/bin/sh.exe') : '/bin/bash');
const requestId = 'req_package_result_contract';
function emitted(code, status = 'success') {
  const body = [
    'set -euo pipefail',
    'source "$1"',
    'PP_REQUEST_ID=delegate_request',
    'pp_emit_success "packaged w3forge.tar.gz"',
    'PP_REQUEST_ID=req_package_result_contract',
    'PP_RES_CHANNEL=dev',
    'PP_RES_VERSION=v0.4.3',
    'PP_RES_PACKAGE_PATH=/fixture/dev/v0.4.3/w3forge.tar.gz',
    'if [[ "$2" == unset ]]; then unset PP_RES_DELEGATE_EXIT_CODE; elif [[ "$2" != default ]]; then PP_RES_DELEGATE=fixture-delegate; PP_RES_DELEGATE_EXIT_CODE="$2"; fi',
    'pp_emit_result "$3" "packaged w3forge.tar.gz" "output_path=$PP_RES_PACKAGE_PATH" bytes=870974',
  ].join('\n');
  const result = spawnSync(bash, ['-s', '--', common, code, status], { input: body, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal((result.stdout.match(/===STRUCTURED-RESULT===/g) || []).length, 2);
  return result.stdout;
}
test('package results without a delegate omit its exit code and resolve the last trailer successfully', () => {
  for (const code of ['default', 'unset']) {
    const stdout = emitted(code), parsed = parseStructuredTrailer(stdout);
    assert.doesNotMatch(stdout, /^delegate_exit_code=/m);
    assert.equal(Object.hasOwn(parsed, 'delegate_exit_code'), false);
    assert.equal(parsed.request_id, requestId);
    assert.equal(parsed.output_path, '/fixture/dev/v0.4.3/w3forge.tar.gz');
    assert.equal(parsed.bytes, 870974);
    assert.equal(resolveStructuredStatus(parsed, 0, requestId), 'success');
  }
});
test('delegate exit codes remain explicit and the installed backend rejects failed or malformed results', () => {
  for (const code of ['0', '9', 'invalid', ' ']) {
    const stdout = emitted(code), parsed = parseStructuredTrailer(stdout);
    assert.ok(stdout.includes('delegate_exit_code=' + code + '\n'));
    assert.equal(parsed.delegate_exit_code, code.trim());
    assert.equal(resolveStructuredStatus(parsed, 0, requestId), code === '0' ? 'success' : 'failed');
  }
});
test('an explicitly empty exit code remains invalid input to the strict backend', () => {
  const stdout = emitted('default').replace(/===END===\s*$/, 'delegate_exit_code=\n===END===\n');
  assert.equal(resolveStructuredStatus(parseStructuredTrailer(stdout), 0, requestId), 'failed');
});
test('emitted results preserve failed status, process exit and request identity checks', () => {
  assert.equal(resolveStructuredStatus(parseStructuredTrailer(emitted('default', 'failed')), 0, requestId), 'failed');
  const parsed = parseStructuredTrailer(emitted('default'));
  assert.equal(resolveStructuredStatus(parsed, 7, requestId), 'failed');
  assert.equal(resolveStructuredStatus(parsed, 0, 'foreign_request'), 'failed');
});
