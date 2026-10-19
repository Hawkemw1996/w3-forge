#!/usr/bin/env python3
"""Nonroot PostgreSQL 16 configuration parser regression; never starts a server."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    'forge_database_setup', Path(__file__).with_name('bootstrap-local-database-w3forge.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
POSTGRES = '/usr/lib/postgresql/16/bin/postgres'


class NativeConfigurationTests(unittest.TestCase):
    def test_native_writer_failure_and_repair_with_real_postgres_parser(self):
        if os.geteuid() == 0:
            self.fail('Run this parser-only regression as a nonroot user.')
        with tempfile.TemporaryDirectory(prefix='w3forge-pg-config-test-') as folder:
            config = Path(folder) / 'postgresql.conf'
            config.write_bytes(b'# isolated parser fixture\n')
            for key, value in [('listen_addresses', setup.HOST), ('port', setup.PORT),
                               ('password_encryption', 'scram-sha-256')]:
                subprocess.run(['pg_conftool', str(config), 'set', key, value],
                               env=setup.clean_env(), check=True, capture_output=True)
            command = [POSTGRES, '-D', folder, '-c', 'config_file=' + str(config), '-C']
            broken = subprocess.run(command + ['listen_addresses'],
                                    env=setup.clean_env(), capture_output=True, text=True)
            self.assertNotEqual(broken.returncode, 0)
            self.assertIn('syntax error', broken.stderr)
            config.write_bytes(setup.quote_loopback_address(config.read_bytes()))
            for key, expected in [('listen_addresses', setup.HOST), ('port', setup.PORT),
                                  ('password_encryption', 'scram-sha-256')]:
                parsed = subprocess.run(command + [key], env=setup.clean_env(),
                                        check=True, capture_output=True, text=True)
                self.assertEqual(parsed.stdout.strip(), expected)


if __name__ == '__main__':
    unittest.main()
