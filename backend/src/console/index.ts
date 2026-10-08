import { buildSharedConsoleRouter } from './sharedRouter';
import { adminGuard } from '../admin/adminGuard';
import { buildProductionReadinessRoutes } from './routes/productionReadinessRoutes';
import { auditEvents } from '../db/audit';
import type { CoreAuth } from '../auth/coreAuth';
import type { CoreClient } from '../auth/coreClient';
import type { Database } from '../db/database';
import type { TerminalRuntime } from './terminal/runtime';
export interface ConsoleDeps {auth:CoreAuth;core:CoreClient;terminal:TerminalRuntime;db:Database;}
export function buildConsoleRouter(startedAt:string,deps:ConsoleDeps){
  return buildSharedConsoleRouter({
    startedAt,db:deps.db,terminal:deps.terminal,networkGuard:adminGuard,
    authorizeAdmin:deps.auth.requireAdmin,sameOrigin:deps.auth.sameOrigin,
    coreStatus:async()=>({configured:deps.core.configured,baseUrl:deps.core.baseUrl||null,...await deps.core.health()}),
    auditEvents:limit=>auditEvents(deps.db,limit),
    legacyReadiness:buildProductionReadinessRoutes({db:deps.db,core:deps.core})
  });
}
