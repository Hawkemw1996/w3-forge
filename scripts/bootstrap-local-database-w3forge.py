#!/usr/bin/env python3
"""Owner-approved local Forge database provisioning; no app deploy or migrations."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import tempfile

BASE = Path('/var/lib/w3forge-test/local-database-v1')
ENV_FILE = Path('/etc/w3forge/admin.env')
POLICY = Path('/opt/w3forge-scripts/_w3forge-policy.sh')
STAGED_POLICY = Path('/home/forgeadmin/w3forge-database-setup/420c4f33dfad/_w3forge-policy.sh')
POLICY_OLD = 'c549221bf31570cc3e8e92dca9e06597f436e125dc86acaa5cb0c6bf720e6717'
POLICY_NEW = '420c4f33dfad83788e01934b4e1b03c7a053e02d08cf1183f8417ea67f0eb0d0'
MAINTAINER = Path('/usr/share/postgresql-common/maintscripts-functions')
MAINTAINER_SHA = 'ded9ea805f2dab3f3bcce35965d78622be15ac31565ec6a547db67a943ea3cad'
START_POLICY = Path('/usr/sbin/policy-rc.d')
DENY_START = b'#!/bin/sh\nexit 101\n'
CONFIG = Path('/etc/postgresql/16/main')
DATA = Path('/var/lib/postgresql/16/main')
BACKUPS = Path('/opt/backups/w3forge')
PATH = '/usr/sbin:/usr/bin:/sbin:/bin'
HOST, PORT, DATABASE, ROLE = '127.0.0.1', '5432', 'w3forge', 'w3forge_user'
BINDINGS = {'FORGE_DATABASE_HOST': HOST, 'FORGE_DATABASE_PORT': PORT,
            'FORGE_DATABASE_NAME': DATABASE, 'FORGE_DATABASE_USER': ROLE}
HBA = b'''# Dedicated, owner-approved Forge cluster: peer administration and local SCRAM.
local all postgres peer
local w3forge w3forge_user scram-sha-256
host w3forge w3forge_user 127.0.0.1/32 scram-sha-256
'''


def fail(message):
    raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def protected(path, owners=(0,)):
    for current in (path, *path.parents):
        st = current.lstat()
        if current.resolve() != current or st.st_uid not in owners or st.st_mode & 0o022:
            fail('Unsafe ownership, permissions or linked path: ' + str(current))
        if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
            fail('Special host path refused: ' + str(current))


def read_regular(path, owners=(0,)):
    protected(path, owners)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail('Single regular file required: ' + str(path))
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read()
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            fail('Input changed during inspection: ' + str(path))
        return data
    finally:
        os.close(fd)


def atomic(path, content, mode=0o600, uid=0, gid=0):
    fd, name = tempfile.mkstemp(prefix='.w3forge-database-', dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def native(argv, *, sql=None, env=None, timeout=30, log=None):
    result = subprocess.run(argv, input=sql, text=True, encoding='utf-8',
                            errors='replace', stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env or clean_env(), timeout=timeout, check=False)
    if log:
        atomic(log, (result.stdout + result.stderr).encode())
    if result.returncode:
        # Never print SQL, connection strings, passwords or raw child stderr.
        fail('Native command failed: ' + Path(argv[0]).name + ' (exit ' + str(result.returncode) + ')')
    return result.stdout.strip()


def clean_env():
    return {'PATH': PATH, 'HOME': '/root', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
            'PGCONNECT_TIMEOUT': '5'}


def parse_environment(content):
    result = {}
    for line in content.decode('utf-8').splitlines():
        match = re.fullmatch(r'([A-Z_][A-Z0-9_]*)=(.*)', line)
        if not match:
            continue
        key, value = match.groups()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key in result and (key.startswith(('FORGE_DATABASE_', 'DATABASE_', 'DB_', 'PG'))
                              or key == 'W3FORGE_DB_URL'):
            fail('Duplicate database binding: ' + key)
        result[key] = value
    return result


def validate_bindings(values, password=None):
    for key in ('FORGE_DATABASE_URL', 'DATABASE_URL', 'W3FORGE_DB_URL'):
        if values.get(key):
            fail('Existing database URL requires separate operator review: ' + key)
    expected = {
        'FORGE_DATABASE_HOST': (HOST, 'localhost'), 'DATABASE_HOST': (HOST, 'localhost'),
        'DB_HOST': (HOST, 'localhost'), 'W3_DB_HOST': (HOST, 'localhost'), 'PGHOST': (HOST, 'localhost'),
        'FORGE_DATABASE_PORT': (PORT,), 'DATABASE_PORT': (PORT,), 'DB_PORT': (PORT,), 'PGPORT': (PORT,),
        'FORGE_DATABASE_NAME': (DATABASE,), 'DATABASE_NAME': (DATABASE,), 'DB_NAME': (DATABASE,),
        'W3_DB_NAME': (DATABASE,), 'PGDATABASE': (DATABASE,),
        'FORGE_DATABASE_USER': (ROLE,), 'DATABASE_USER': (ROLE,), 'DB_USER': (ROLE,),
        'W3_DB_USER': (ROLE,), 'PGUSER': (ROLE,),
    }
    for key, allowed in expected.items():
        if values.get(key) and values[key] not in allowed:
            fail('Conflicting existing database binding: ' + key)
    for key in ('FORGE_DATABASE_PASSWORD', 'DATABASE_PASSWORD', 'DB_PASSWORD', 'PGPASSWORD'):
        if values.get(key) and values[key] != password:
            fail('Existing database credentials require separate operator review: ' + key)
    for key, value in values.items():
        if key.startswith('PG') and key not in expected and key != 'PGPASSWORD' and value:
            fail('Explicit PostgreSQL connection option requires separate review: ' + key)


def append_bindings(content, password):
    values = parse_environment(content)
    validate_bindings(values, password)
    desired = {**BINDINGS, 'FORGE_DATABASE_PASSWORD': password}
    newline = b'\r\n' if b'\r\n' in content else b'\n'
    # Preserve every unrelated byte; replace only existing approved FORGE bindings.
    lines, seen = [], set()
    for line in content.splitlines(keepends=True):
        body = line.rstrip(b'\r\n')
        match = re.match(rb'([A-Z_][A-Z0-9_]*)=', body)
        key = match[1].decode('ascii') if match else None
        if key in desired:
            seen.add(key)
            if values[key] != desired[key]:
                line = (key + '=' + desired[key]).encode() + line[len(body):]
        lines.append(line)
    updated = b''.join(lines)
    missing = {key: value for key, value in desired.items() if key not in seen}
    if not missing:
        return updated
    suffix = b'' if not updated or updated.endswith(b'\n') else newline
    suffix += newline + b'# Owner-approved local Forge database' + newline
    suffix += newline.join((key + '=' + value).encode() for key, value in missing.items()) + newline
    return updated + suffix


def role_sql(password):
    if not re.fullmatch(r'[a-f0-9]{64}', password):
        fail('Invalid generated credential format.')
    return ("CREATE ROLE w3forge_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
            "INHERIT NOREPLICATION NOBYPASSRLS PASSWORD '" + password + "';\n")


def service_identity():
    return native(['systemctl', 'show', 'w3forge.service', '-p', 'MainPID',
                   '-p', 'ExecMainStartTimestamp', '-p', 'ActiveState', '--no-pager'])


def listener_addresses(output):
    result = []
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 4 and fields[3].endswith(':5432'):
            result.append(fields[3])
    return result


def listeners():
    return listener_addresses(native(['ss', '-H', '-lnt']))


def admin_sql(sql):
    return native(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-w', '-qAt',
                   '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-p', PORT,
                   '-U', 'postgres', '-d', 'postgres'], sql=sql)


def save_state(state):
    atomic(BASE / 'state.json', (json.dumps(state, indent=2) + '\n').encode())


def save_original(state, target, name, owners=(0,)):
    if str(target) in state['files']:
        return
    content = read_regular(target, owners)
    st = target.stat()
    atomic(BASE / name, content)
    state['files'][str(target)] = {'backup': name, 'original_sha': digest(content),
                                  'uid': st.st_uid, 'gid': st.st_gid,
                                  'mode': stat.S_IMODE(st.st_mode), 'installed_sha': None}
    save_state(state)


def install_recorded(state, target, content, mode=0o600):
    record = state['files'][str(target)]
    current = digest(read_regular(target))
    if current not in (record['original_sha'], record['installed_sha']):
        fail('Configuration changed outside this setup: ' + str(target))
    # Persist intent before replacement; a resume may recognize either exact copy.
    record['installed_sha'] = digest(content)
    save_state(state)
    atomic(target, content, mode)


def restore_start_policy(state):
    if not state.get('startup_policy_created'):
        return
    if START_POLICY.exists():
        if read_regular(START_POLICY) != DENY_START:
            fail('Startup policy changed; refusing to overwrite it.')
        active = subprocess.run(['pgrep', '-x', 'apt|apt-get|dpkg|dpkg-deb'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=clean_env(), check=False)
        if active.returncode == 0:
            fail('A package operation is still active; retaining startup protection.')
        START_POLICY.unlink()
    state['startup_policy_created'] = False
    save_state(state)


def install_server(state):
    if state.get('cluster'):
        return
    if list(Path('/etc/postgresql').glob('*/*/postgresql.conf')) or DATA.exists():
        fail('An unrecorded PostgreSQL cluster exists; operator review required.')
    if listeners():
        fail('Port 5432 is already in use.')
    if START_POLICY.exists() or START_POLICY.is_symlink():
        fail('An existing service startup policy requires separate review.')
    if digest(read_regular(MAINTAINER)) != MAINTAINER_SHA:
        fail('PostgreSQL package startup helper differs from the reviewed version.')
    state['phase'] = 'installing-server'
    save_state(state)
    print('[setup] Installing PostgreSQL 16; package service startup is temporarily blocked.', flush=True)
    apt_env = {**clean_env(), 'DEBIAN_FRONTEND': 'noninteractive', 'NEEDRESTART_MODE': 'l'}
    native(['apt-get', 'update'], env=apt_env, timeout=600, log=BASE / 'apt-update.log')
    state['startup_policy_created'] = True
    save_state(state)
    fd = os.open(START_POLICY, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(DENY_START)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        native(['apt-get', 'install', '-y', '--no-install-recommends', '--no-upgrade',
                'postgresql-16'], env=apt_env, timeout=900, log=BASE / 'apt-install.log')
    finally:
        restore_start_policy(state)
    if listeners():
        fail('A server started before reviewed configuration; operator review required.')
    import pwd
    pg = pwd.getpwnam('postgres')
    if not pg.pw_uid or not pg.pw_gid or pg.pw_dir != '/var/lib/postgresql':
        fail('Unexpected PostgreSQL system account.')
    if read_regular(DATA / 'PG_VERSION', (0, pg.pw_uid)).strip() != b'16':
        fail('Unexpected PostgreSQL cluster version.')
    configs = list(Path('/etc/postgresql').glob('*/*/postgresql.conf'))
    if configs != [CONFIG / 'postgresql.conf']:
        fail('Unexpected PostgreSQL cluster configuration.')
    data_st = DATA.stat()
    state['cluster'] = {'uid': pg.pw_uid, 'gid': pg.pw_gid,
                        'dev': data_st.st_dev, 'ino': data_st.st_ino}
    save_state(state)


def quote_loopback_address(content):
    """Correct only the known PgCommon dotted-number quoting defect."""
    active = re.findall(rb'(?m)^[ \t]*listen_addresses[ \t]*=', content)
    pattern = re.compile(
        rb"(?m)^([ \t]*listen_addresses[ \t]*=[ \t]*)"
        rb"(127[.]0[.]0[.]1|'127[.]0[.]0[.]1')"
        rb"([ \t]*(?:#[^\r\n]*)?)(\r?\n|$)")
    matches = list(pattern.finditer(content))
    if len(active) != 1 or len(matches) != 1:
        fail('Expected exactly one approved loopback listen_addresses setting.')
    match = matches[0]
    replacement = match[1] + b"'127.0.0.1'" + match[3] + match[4]
    return content[:match.start()] + replacement + content[match.end():]


def require_stopped_cluster():
    if listeners() or (DATA / 'postmaster.pid').exists():
        fail('Cluster must be stopped before the loopback quoting repair.')


def repair_loopback_quoting(state):
    target = CONFIG / 'postgresql.conf'
    record = state['files'][str(target)]
    content = read_regular(target, (0, state['cluster']['uid']))
    current_sha = digest(content)
    receipt = state.get('loopback_quote_repair')
    backup = BASE / 'postgresql.conf.unquoted.before'
    if receipt:
        original = read_regular(backup)
        candidate = quote_loopback_address(original)
        if (digest(original) != receipt['before_sha']
                or digest(candidate) != receipt['after_sha']
                or receipt['before_sha'] == receipt['after_sha']):
            fail('Loopback quoting recovery record failed its integrity check.')
        allowed = (receipt['before_sha'], receipt['after_sha'])
        if current_sha not in allowed or record['installed_sha'] not in allowed:
            fail('Cluster configuration changed outside the recorded quoting repair.')
    else:
        if current_sha != record['installed_sha']:
            fail('Cluster configuration changed outside this setup.')
        candidate = quote_loopback_address(content)
        if candidate == content:
            return
        require_stopped_cluster()
        if backup.exists():
            if read_regular(backup) != content:
                fail('Existing quoting repair backup differs from this configuration.')
        else:
            atomic(backup, content)
        receipt = {'before_sha': current_sha, 'after_sha': digest(candidate)}
        state['loopback_quote_repair'] = receipt
        save_state(state)
    if current_sha != receipt['after_sha']:
        require_stopped_cluster()
        print('[setup] Correcting only the recorded loopback address string quoting.', flush=True)
        atomic(target, candidate, record['mode'], record['uid'], record['gid'])
    record['installed_sha'] = receipt['after_sha']
    save_state(state)


def configure_server(state):
    pg = state['cluster']
    protected(DATA, (0, pg['uid']))
    st = DATA.stat()
    if (st.st_dev, st.st_ino) != (pg['dev'], pg['ino']):
        fail('PostgreSQL cluster identity changed.')
    if not state.get('server_configured'):
        if listeners():
            fail('Cluster must be stopped before initial configuration.')
        save_original(state, CONFIG / 'postgresql.conf', 'postgresql.conf.before', (0, pg['uid']))
        save_original(state, CONFIG / 'pg_hba.conf', 'pg_hba.conf.before', (0, pg['uid']))
        config_record = state['files'][str(CONFIG / 'postgresql.conf')]
        current = digest(read_regular(CONFIG / 'postgresql.conf', (0, pg['uid'])))
        if current not in (config_record['original_sha'], config_record['installed_sha']):
            fail('New cluster configuration changed outside this setup.')
        for key, value in [('listen_addresses', HOST), ('port', PORT),
                           ('password_encryption', 'scram-sha-256')]:
            native(['pg_conftool', '16', 'main', 'set', key, value])
            config_record['installed_sha'] = digest(read_regular(CONFIG / 'postgresql.conf', (0, pg['uid'])))
            save_state(state)
        hba_record = state['files'][str(CONFIG / 'pg_hba.conf')]
        if digest(read_regular(CONFIG / 'pg_hba.conf', (0, pg['uid']))) not in (hba_record['original_sha'], digest(HBA)):
            fail('New cluster authentication configuration changed outside this setup.')
        hba_record['installed_sha'] = digest(HBA)
        save_state(state)
        atomic(CONFIG / 'pg_hba.conf', HBA, 0o640, pg['uid'], pg['gid'])
        state['server_configured'] = True
        save_state(state)
    # PgCommon treats a dotted IPv4 address as numeric; quote it before parsing.
    hba_record = state['files'][str(CONFIG / 'pg_hba.conf')]
    if digest(read_regular(CONFIG / 'pg_hba.conf', (0, pg['uid']))) != hba_record['installed_sha']:
        fail('Recorded cluster authentication configuration changed outside this setup.')
    repair_loopback_quoting(state)
    for name in ('postgresql.conf', 'pg_hba.conf'):
        record = state['files'][str(CONFIG / name)]
        if digest(read_regular(CONFIG / name, (0, pg['uid']))) != record['installed_sha']:
            fail('Recorded cluster configuration changed outside this setup.')
    # Parse the entire real configuration without starting a database process.
    parsed = native(['runuser', '-u', 'postgres', '--', '/usr/lib/postgresql/16/bin/postgres',
                     '-D', str(DATA), '-c', 'config_file=' + str(CONFIG / 'postgresql.conf'),
                     '-C', 'listen_addresses'], log=BASE / 'postgres-config-check.log')
    if parsed != HOST:
        fail('PostgreSQL parsed an unexpected listen address.')
    print('[setup] Starting only the new loopback PostgreSQL cluster.', flush=True)
    native(['pg_ctlcluster', '16', 'main', 'start'], log=BASE / 'postgres-start.log') if not listeners() else None
    if listeners() != [HOST + ':' + PORT]:
        fail('PostgreSQL is not listening exclusively on the approved loopback address.')
    if admin_sql('SHOW listen_addresses;') != HOST or not admin_sql('SHOW server_version_num;').startswith('16'):
        fail('Unexpected active PostgreSQL server configuration.')


def create_database(state, password):
    roles = admin_sql("SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'postgres' ORDER BY 1;").splitlines()
    databases = admin_sql("SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1') ORDER BY 1;").splitlines()
    if any(name != ROLE for name in roles) or any(name != DATABASE for name in databases):
        fail('Unrelated role or database found in this new cluster.')
    if not state.get('role_oid'):
        if roles:
            fail('An unrecorded application role exists; its password will not be reset.')
        admin_sql(role_sql(password))
        state['role_oid'] = admin_sql("SELECT oid FROM pg_roles WHERE rolname='w3forge_user';")
        save_state(state)
    expected = state['role_oid'] + '|f|f|f|f|f|t|t|0'
    actual = admin_sql("SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin,(SELECT count(*) FROM pg_auth_members WHERE member=pg_roles.oid) FROM pg_roles WHERE rolname='w3forge_user';")
    if actual != expected:
        fail('The recorded application role changed.')
    if not state.get('database_oid'):
        if databases:
            fail('An unrecorded application database exists; it will not be adopted.')
        admin_sql("CREATE DATABASE w3forge OWNER w3forge_user TEMPLATE template0 ENCODING 'UTF8';")
        state['database_oid'] = admin_sql("SELECT oid FROM pg_database WHERE datname='w3forge';")
        save_state(state)
    if admin_sql("SELECT oid,pg_get_userbyid(datdba) FROM pg_database WHERE datname='w3forge';") != state['database_oid'] + '|' + ROLE:
        fail('The recorded application database identity or owner changed.')
    admin_sql('REVOKE ALL ON DATABASE w3forge FROM PUBLIC;')


def verify_connection(password):
    env = {**clean_env(), 'PGHOST': HOST, 'PGPORT': PORT, 'PGDATABASE': DATABASE,
           'PGUSER': ROLE, 'PGPASSWORD': password}
    result = native(['psql', '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1'], env=env,
                    sql="SELECT current_database(),current_user,current_setting('server_version_num'),inet_server_addr(),inet_server_port();")
    fields = result.split('|')
    if len(fields) != 5 or fields[:2] != [DATABASE, ROLE] or not fields[2].startswith('16') or fields[3:] != [HOST, PORT]:
        fail('Database connection identity did not match the approved target.')
    return fields[2]


def verify_backup(state):
    if BACKUPS.exists():
        protected(BACKUPS)
    before = set(BACKUPS.iterdir()) if BACKUPS.exists() else set()
    env = {**clean_env(), 'W3_FORGE_ROOT': '/opt/w3forge',
           'W3_DEPLOY_DIR': '/opt/w3forge-deploy', 'W3_APP_DIR': '/opt/w3forge',
           'W3_SCRIPTS_DIR': '/opt/w3forge-scripts', 'W3_BACKUPS_DIR': str(BACKUPS)}
    print('[setup] Verifying the existing mandatory local backup workflow.', flush=True)
    native(['/bin/bash', '/opt/w3forge-scripts/backup-w3forge.sh'], env=env,
           timeout=900, log=BASE / 'backup.log')
    protected(BACKUPS)
    fresh = set(BACKUPS.iterdir()) - before
    pairs = []
    for app in fresh:
        match = re.fullmatch(r'w3forge_app_([0-9_-]+)\.tar\.gz', app.name)
        if match:
            db = BACKUPS / ('w3forge_db_' + match[1] + '.sql')
            if db in fresh:
                pairs.append((app, db))
    if len(pairs) != 1:
        fail('Backup did not produce exactly one fresh application/database pair.')
    app, db = pairs[0]
    for item in (app, db):
        st = item.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size == 0:
            fail('Fresh backup has unsafe metadata or is empty.')
    native(['tar', '-tzf', str(app)], timeout=60)
    # This existing workflow writes plain SQL; pg_restore --list is for archive formats.
    sql = read_regular(db)
    if b'PostgreSQL database dump' not in sql or b'PostgreSQL database dump complete' not in sql:
        fail('Fresh SQL dump is missing its normal completion evidence.')
    state['backup_app'] = str(app)
    state['backup_db'] = str(db)
    state['backup_retention_removed'] = len(before - set(BACKUPS.iterdir()))
    save_state(state)


def rollback(state):
    if service_identity() != state['service_before']:
        fail('Application service changed; configuration rollback requires operator review.')
    for target in (ENV_FILE, POLICY):
        record = state['files'].get(str(target))
        if not record or not record['installed_sha']:
            continue
        if digest(read_regular(target)) != record['installed_sha']:
            fail('Rollback refused because installed configuration changed: ' + str(target))
        original = read_regular(BASE / record['backup'])
        if digest(original) != record['original_sha']:
            fail('Rollback backup integrity check failed.')
    for target in (ENV_FILE, POLICY):
        record = state['files'].get(str(target))
        if record and record['installed_sha']:
            atomic(target, read_regular(BASE / record['backup']), record['mode'], record['uid'], record['gid'])
    state['phase'] = 'configuration-rolled-back'
    save_state(state)
    print('Restored verified environment/helper backups. PostgreSQL, its database, role and recovery credentials were retained. No application restart or database deletion performed.')


def apply():
    protected(ENV_FILE)
    protected(POLICY)
    initial = read_regular(ENV_FILE)
    os_release = parse_environment(Path('/etc/os-release').read_bytes())
    if os_release.get('ID') != 'ubuntu' or os_release.get('VERSION_ID') != '24.04':
        fail('This reviewed setup targets Ubuntu 24.04 only.')
    if not BASE.exists():
        validate_bindings(parse_environment(initial))
        if listeners() or DATA.exists() or list(Path('/etc/postgresql').glob('*/*/postgresql.conf')):
            fail('Existing database service or cluster requires separate review.')
        if START_POLICY.exists() or START_POLICY.is_symlink():
            fail('Existing startup policy requires separate review.')
        protected(BASE.parent)
        BASE.mkdir(mode=0o700)
        state = {'schema': 1, 'phase': 'prepared', 'service_before': service_identity(),
                 'files': {}, 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        atomic(BASE / 'credentials.json', json.dumps({'database': DATABASE, 'role': ROLE,
                                                     'password': secrets.token_hex(32)}).encode())
        save_state(state)
    else:
        state = json.loads(read_regular(BASE / 'state.json'))
    protected(BASE)
    if stat.S_IMODE(BASE.stat().st_mode) != 0o700 or state.get('schema') != 1:
        fail('Unexpected recovery state.')
    import fcntl
    lock = os.open(BASE / 'lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        restore_start_policy(state)
        credentials = json.loads(read_regular(BASE / 'credentials.json'))
        password = credentials.get('password', '')
        role_sql(password)
        if credentials.get('database') != DATABASE or credentials.get('role') != ROLE:
            fail('Recovery credentials target another database.')
        validate_bindings(parse_environment(read_regular(ENV_FILE)), password)
        if state.get('phase') == 'complete':
            verify_connection(password)
            print('Local Forge database setup is already complete; no changes made.')
            return
        if state.get('phase') == 'configuration-rolled-back':
            fail('Configuration was rolled back; operator review is required before resuming.')
        if service_identity() != state['service_before']:
            fail('Forge service changed since setup began; operator review required.')
        save_original(state, ENV_FILE, 'admin.env.before')
        save_original(state, POLICY, 'policy.sh.before')
        candidate = STAGED_POLICY.read_bytes()
        if digest(candidate) != POLICY_NEW or digest(read_regular(POLICY)) not in (POLICY_OLD, POLICY_NEW):
            fail('Reviewed database environment helper checksum mismatch.')
        atomic(BASE / 'policy.sh.reviewed', candidate)
        native(['bash', '-n', str(BASE / 'policy.sh.reviewed')])
        install_server(state)
        configure_server(state)
        create_database(state, password)
        version = verify_connection(password)
        install_recorded(state, ENV_FILE, append_bindings(read_regular(ENV_FILE), password))
        install_recorded(state, POLICY, read_regular(BASE / 'policy.sh.reviewed'), 0o644)
        verify_backup(state)
        if service_identity() != state['service_before']:
            fail('Forge service changed during setup; review before continuing.')
        state['phase'] = 'complete'
        save_state(state)
        print('===STRUCTURED-RESULT===')
        print('status=success\ndatabase=w3forge\nrole=w3forge_user\nhost=127.0.0.1\nport=5432')
        print('server_version_num=' + version)
        print('backup_app_path=' + state['backup_app'])
        print('backup_db_path=' + state['backup_db'])
        print('normal_backup_retention_removed=' + str(state['backup_retention_removed']))
        print('service_unchanged=true\nreason=Local database, connection and mandatory backup verified.')
        print('===END===')
        print('Configuration rollback: python3 /root/w3forge-database-setup.py --rollback')
        print('No application deployment, application restart, migrations or FIFO schema performed.')
    finally:
        restore_start_policy(state)
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    if args.apply == args.rollback:
        parser.error('Choose exactly one of --apply or --rollback.')
    if not hasattr(os, 'geteuid') or os.geteuid() != 0:
        fail('Root operator required; no changes made.')
    os.umask(0o077)
    if args.rollback:
        protected(BASE)
        import fcntl
        lock = os.open(BASE / 'lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            state = json.loads(read_regular(BASE / 'state.json'))
            restore_start_policy(state)
            rollback(state)
        finally:
            os.close(lock)
    else:
        apply()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        print('Setup stopped: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
        print('No automatic database deletion, package purge or application restart was performed. Review the protected recovery record before retrying.')
        raise SystemExit(1)
