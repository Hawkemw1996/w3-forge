import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeForgeTree } from './setup';
let connectionStatus: typeof import('../src/admin/routes/connectionsRoutes').connectionStatus;
let publicServiceUrl: typeof import('../src/admin/routes/connectionsRoutes').publicServiceUrl;
beforeAll(async()=>{
  process.env.W3_FORGE_ROOT=makeForgeTree();
  ({connectionStatus,publicServiceUrl}=await import('../src/admin/routes/connectionsRoutes'));
});
describe('connection readiness',()=>{
  it('shows disabled and planned modules accurately and does not perform network calls',()=>{
    const spy=vi.spyOn(globalThis,'fetch');
    const data=connectionStatus({});
    expect(data).toMatchObject({core:{configured:false},terminal:{enabled:false},materialPricing:{enabled:false,configured:false},ollama:{configured:false,model:null},n8n:{configured:false,url:null},chat:{status:'planned'},businessAutomations:{status:'planned'}});
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
  });
  it('never returns credentials and validates enabled configuration',()=>{
    const secret='AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklm';
    const data=connectionStatus({CORE_APP_CLIENT_SECRET:'secret-core',CORE_APP_INSTANCE_ID:'not-a-uuid',
      CORE_API_URL:'https://core.test',FORGE_PUBLIC_URL:'https://forge.test',ADMIN_TERMINAL_ENABLED:'true',
      W3_FORGE_N8N_URL:'https://n8n.test/home',W3_FORGE_MATERIAL_PRICING_ENABLED:'true',
      W3_FORGE_MATERIAL_PRICING_SHARED_TOKEN:secret,W3_FORGE_MATERIAL_PRICING_APIFY_TOKEN:'secret-apify-token-1234567890',
      W3_FORGE_MATERIAL_PRICING_DATA_DIR:process.env.W3_FORGE_ROOT+'-ledger',
      W3_FORGE_MATERIAL_PRICING_OLLAMA_MODEL:'qwen2.5:7b'});
    expect(data).toMatchObject({core:{configured:false},terminal:{enabled:true},materialPricing:{enabled:true,configured:true},ollama:{configured:true,model:'qwen2.5:7b'},n8n:{configured:true,url:'https://n8n.test/home'}});
    expect(JSON.stringify(data)).not.toMatch(/secret-core|secret-apify|AbCdEfGh|SHARED_TOKEN|CLIENT_SECRET/);
  });
  it('does not claim invalid pricing credentials are ready',()=>{
    expect(connectionStatus({W3_FORGE_MATERIAL_PRICING_ENABLED:'true'}).materialPricing).toMatchObject({enabled:true,configured:false});
  });
  it('drops links carrying secrets or unsafe URL schemes',()=>{
    for(const raw of ['javascript:alert(1)','https://u:p@n8n.test/','https://n8n.test/?apiKey=secret','https://n8n.test/#secret']) expect(publicServiceUrl(raw)).toBeNull();
  });
});

describe('installed Qwen model compatibility', () => {
  it('allows the installed coder variant but does not choose or download a model', async () => {
    const {isSupportedModelTag}=await import('../src/materialPricing/config');
    expect(isSupportedModelTag('qwen2.5-coder:14b')).toBe(true);
    expect(isSupportedModelTag('qwen2.5:7b')).toBe(true);
    for(const model of ['', 'other:latest', 'qwen2.5-coder', 'qwen2.5-coder:14b;id', 'qwen2.5-coder:14b\n']) expect(isSupportedModelTag(model)).toBe(false);
    expect(connectionStatus({W3_FORGE_MATERIAL_PRICING_OLLAMA_MODEL:'qwen2.5-coder:14b'}).ollama).toEqual({configured:true,model:'qwen2.5-coder:14b'});
  });
});
