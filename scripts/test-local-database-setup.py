#!/usr/bin/env python3
"""Pure operator-setup tests: no root, package, service or database operation."""
import importlib.util
from pathlib import Path
import unittest
import sys
sys.dont_write_bytecode = True
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('forge_database_setup', Path(__file__).with_name('bootstrap-local-database-w3forge.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
PASSWORD = 'a' * 64


class DatabaseSetupTests(unittest.TestCase):
    def test_unrelated_environment_bytes_are_preserved(self):
        original = b'# private configuration\r\nCORE_APP_CLIENT_SECRET="fixture-only"\r\nADMIN_LISTEN_PORT=8765\r\n'
        updated = setup.append_bindings(original, PASSWORD)
        self.assertTrue(updated.startswith(original))
        self.assertEqual(updated.count(b'CORE_APP_CLIENT_SECRET='), 1)
        self.assertIn(b'FORGE_DATABASE_PASSWORD=' + PASSWORD.encode() + b'\r\n', updated)
        self.assertNotIn(b'\n', updated.replace(b'\r\n', b''))

    def test_existing_empty_bindings_are_replaced_without_duplicates(self):
        original = b'CORE_API_URL=http://fixture\nFORGE_DATABASE_NAME=\nFORGE_DATABASE_PASSWORD=""\n'
        updated = setup.append_bindings(original, PASSWORD)
        parsed = setup.parse_environment(updated)
        self.assertEqual(parsed['FORGE_DATABASE_NAME'], 'w3forge')
        self.assertEqual(parsed['FORGE_DATABASE_PASSWORD'], PASSWORD)
        self.assertEqual(updated.count(b'FORGE_DATABASE_NAME='), 1)
        self.assertEqual(updated.count(b'FORGE_DATABASE_PASSWORD='), 1)

    def test_repeated_binding_application_is_identical(self):
        once = setup.append_bindings(b'CORE_APP_CLIENT_SECRET=fixture\n', PASSWORD)
        self.assertEqual(setup.append_bindings(once, PASSWORD), once)

    def test_remote_urls_and_conflicting_targets_are_rejected(self):
        cases = [
            {'FORGE_DATABASE_URL': 'postgresql://fixture/other'},
            {'DATABASE_URL': 'postgresql://fixture/w3forge'},
            {'W3FORGE_DB_URL': 'postgresql://fixture/w3forge'},
            {'FORGE_DATABASE_HOST': 'remote.fixture'},
            {'FORGE_DATABASE_PORT': '5433'},
            {'FORGE_DATABASE_NAME': 'w3core'},
            {'DATABASE_NAME': 'w3buildcost'},
            {'FORGE_DATABASE_USER': 'postgres'},
        ]
        for values in cases:
            with self.subTest(keys=list(values)), self.assertRaises(RuntimeError):
                setup.validate_bindings(values)

    def test_existing_password_requires_same_recovery_secret(self):
        with self.assertRaises(RuntimeError):
            setup.validate_bindings({'FORGE_DATABASE_PASSWORD': 'existing'})
        setup.validate_bindings({'FORGE_DATABASE_PASSWORD': PASSWORD}, PASSWORD)
        with self.assertRaises(RuntimeError):
            setup.validate_bindings({'FORGE_DATABASE_PASSWORD': 'b' * 64}, PASSWORD)

    def test_duplicate_database_bindings_are_rejected(self):
        with self.assertRaises(RuntimeError):
            setup.parse_environment(b'FORGE_DATABASE_NAME=w3forge\nFORGE_DATABASE_NAME=w3core\n')

    def test_explicit_connection_options_are_not_overwritten(self):
        setup.validate_bindings({'PGSSLMODE': ''})
        for value in ['require', 'verify-full', 'invalid', ' ']:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                setup.validate_bindings({'PGSSLMODE': value})
        with self.assertRaises(RuntimeError):
            setup.validate_bindings({'PGSERVICE': 'another-database'})

    def test_role_secret_format_and_privilege_restrictions(self):
        sql = setup.role_sql(PASSWORD)
        for restriction in ['NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'INHERIT', 'NOREPLICATION', 'NOBYPASSRLS']:
            self.assertIn(restriction, sql)
        for value in ['short', "a' OR TRUE--", 'g' * 64]:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                setup.role_sql(value)

    def test_listener_parser_includes_external_and_ipv6_bindings(self):
        output = 'LISTEN 0 200 127.0.0.1:5432 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:8765 0.0.0.0:*\nLISTEN 0 200 [::]:5432 [::]:*\n'
        self.assertEqual(setup.listener_addresses(output), ['127.0.0.1:5432', '[::]:5432'])

    def test_pending_atomic_install_recognizes_original_and_candidate(self):
        target = Path('/fixture/admin.env')
        original, candidate = b'old', b'new'
        for current in (original, candidate):
            state = {'files': {str(target): {'original_sha': setup.digest(original), 'installed_sha': setup.digest(candidate)}}}
            with self.subTest(current=current), patch.object(setup, 'read_regular', return_value=current), patch.object(setup, 'save_state'), patch.object(setup, 'atomic') as write:
                setup.install_recorded(state, target, candidate)
                write.assert_called_once_with(target, candidate, 0o600)

    def test_external_config_drift_prevents_install(self):
        target = Path('/fixture/admin.env')
        state = {'files': {str(target): {'original_sha': setup.digest(b'old'), 'installed_sha': setup.digest(b'new')}}}
        with patch.object(setup, 'read_regular', return_value=b'external'), patch.object(setup, 'atomic') as write:
            with self.assertRaises(RuntimeError):
                setup.install_recorded(state, target, b'new')
            write.assert_not_called()

    def test_rollback_checks_all_files_before_restoring_any(self):
        state = {'files': {}, 'service_before': 'fixture-service'}
        values = {}
        for target, name in [(setup.ENV_FILE, 'admin.env.before'), (setup.POLICY, 'policy.sh.before')]:
            state['files'][str(target)] = {'backup': name, 'original_sha': setup.digest(b'old'),
                                          'installed_sha': setup.digest(b'new'), 'mode': 0o600, 'uid': 0, 'gid': 0}
            values[target] = b'new'
            values[setup.BASE / name] = b'old'
        values[setup.POLICY] = b'external'
        with patch.object(setup, 'service_identity', return_value='fixture-service'), patch.object(setup, 'read_regular', side_effect=lambda target: values[target]), patch.object(setup, 'atomic') as write:
            with self.assertRaises(RuntimeError):
                setup.rollback(state)
            write.assert_not_called()

    def test_rollback_refuses_after_application_service_changes(self):
        with patch.object(setup, 'service_identity', return_value='later-service'), patch.object(setup, 'atomic') as write:
            with self.assertRaises(RuntimeError):
                setup.rollback({'service_before': 'original-service'})
            write.assert_not_called()


if __name__ == '__main__':
    unittest.main()
