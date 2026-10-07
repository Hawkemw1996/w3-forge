import path from 'node:path';
import { repoRoot } from '../../config/env';
import {
  getActiveAppId, getRuntimePath, getDeployPath, getScriptsPath, getLogsPath, getBackupsPath,
  getUpdatePackagesPath, getInstalledPackagesPath, getServiceName, getServicePort, getHealthUrl, getVersionUrl, getRepoUrl
} from '../appConfigAccessors';
import { UPDATE_PACKAGES_DEV_DIR, UPDATE_PACKAGES_MAIN_DIR } from '../paths';
import { githubRepositoryUrl } from '../githubValidation/repositoryIdentity';

/** Fixed installation bindings only. Never forward Core, session, database or provider credentials. */
export function controlEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: process.env.HOME ?? '/root',
    W3_FORGE_ROOT: repoRoot,
    W3_APP_CONFIG_DIR: process.env.W3_APP_CONFIG_DIR?.trim() || path.join(repoRoot, 'config', 'apps'),
    W3_ACTIVE_APP_ID: getActiveAppId(),
    W3_REPO_URL: githubRepositoryUrl(getRepoUrl() ?? undefined) ?? '',
    W3_APP_DIR: getRuntimePath(),
    W3_DEPLOY_DIR: getDeployPath(),
    W3_SCRIPTS_DIR: getScriptsPath(),
    W3_LOG_ROOT: getLogsPath(),
    W3LOG_ROOT: getLogsPath(),
    W3_BACKUPS_DIR: getBackupsPath(),
    W3_UPDATE_DIR: getUpdatePackagesPath(),
    W3_INSTALLED_DIR: getInstalledPackagesPath(),
    W3_DEV_UPDATE_DIR: UPDATE_PACKAGES_DEV_DIR,
    W3_MAIN_UPDATE_DIR: UPDATE_PACKAGES_MAIN_DIR,
    W3_SERVICE_NAME: getServiceName(),
    W3_SERVICE_PORT: String(getServicePort()),
    W3_HEALTH_URL: getHealthUrl(),
    W3_VERSION_URL: getVersionUrl()
  };
}
