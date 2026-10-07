import { getRepoUrl } from '../appConfigAccessors';

/** Browser-safe public repository identity, never an embedded password/token. */
export function githubRepositoryUrl(raw: string | undefined): string | null {
  if (!raw || /[\u0000-\u0020]/.test(raw)) return null;
  let repository: string;
  const ssh = /^(?:git@)?github\.com(?:-[A-Za-z0-9_-]+)?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(raw);
  if (ssh) repository = ssh[1];
  else {
    try {
      const url = new URL(raw);
      if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname !== 'github.com'
        || url.port || url.search || url.hash || url.password
        || (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))) return null;
      repository = url.pathname.replace(/^\//, '');
    } catch { return null; }
  }
  repository = repository.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || repository.split('/').some(part => part === '.' || part === '..')) return null;
  return 'https://github.com/' + repository;
}

export function repositoryIdentity(remote: string | null) {
  const configured = getRepoUrl();
  const configuredRepositoryUrl = githubRepositoryUrl(configured ?? undefined);
  const remoteRepositoryUrl = githubRepositoryUrl(remote ?? undefined);
  const repositoryBinding = !configured ? 'missing_config'
    : !configuredRepositoryUrl ? 'invalid_config'
    : !remote ? 'missing_origin'
    : !remoteRepositoryUrl ? 'unsupported_origin'
    : configuredRepositoryUrl.toLowerCase() === remoteRepositoryUrl.toLowerCase() ? 'matched' : 'mismatch';
  const repositoryMessage = repositoryBinding === 'matched'
    ? 'Workspace origin matches this app’s configured GitHub repository.'
    : 'The workspace origin must match this app’s configured credential-free GitHub repository before contacting GitHub.';
  return { configuredRepositoryUrl, remoteRepositoryUrl, repositoryBinding,
    remoteMatchesConfig: repositoryBinding === 'matched', repositoryMessage };
}
