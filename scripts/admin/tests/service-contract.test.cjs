'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const YAML=require('yaml');
const {configuration}=require('../_w3forge-policy.cjs');
const root=path.resolve(__dirname,'../../..');
const config=YAML.parse(fs.readFileSync(path.join(root,'config/apps/w3forge.yml'),'utf8'));

test('status and operational policy agree on the actual installed unit name',()=>{
  const {env}=require(path.join(root,'backend/dist/config/env.js'));
  assert.equal(env.serviceName,'w3forge.service');
  assert.equal(config.service.name,env.serviceName);
  for(const script of ['status-w3forge.sh','restart-w3forge-service.sh','deploy-w3forge.sh','backup-w3forge.sh']) {
    assert.equal(configuration(config,script,root,{}).variables.W3_SERVICE_NAME,env.serviceName);
    assert.throws(()=>configuration(config,script,root,{W3_SERVICE_NAME:'w3core.service'}),/another app/);
  }
  const withoutService={...config,service:{port:8765}};
  assert.equal(configuration(withoutService,'status-w3forge.sh',root,{}).variables.W3_SERVICE_NAME,env.serviceName);
});

test('standard unit uses the approved root terminal model at the separate runtime',()=>{
  const unit=fs.readFileSync(path.join(root,'config/systemd/w3forge.service'),'utf8');
  for(const line of ['User=root','Group=root','WorkingDirectory=/opt/w3forge','Environment=ADMIN_TERMINAL_ENABLED=true','EnvironmentFile=/etc/w3forge/admin.env']) {
    assert.ok(unit.split(/\r?\n/).includes(line),line);
  }
  assert.match(unit,/^ExecStart=.*\/opt\/w3forge\/scripts\/w3-admin-console\.sh --app w3forge --foreground$/m);
  assert.doesNotMatch(unit,/^ExecStart=.*w3forge-deploy/m);
});
