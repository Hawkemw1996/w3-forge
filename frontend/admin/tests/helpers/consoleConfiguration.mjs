// Test-only installation data. Production still refuses to mount before the
// authenticated /api/admin/configuration response has passed its validator.
export function consoleConfiguration(id = 'w3buildcost', version = '0.0.1') {
  const names = { w3buildcost: 'W3 BuildCost', w3books: 'W3 Books', w3forge: 'W3 Forge' };
  const prefix = id.slice(2);
  const base = '/opt/' + id;
  const packages = base + '-update-packages';
  return {
    schema: 1, id, name: names[id], basePath: '/' + prefix,
    repository: 'https://github.com/Hawkemw1996/' + (id === 'w3forge' ? 'w3-forge' : id),
    branch: 'dev/v' + version, timeZone: 'America/Chicago', service: id,
    databaseName: id, permissionPrefix: prefix, adminPermission: prefix + ':admin',
    terminalTarget: id === 'w3forge' ? 'host' : 'container', durableOperations: true,
    paths: {
      runtime: base, deploy: base + '-deploy', scripts: base + '-scripts',
      data: base + '-data', backups: id === 'w3forge' ? '/opt/backups/w3forge' : base + '-backups',
      logs: '/opt/logs/' + id, packages, installed: packages + '/installed',
      dev: packages + '/dev', main: packages + '/main', review: base + '-cleanup-review'
    }
  };
}
export function consoleConfigurationPlugin(configuration) {
  return {
    name: 'test-only-console-installation',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/lib/appConfiguration.ts')) return null;
      return { code: code + '\nsetAdminConfiguration(' + JSON.stringify(configuration) + ');\n', map: null };
    }
  };
}
