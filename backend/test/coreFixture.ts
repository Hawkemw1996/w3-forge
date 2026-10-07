import { createHash } from 'node:crypto';
import { createCoreClient } from '../src/auth/coreClient';
import { createCoreAuth } from '../src/auth/coreAuth';

export function createCoreFixture(sessionOptions: { sessionSecret?: string; pairingSecret?: string; serviceToken?: string } = {}) {
  const secret = 'A'.repeat(43);
  const state = { role: 'admin', revoked: false, down: false, foreignApp: false, expired: false, calls: [] as string[], tokens: new Set<string>(), codes: new Map<string, string>() };
  const core = createCoreClient({ baseUrl: 'https://core.test', publicCoreUrl: 'https://core.test', publicAppUrl: 'https://forge.test',
    appId: 'w3forge', clientSecret: secret, instanceId: '01234567-89ab-4cde-8fab-0123456789ab', version: '0.4.1',
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      state.calls.push(path);
      const headers = init.headers as Record<string, string>;
      if (headers.Authorization !== 'Bearer ' + secret || headers['X-W3-App-Id'] !== 'w3forge') throw new Error('Wrong client identity');
      const reply = (status: number, data?: unknown) => new Response(JSON.stringify({ success: status === 200, data }), { status });
      if (state.down) return reply(503);
      const body = JSON.parse(String(init.body));
      if (path === '/api/app-discovery/announce') {
        if (body.app_id !== 'w3forge' || body.redirect_uris[0] !== 'https://forge.test/api/auth/callback') throw new Error('Wrong announcement');
        return reply(200, { status: 'approved' });
      }
      if (path === '/api/app-sign-in/exchange') {
        const challenge = state.codes.get(body.code); state.codes.delete(body.code);
        if (body.redirect_uri !== 'https://forge.test/api/auth/callback' || !challenge || challenge !== createHash('sha256').update(body.code_verifier).digest('base64url')) return reply(401);
        const token = 'T'.repeat(43); state.tokens.add(token);
        return reply(200, { session_token: token });
      }
      if (path === '/api/app-sign-in/session') {
        if (state.revoked || !state.tokens.has(body.session_token)) return reply(401);
        return reply(200, { app_id: state.foreignApp ? 'w3buildcost' : 'w3forge', user: { id: 1, username: 'operator' }, app_role: state.role,
          expires_at: new Date(Date.now() + (state.expired ? -1000 : 28800000)).toISOString() });
      }
      if (path === '/api/app-sign-in/logout') { state.tokens.delete(body.session_token); return reply(200, {}); }
      throw new Error('Unexpected identity endpoint');
    }
  });
  const authOptions = { publicAppUrl: 'https://forge.test', publicCoreUrl: 'https://core.test', cookieSecure: false,
    sessionSecret: 'forge-session-test-secret-unique-0123456789', pairingSecret: secret, ...sessionOptions };
  const auth = createCoreAuth(core, authOptions);
  async function begin(agent: any, next = '/admin/') {
    const start = await agent.post('/api/auth/login').send({ next });
    if (start.status !== 200) throw new Error('Could not start login: ' + start.status);
    const target = new URL(start.body.data.redirectTo), code = 'C'.repeat(43);
    state.codes.set(code, target.searchParams.get('code_challenge')!);
    return '/api/auth/callback?' + new URLSearchParams({ code, state: target.searchParams.get('state')! }).toString();
  }
  async function login(agent: any, next?: string) { return agent.get(await begin(agent, next)); }
  return { auth, core, state, begin, login, authOptions };
}
