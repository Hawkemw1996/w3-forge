import { beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeForgeTree } from './setup';
import { createCoreFixture } from './coreFixture';
import { type ForgeAppConfig } from '../src/admin/forgeConfig';
import { buildForgeGitRoutes, githubRepositoryUrl, type GitRunner } from '../src/admin/routes/forgeGitRoutes';
import { envelopeErrorHandler } from '../src/admin/envelope';

const cfg = { app_id: 'w3forge', name: 'W3 Forge', version: '0.4.1',
  repo: { url: 'https://github.com/Hawkemw1996/w3-forge.git', default_dev_branch: 'dev/v0.4.1', allowed_branch_pattern: '^dev/v', blocked_branches: ['main','master'] },
  paths: { deploy: '/forge', runtime: '/forge', workspaces: '/forge', scripts: '/forge/scripts', logs: '/forge/logs', backups: '/forge/backups' },
  authority: { may_deploy: false, may_tag_release: false, may_modify_production_data: false } } satisfies ForgeAppConfig;

function fixture(overrides: Record<string, {code:number;out:string}> = {}, config: ForgeAppConfig = cfg) {
  const answers: Record<string, {code:number;out:string}> = {
    'rev-parse --abbrev-ref HEAD': {code:0,out:'dev/v0.4.1\n'},
    'remote get-url origin': {code:0,out:'git@github.com:Hawkemw1996/w3-forge.git\n'},
    'status --short': {code:0,out:''},
    'rev-parse HEAD': {code:0,out:'a'.repeat(40)},
    'for-each-ref --format=%(refname:short) refs/heads refs/remotes/origin': {code:0,out:'main\ndev/v0.4.1\norigin/dev/v0.4.1\norigin/dev/v0.4.0\nfeature/test'},
    'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': {code:0,out:'origin/dev/v0.4.1'},
    'rev-list --left-right --count HEAD...@{upstream}': {code:0,out:'2\t1\n'},
    'ls-remote --exit-code --heads git@github.com:Hawkemw1996/w3-forge.git refs/heads/dev/v0.4.1': {code:0,out:'b'.repeat(40)+'\trefs/heads/dev/v0.4.1\n'},
    ...overrides
  };
  const git = vi.fn<GitRunner>(async (args) => answers[args.join(' ')] ?? {code:1,out:'private failure'});
  const app = express();
  app.use(express.json(), buildForgeGitRoutes({git,config:()=>config}), envelopeErrorHandler);
  return { app, git };
}
describe('Forge GitHub connection diagnostics', () => {
  it('normalizes safe HTTPS, SSH and configured SSH aliases without credentials', () => {
    for (const raw of ['https://github.com/Hawkemw1996/w3-forge.git','git@github.com:Hawkemw1996/w3-forge.git','github.com-w3forge:Hawkemw1996/w3-forge.git','ssh://git@github.com/Hawkemw1996/w3-forge.git']) {
      expect(githubRepositoryUrl(raw)).toBe('https://github.com/Hawkemw1996/w3-forge');
    }
    for (const raw of ['https://TOKEN@github.com/a/b','https://user:TOKEN@github.com/a/b','https://github.com/a/b?token=secret','file:///private','javascript:alert(1)','git@evil.test:a/b','https://github.com/a/b\n','https://github.com/a/b/extra']) expect(githubRepositoryUrl(raw)).toBeNull();
  });
  it('returns workspace, remote identity, branch, head and local tracking counts', async () => {
    const {app} = fixture();
    const res = await request(app).get('/git/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({branch:'dev/v0.4.1',branchAllowed:true,dirty:false,remoteConfigured:true,remoteMatchesConfig:true,head:'a'.repeat(40),upstream:'origin/dev/v0.4.1',ahead:2,behind:1,devBranches:['dev/v0.4.0','dev/v0.4.1']});
    expect(res.body.data).toMatchObject({
      appId: 'w3forge', appName: 'W3 Forge', repositoryBinding: 'matched',
      repositoryUrl: 'https://github.com/Hawkemw1996/w3-forge',
      configuredRepositoryUrl: 'https://github.com/Hawkemw1996/w3-forge',
      remoteRepositoryUrl: 'https://github.com/Hawkemw1996/w3-forge'
    });
    expect(res.body.data).not.toHaveProperty('remoteAddress');
  });
  it('never reports a broken workspace as clean', async () => {
    const {app} = fixture({'status --short':{code:128,out:'secret stderr'}});
    const res = await request(app).get('/git/status');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('GIT_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
  it('keeps untracked-branch counts unknown instead of reporting up to date', async () => {
    const {app} = fixture({'rev-parse --abbrev-ref --symbolic-full-name @{upstream}':{code:128,out:''}});
    const res=await request(app).get('/git/status');
    expect(res.body.data).toMatchObject({upstream:null,ahead:null,behind:null});
  });
  it('performs only a fixed read-only ls-remote check for the current branch', async () => {
    const {app,git} = fixture();
    const res=await request(app).post('/git/check-remote').send({});
    expect(res.body.data).toMatchObject({connected:true,remoteHead:'b'.repeat(40)});
    expect(git.mock.calls.at(-1)).toEqual([['ls-remote','--exit-code','--heads','git@github.com:Hawkemw1996/w3-forge.git','refs/heads/dev/v0.4.1'],'/forge']);
    expect(JSON.stringify(git.mock.calls)).not.toMatch(/fetch|push|pull|checkout/);
  });
  it('distinguishes a reachable repository without the development branch', async () => {
    const {app}=fixture({'ls-remote --exit-code --heads git@github.com:Hawkemw1996/w3-forge.git refs/heads/dev/v0.4.1':{code:2,out:''}});
    const res=await request(app).post('/git/check-remote').send({});
    expect(res.body.data).toMatchObject({connected:true,remoteHead:null});
    expect(res.body.data.message).toContain('not been pushed');
  });
  it('reports network/authentication failure without subprocess diagnostics', async () => {
    const {app}=fixture({'ls-remote --exit-code --heads git@github.com:Hawkemw1996/w3-forge.git refs/heads/dev/v0.4.1':{code:128,out:'SECRET'}});
    const res=await request(app).post('/git/check-remote').send({});
    expect(res.body.data.connected).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
  it('blocks remote mismatch and token-bearing remotes before network contact', async () => {
    for(const remote of ['git@github.com:someone/other.git','https://TOKEN@github.com/Hawkemw1996/w3-forge.git']){
      const {app,git}=fixture({'remote get-url origin':{code:0,out:remote}});
      const res=await request(app).post('/git/check-remote').send({});
      expect(res.status).toBe(409);
      expect(git.mock.calls.some(([args])=>args[0]==='ls-remote')).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain('TOKEN');
    }
  });
  it('reports a different app origin separately without replacing the configured app repository', async () => {
    const {app,git}=fixture({'remote get-url origin':{code:0,out:'github.com-w3buildcost:Hawkemw1996/w3buildcost.git'}});
    const status=await request(app).get('/git/status');
    expect(status.body.data).toMatchObject({
      appId:'w3forge', repositoryBinding:'mismatch', remoteConfigured:true, remoteMatchesConfig:false,
      repositoryUrl:'https://github.com/Hawkemw1996/w3-forge',
      configuredRepositoryUrl:'https://github.com/Hawkemw1996/w3-forge',
      remoteRepositoryUrl:'https://github.com/Hawkemw1996/w3buildcost'
    });
    expect(status.body.data.repositoryMessage).toContain('different GitHub repository');
    const check=await request(app).post('/git/check-remote').send({});
    expect(check.status).toBe(409);
    expect(git.mock.calls.some(([args])=>args[0]==='ls-remote')).toBe(false);
  });
  it.each([
    {url:undefined,binding:'missing_config'},
    {url:'https://TOKEN@github.com/Hawkemw1996/w3-forge.git',binding:'invalid_config'},
    {url:'https://other.example/w3-forge',binding:'invalid_config'}
  ])('never treats an origin as this app repository when configuration is $binding', async ({url,binding}) => {
    const {app,git}=fixture({}, {...cfg,repo:{...cfg.repo,url}});
    const status=await request(app).get('/git/status');
    expect(status.body.data).toMatchObject({
      repositoryBinding:binding, repositoryUrl:null, configuredRepositoryUrl:null,
      remoteRepositoryUrl:'https://github.com/Hawkemw1996/w3-forge',remoteMatchesConfig:false
    });
    expect(JSON.stringify(status.body)).not.toContain('TOKEN');
    const check=await request(app).post('/git/check-remote').send({});
    expect(check.status).toBe(409);
    expect(JSON.stringify(check.body)).not.toContain('TOKEN');
    expect(git.mock.calls.some(([args])=>args[0]==='ls-remote')).toBe(false);
  });
  it.each([
    {remote:{code:128,out:'private failure'},binding:'missing_origin'},
    {remote:{code:0,out:''},binding:'missing_origin'},
    {remote:{code:0,out:'https://TOKEN@github.com/Hawkemw1996/w3-forge.git'},binding:'unsupported_origin'},
    {remote:{code:0,out:'git@unsupported-alias:Hawkemw1996/w3-forge.git'},binding:'unsupported_origin'}
  ])('reports $binding without exposing unsafe remote details or contacting it', async ({remote,binding}) => {
    const {app,git}=fixture({'remote get-url origin':remote});
    const status=await request(app).get('/git/status');
    expect(status.body.data).toMatchObject({
      repositoryBinding:binding, remoteRepositoryUrl:null, remoteConfigured:false, remoteMatchesConfig:false,
      repositoryUrl:'https://github.com/Hawkemw1996/w3-forge'
    });
    expect(JSON.stringify(status.body)).not.toMatch(/TOKEN|private failure|unsupported-alias/);
    const check=await request(app).post('/git/check-remote').send({});
    expect(check.status).toBe(409);
    expect(git.mock.calls.some(([args])=>args[0]==='ls-remote')).toBe(false);
  });
  it('uses each configured app identity rather than hard-coding the Forge repository', async () => {
    const ownRemote='github.com-w3buildcost:Hawkemw1996/w3buildcost.git';
    const {app,git}=fixture({
      'remote get-url origin':{code:0,out:ownRemote},
      ['ls-remote --exit-code --heads '+ownRemote+' refs/heads/dev/v0.4.1']:{code:2,out:''}
    },{...cfg,app_id:'w3buildcost',name:'W3 BuildCost',repo:{...cfg.repo,url:ownRemote}});
    const status=await request(app).get('/git/status');
    expect(status.body.data).toMatchObject({
      appId:'w3buildcost',appName:'W3 BuildCost',repositoryBinding:'matched',
      repositoryUrl:'https://github.com/Hawkemw1996/w3buildcost'
    });
    const check=await request(app).post('/git/check-remote').send({});
    expect(check.body.data).toMatchObject({
      connected:true,appId:'w3buildcost',repositoryBinding:'matched',
      repositoryUrl:'https://github.com/Hawkemw1996/w3buildcost'
    });
    expect(git.mock.calls.at(-1)?.[0]).toEqual(['ls-remote','--exit-code','--heads',ownRemote,'refs/heads/dev/v0.4.1']);
  });
  it('accepts GitHub repository identity case differences while preserving the validated transport address', async () => {
    const remote='git@github.com:hawkemw1996/W3-FORGE.git';
    const {app,git}=fixture({
      'remote get-url origin':{code:0,out:remote},
      ['ls-remote --exit-code --heads '+remote+' refs/heads/dev/v0.4.1']:{code:2,out:''}
    });
    const check=await request(app).post('/git/check-remote').send({});
    expect(check.body.data).toMatchObject({connected:true,repositoryBinding:'matched'});
    expect(git.mock.calls.at(-1)?.[0][3]).toBe(remote);
  });
  it('does not report another branch response as a verified development branch', async () => {
    const {app}=fixture({
      'ls-remote --exit-code --heads git@github.com:Hawkemw1996/w3-forge.git refs/heads/dev/v0.4.1':
        {code:0,out:'b'.repeat(40)+'\trefs/heads/main\n'}
    });
    const check=await request(app).post('/git/check-remote').send({});
    expect(check.body.data).toMatchObject({connected:false,remoteHead:null});
  });
  it('rejects protected or non-development branches and browser-controlled arguments', async () => {
    for(const branch of ['main','master','HEAD','feature/test']){
      const {app,git}=fixture({'rev-parse --abbrev-ref HEAD':{code:0,out:branch}});
      expect((await request(app).post('/git/check-remote').send({})).status).toBe(403);
      expect(git.mock.calls.some(([args])=>args[0]==='ls-remote')).toBe(false);
    }
    const {app,git}=fixture();
    for(const body of [{remote:'evil'}, {command:'git push'}, []]) expect((await request(app).post('/git/check-remote').send(body)).status).toBe(400);
    expect(git).not.toHaveBeenCalled();
  });
});

describe('admin route access', () => {
  let app: express.Express;
  let auth: ReturnType<typeof createCoreFixture>;
  beforeAll(async () => {
    process.env.W3_FORGE_ROOT=makeForgeTree();
    process.env.ADMIN_ALLOWED_IPS='*';
    const {buildAdminRouter}=await import('../src/admin');
    auth=createCoreFixture(); app=express();
    app.use('/api/auth',auth.auth.router);
    app.use('/api/admin',buildAdminRouter(new Date().toISOString(),auth.auth));
  });
  it('requires verified Forge admin and same-origin JSON for remote checks', async () => {
    expect((await request(app).post('/api/admin/git/check-remote').send({})).status).toBe(401);
    const agent=request.agent(app); await auth.login(agent);
    expect((await agent.post('/api/admin/git/check-remote').set('Origin','https://evil.test').send({})).status).toBe(403);
    auth.state.role='viewer';
    expect((await agent.post('/api/admin/git/check-remote').send({})).status).toBe(403);
    expect((await agent.get('/api/admin/connections')).status).toBe(403);
  });
});
