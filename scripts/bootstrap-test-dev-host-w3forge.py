#!/usr/bin/env python3
"""Owner-approved, one-time Forge Test Dev host setup. No app deploy or restart."""
import argparse
import datetime
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import shlex
import shutil
import stat
import subprocess
import tempfile

BUNDLE = Path('/home/forgeadmin/w3forge-host-setup/9b6c13aae7ff')
HELPERS = Path('/opt/w3forge-testdev-helpers/9b6c13aae7ff')
BASE = Path('/var/lib/w3forge-test')
CACHE_BASE = Path('/var/cache/w3forge-test')
SNAPSHOTS = BASE / 'snapshots'
CACHE = CACHE_BASE / 'cache'
DEPLOY = Path('/opt/w3forge-deploy')
RUNTIME = Path('/opt/w3forge')
ENV_FILE = Path('/etc/w3forge/admin.env')
DATA = Path('/opt/w3forge-data')
BRIDGE = Path('/opt/w3forge-scripts/pipeline-test-dev-branch-w3forge-ui.sh')
BUILD_USER = 'w3forge-testbuild'
NPM = Path('/usr/lib/node_modules/npm/bin/npm-cli.js')
PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
REVIEWED = {
    'scripts/admin-console.cjs': '8824e0b34fe177e11eed32d3bcc7a76cdfd31bb08061cd091e770caeaa73dbea',
    'scripts/admin/test-dev-host.cjs': '4215aba6342a79aacf6e8cd569e1bb0e7331dda9326e9c564671e5776b2c442f',
    'scripts/admin/test-dev-snapshot.cjs': 'a97a2c1857afe0dd1cb5c65b0b7a0226f035f45a9c6244fafe2eb158856a0f17',
    'scripts/admin/pipeline-test-dev-branch-w3forge-ui.sh': 'c411c30d5e01fb34358f17a359ae3b5bed44f73a2cf3d6d76bb4e5f631e71e3a',
    'scripts/admin/_w3forge-policy.cjs': '7e7f53e988ce3cf388a57ddc25957c401679aac04feb7143031191ee6d5a59b9',
    'scripts/admin/_w3forge-policy.sh': 'c549221bf31570cc3e8e92dca9e06597f436e125dc86acaa5cb0c6bf720e6717',
    'scripts/admin/_w3forge-log.sh': '4227187dd5fe8e427a4223bb92c99a539c3283835295edda3f5e42812d7ec7e5',
    'scripts/admin/_w3forge-pipeline-common.sh': '3847974f6a3dba7579a61032b4a606d67821a02a5e2a1d26557e4d5cae367340',
}
BINDINGS = {
    'W3_TEST_INSTALLATION_ID': 'w3forge-host-v1',
    'W3_TEST_BUILD_USER': BUILD_USER,
    'W3_TEST_PRODUCTION_USER': 'root',
    'W3_TEST_SNAPSHOT_ROOT': str(SNAPSHOTS),
    'W3_TEST_CACHE_ROOT': str(CACHE),
    'W3_TEST_NPM_CLI': str(NPM),
    'W3_TEST_CACHE_EPOCH': '1',
}


def fail(message):
    raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    st = path.lstat()
    if path.resolve() != path or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        fail('Regular canonical file required: ' + str(path))
    return st


def protected(path):
    for current in (path, *path.parents):
        st = current.lstat()
        if current.resolve() != current or st.st_uid != 0 or st.st_mode & 0o022:
            fail('Protected root ownership required: ' + str(current))
        if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
            fail('Special host path refused: ' + str(current))


def directory(path, uid=0, gid=0, mode=0o755):
    protected(path.parent)
    if path.exists():
        st = path.lstat()
        if path.resolve() != path or not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or st.st_gid != gid or stat.S_IMODE(st.st_mode) != mode:
            fail('Existing directory differs from approved ownership/mode: ' + str(path))
    else:
        path.mkdir(mode=mode)
        os.chown(path, uid, gid)
        os.chmod(path, mode)


def atomic(path, data, mode, uid=0, gid=0):
    protected(path.parent)
    if path.exists():
        regular(path)
        if path.lstat().st_uid != 0:
            fail('Existing host file is not root-owned: ' + str(path))
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), uid, gid)
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def command(args, **kwargs):
    return subprocess.run(args, check=True, env={'PATH': PATH, 'LANG': 'C.UTF-8'}, **kwargs)


def service_state():
    return command(['/usr/bin/systemctl', 'show', 'w3forge.service', '--property=MainPID', '--property=ExecMainStartTimestamp', '--property=ActiveState'], capture_output=True, text=True).stdout


def helper_bytes():
    result = {}
    for name, expected in REVIEWED.items():
        source = BUNDLE / name
        before = regular(source)
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            data = stream.read(1024 * 1024)
            after = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or len(data) != before.st_size or digest(data) != expected:
            fail('Reviewed helper checksum mismatch: ' + name)
        result[Path(name).name] = data
    return result


def parser_modes():
    package = RUNTIME / 'node_modules/yaml'
    paths = [package, *package.parents]
    paths.extend(package.rglob('*'))
    changes = []
    for item in paths:
        st = item.lstat()
        if item.resolve() != item or st.st_uid != 0 or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
            fail('Unsafe runtime YAML input: ' + str(item))
        if st.st_mode & 0o022:
            if item != RUNTIME and RUNTIME not in item.parents:
                fail('Unexpected writable system ancestor: ' + str(item))
            changes.append({'path': str(item), 'mode': stat.S_IMODE(st.st_mode), 'after': stat.S_IMODE(st.st_mode) & ~0o022, 'dev': st.st_dev, 'ino': st.st_ino})
    return changes


def append_bindings(data):
    text = data.decode('utf-8')
    values = {}
    for line in text.splitlines():
        for key in BINDINGS:
            if line.startswith(key + '='):
                if key in values:
                    fail('Duplicate Test Dev environment binding: ' + key)
                words = shlex.split(line.split('=', 1)[1], comments=True)
                values[key] = words[0] if len(words) == 1 else ''
    for key, value in values.items():
        if value != BINDINGS[key]:
            fail('Existing Test Dev binding requires owner reconciliation: ' + key)
    additions = [key + '=' + value for key, value in BINDINGS.items() if key not in values]
    if not additions:
        return data
    return (text.rstrip('\n') + '\n\n# Owner-approved isolated Test Dev host bindings\n' + '\n'.join(additions) + '\n').encode()


def bridge_bytes():
    fields = {
        'PATH': PATH, 'LANG': 'C.UTF-8', 'HOME': '/root',
        'W3_FORGE_ROOT': str(DEPLOY), 'W3_DEPLOY_DIR': str(DEPLOY),
        'W3_APP_CONFIG_DIR': str(DEPLOY / 'config/apps'), 'W3_ACTIVE_APP_ID': 'w3forge',
        'W3_APP_DIR': str(RUNTIME), 'W3_DATA_DIR': str(DATA), 'W3_ENV_FILE': str(ENV_FILE),
        'W3_SCRIPTS_DIR': str(BRIDGE.parent), 'W3_SCRIPT_DIR': str(BRIDGE.parent),
        'W3_LOG_ROOT': '/opt/logs/w3forge', 'W3_LOG_DIR': '/opt/logs/w3forge', 'W3LOG_ROOT': '/opt/logs/w3forge',
        'W3_UPDATE_DIR': '/opt/w3forge-update-packages', 'W3_BACKUPS_DIR': '/opt/backups/w3forge',
        'W3_BACKUP_DIR': '/opt/backups/w3forge', 'W3_SERVICE_NAME': 'w3forge.service',
        **BINDINGS,
    }
    lines = ['#!/bin/sh', '# Reviewed temporary bridge for the pre-v0.4.3 console; normal deployment replaces it.', 'set -eu', '[ "$(/usr/bin/id -u)" = 0 ] || { echo "Test Dev requires its trusted host supervisor." >&2; exit 1; }', 'exec /usr/bin/env -i \\']
    lines.extend('  ' + shlex.quote(key + '=' + value) + ' \\' for key, value in fields.items())
    lines.extend(['  "W3_TEST_OWNER_PID=$PPID" \\', '  /bin/bash ' + shlex.quote(str(HELPERS / BRIDGE.name)) + ' "$@"', ''])
    return '\n'.join(lines).encode()


def rollback(backup):
    if backup.resolve() != backup or backup.parent != BASE / 'bootstrap':
        fail('Rollback directory is outside the dedicated backup root.')
    protected(backup)
    record = json.loads((backup / 'record.json').read_text())
    for entry in record['files']:
        target = Path(entry['path'])
        if target not in (BRIDGE, ENV_FILE) or digest(target.read_bytes()) != entry['installed_sha256']:
            fail('Host file changed after bootstrap; refusing to overwrite: ' + str(target))
    for entry in record['modes']:
        st = Path(entry['path']).lstat()
        if (st.st_dev, st.st_ino, stat.S_IMODE(st.st_mode)) != (entry['dev'], entry['ino'], entry['after']):
            fail('Runtime parser input changed; refusing automatic permission rollback.')
    for entry in record['files']:
        atomic(Path(entry['path']), (backup / entry['backup']).read_bytes(), entry['mode'], entry['uid'], entry['gid'])
    for entry in reversed(record['modes']):
        os.chmod(entry['path'], entry['mode'])
    print('Rollback restored prior wrapper, environment file and parser modes. The dedicated account/cache/helpers remain for owner review.')


def restore_setup(backup, record, changed_modes):
    """Undo a partially applied setup before any acceptance test has started."""
    for entry in record['files']:
        atomic(Path(entry['path']), (backup / entry['backup']).read_bytes(), entry['mode'], entry['uid'], entry['gid'])
    for entry in reversed(changed_modes):
        st = Path(entry['path']).lstat()
        if (st.st_dev, st.st_ino) != (entry['dev'], entry['ino']):
            fail('Parser identity changed during setup; use the recorded backup for owner recovery.')
        os.chmod(entry['path'], entry['mode'])


def apply(run_test):
    before_service = service_state()
    if 'ActiveState=active' not in before_service:
        fail('Forge service must be active before host setup.')
    service_user = command(['/usr/bin/systemctl', 'show', 'w3forge.service', '--property=User', '--value'], capture_output=True, text=True).stdout.strip()
    if service_user != 'root':
        fail('Production service identity differs from the reviewed root installation.')
    for item in (DEPLOY, DATA, BRIDGE.parent, ENV_FILE.parent):
        if item.resolve() != item or not stat.S_ISDIR(item.lstat().st_mode):
            fail('Canonical installation directory required: ' + str(item))
    protected(BRIDGE.parent)
    for binary in (NPM, Path('/usr/bin/node').resolve(), Path('/usr/sbin/runuser').resolve(), Path('/usr/bin/git').resolve()):
        protected(binary)
    env_stat = regular(ENV_FILE)
    if env_stat.st_uid != 0 or env_stat.st_mode & 0o022:
        fail('Production environment must already have protected root ownership.')
    regular(BRIDGE)
    if BRIDGE.lstat().st_uid != 0:
        fail('Installed Test Dev wrapper must be root-owned.')
    payload = helper_bytes()
    new_env = append_bindings(ENV_FILE.read_bytes())
    modes = parser_modes()
    try:
        build = pwd.getpwnam(BUILD_USER)
    except KeyError:
        try:
            grp.getgrnam(BUILD_USER)
            fail('Build group exists without its approved account.')
        except KeyError:
            pass
        command(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', BUILD_USER])
        build = pwd.getpwnam(BUILD_USER)
    if build.pw_uid == 0 or build.pw_gid == 0 or not build.pw_shell.endswith(('/nologin', '/false')) or set(os.getgrouplist(BUILD_USER, build.pw_gid)) != {build.pw_gid}:
        fail('Build account must be nonroot, nonlogin and have only its own primary group.')
    for flag, target in (('-r', ENV_FILE), ('-x', DATA), ('-w', RUNTIME), ('-w', BRIDGE.parent)):
        result = subprocess.run(['/usr/sbin/runuser', '--user', BUILD_USER, '--', '/usr/bin/test', flag, str(target)], env={'PATH': PATH}, check=False)
        if result.returncode != 1:
            fail('Build account isolation failed for ' + str(target))
    directory(BASE)
    directory(BASE / 'bootstrap', mode=0o700)
    directory(SNAPSHOTS, mode=0o711)
    directory(CACHE_BASE)
    directory(CACHE, build.pw_uid, build.pw_gid, 0o700)
    if any(SNAPSHOTS.iterdir()):
        fail('Existing test snapshots require operator recovery; none were removed.')
    directory(HELPERS.parent)
    directory(HELPERS)
    for name, content in payload.items():
        destination = HELPERS / name
        if destination.exists() and digest(destination.read_bytes()) != digest(content):
            fail('Existing versioned helper differs from the reviewed bytes: ' + name)
        atomic(destination, content, 0o755 if name.endswith('.sh') and not name.startswith('_') else 0o644)
    backup = Path(tempfile.mkdtemp(prefix=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ-'), dir=BASE / 'bootstrap'))
    os.chmod(backup, 0o700)
    new_bridge = bridge_bytes()
    record = {'service_before': before_service, 'files': [], 'modes': modes, 'helpers': str(HELPERS), 'reviewed': REVIEWED}
    for target, data in ((BRIDGE, new_bridge), (ENV_FILE, new_env)):
        st = regular(target)
        name = target.name + '.before'
        shutil.copy2(target, backup / name)
        os.chmod(backup / name, 0o600)
        record['files'].append({'path': str(target), 'backup': name, 'mode': stat.S_IMODE(st.st_mode), 'uid': st.st_uid, 'gid': st.st_gid, 'installed_sha256': digest(data)})
    (backup / 'record.json').write_text(json.dumps(record, indent=2) + '\n')
    print('Recovery record: ' + str(backup), flush=True)
    changed_modes = []
    try:
        for item in modes:
            st = Path(item['path']).lstat()
            if (st.st_dev, st.st_ino, st.st_uid) != (item['dev'], item['ino'], 0):
                fail('Parser identity changed before applying its recorded mode correction.')
            os.chmod(item['path'], item['after'])
            changed_modes.append(item)
        atomic(ENV_FILE, new_env, stat.S_IMODE(env_stat.st_mode), env_stat.st_uid, env_stat.st_gid)
        atomic(BRIDGE, new_bridge, 0o755)
        # The same installed canonical guard runs before help. No npm/development code runs here.
        checked = subprocess.run([str(BRIDGE), '--help'], env={'PATH': PATH, 'LANG': 'C.UTF-8'}, capture_output=True, text=True)
        if checked.returncode != 0:
            print(checked.stderr, end='')
            fail('Installed guard preflight failed.')
        if service_state() != before_service:
            fail('Service identity changed during host setup; review before continuing.')
    except Exception:
        restore_setup(backup, record, changed_modes)
        print('Prior wrapper, settings and changed parser modes restored. Backup: ' + str(backup), flush=True)
        raise
    print('Host setup installed. Backup/rollback record: ' + str(backup), flush=True)
    result = 0
    if run_test:
        request = 'req_bootstrap_' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        result = subprocess.run([str(BRIDGE), '--yes', '--source', 'cli', '--request-id', request], env={'PATH': PATH, 'LANG': 'C.UTF-8'}, check=False).returncode
    if service_state() != before_service:
        fail('Service identity changed; no restart was requested by this setup.')
    print('Live Forge service PID/start time unchanged. No application deployment or database operation performed.')
    print('Rollback: python3 /root/w3forge-testdev-bootstrap.py --rollback ' + str(backup))
    if result:
        fail('Host setup is installed, but isolated Test Dev failed; retain its log for diagnosis.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--test', action='store_true')
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        fail('Run the checked, root-owned copy from an existing root session.')
    protected(Path(__file__).resolve())
    if args.rollback:
        rollback(args.rollback)
    elif args.apply:
        apply(args.test)
    else:
        parser.print_help()
        print('No changes made. Use --apply --test for the approved host setup and isolated acceptance run.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print('BLOCKED: ' + str(error), file=__import__('sys').stderr)
        raise SystemExit(1)
