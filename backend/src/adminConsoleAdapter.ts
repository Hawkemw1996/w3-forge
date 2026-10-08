import path from 'node:path';
import type { ConsoleInstallation, ConsoleTerminalAdapter } from './console/contracts';
import type { CoreAuth } from './auth/coreAuth';
import { env, repoRoot } from './config/env';
export { env, repoRoot } from './config/env';
export { pool } from './db/pool';
export { AppError } from './types/api';
const base='/opt/w3forge',packages=process.env.W3_UPDATE_DIR?.trim()||base+'-update-packages';
export const installation:ConsoleInstallation={
  consumer:'w3forge',
  id:'w3forge',name:env.appName,basePath:'/forge',permissionPrefix:'forge',adminPermission:'forge:admin',
  repository:'https://github.com/Hawkemw1996/w3-forge.git',branch:'dev/v0.4.2',
  service:env.serviceName,port:env.port,databaseName:env.databaseName,envFile:process.env.W3_ENV_FILE||path.join(repoRoot,'.env'),
  gitKeyFile:process.env.APP_GIT_SSH_KEY_FILE||'',timeZone:process.env.APP_TIME_ZONE||'America/Chicago',
  terminalTarget:'host',durableOperations:true,legacyDeploymentResults:'/var/log/w3forge',
  scriptSourceDirectory:'scripts/admin',
  legacyBackupCapabilities:{verify:true,restoreTest:true,restore:true},
  paths:{runtime:base,deploy:base+'-deploy',scripts:base+'-scripts',data:env.dataDir,
    backups:'/opt/backups/w3forge',logs:'/opt/logs/w3forge',packages,installed:packages+'/installed',
    dev:packages+'/dev',main:packages+'/main',review:process.env.W3_CLEANUP_REVIEW_DIR||'/opt/w3forge-cleanup-review'},
  scriptEnvironment:()=>({W3_FORGE_ROOT:repoRoot,W3_APP_CONFIG_DIR:process.env.W3_APP_CONFIG_DIR||path.join(repoRoot,'config/apps'),W3_ACTIVE_APP_ID:'w3forge'})
};
export const terminalAdapter:ConsoleTerminalAdapter={
  identity(auth,request){const session=(auth as CoreAuth).adminSession(request);return request.forgeUser?.coreUserId===session?.userId?session:null;},
  authorize(auth,identity){return (auth as CoreAuth).authorizeAdminSession(identity);},
  origin(auth){return (auth as CoreAuth).publicAppUrl;}
};
