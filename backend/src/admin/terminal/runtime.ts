import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import type { CoreAuth } from '../../auth/coreAuth';
import { appendTerminalAudit } from '../adminAudit';
import { TerminalError, type TerminalProcess, TerminalSessionManager, type TerminalSize } from './sessionManager';

export interface TerminalConfig { enabled: boolean }
function terminalConfig(): TerminalConfig {
  return { enabled: process.env.ADMIN_TERMINAL_ENABLED === 'true' };
}

function executable(candidates: string[]): string | undefined {
  return candidates.find(file => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } });
}

export function terminalStatus(config = terminalConfig()) {
  const supported = process.platform === 'linux';
  const directRoot = supported && process.getuid?.() === 0;
  const command = supported ? (directRoot ? executable(['/bin/bash', '/bin/sh']) : executable(['/usr/bin/su', '/bin/su'])) : undefined;
  return { enabled: config.enabled, supported, available: config.enabled && !!command,
    hostname: os.hostname(), access: directRoot ? 'root-shell' as const : 'root-login' as const,
    message: !config.enabled ? 'Terminal access is disabled. Enable ADMIN_TERMINAL_ENABLED on this Forge host to connect.'
      : !supported ? 'Forge host terminal access requires Linux.'
      : !command ? 'The Forge host has no supported shell or root login command.'
      : directRoot ? 'Open a root shell in the Forge host.' : 'Sign in as root using the Forge host password when prompted.' };
}

/** Fixed executables and argv; the browser cannot select an account, host, or command. */
export function spawnRootTerminal(size: TerminalSize, config = terminalConfig()): TerminalProcess {
  const status = terminalStatus(config);
  if (!status.available) throw new TerminalError(503, 'TERMINAL_UNAVAILABLE', status.message);
  const directRoot = status.access === 'root-shell';
  const command = directRoot ? executable(['/bin/bash', '/bin/sh'])! : executable(['/usr/bin/su', '/bin/su'])!;
  try {
    // Lazy loading keeps a missing native PTY build from preventing normal application startup.
    const pty = require('node-pty') as typeof import('node-pty');
    const child = pty.spawn(command, directRoot ? ['-l'] : ['--login', 'root'], {
      name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: '/',
      // Do not inherit database credentials, service secrets, or npm environment variables.
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8',
        HOME: os.userInfo().homedir, USER: os.userInfo().username, LOGNAME: os.userInfo().username }
    });
    let exited = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    child.onExit(() => { exited = true; if (forceKill) clearTimeout(forceKill); });
    return {
      write: data => child.write(data), resize: (cols, rows) => child.resize(cols, rows),
      onData: listener => child.onData(listener), onExit: listener => child.onExit(listener),
      kill: (force = false) => {
        if (exited) return;
        // Shutdown may exit Node before a delayed fallback can fire.
        if (force) { child.kill('SIGKILL'); return; }
        child.kill('SIGHUP');
        // A shell that traps HUP must not outlive an expired administrator login.
        forceKill = setTimeout(() => {
          try { if (!exited) child.kill('SIGKILL'); } catch { /* Process already gone. */ }
        }, 1_000);
        forceKill.unref();
      }
    };
  } catch {
    throw new TerminalError(503, 'TERMINAL_START_FAILED', 'The Forge host could not start its terminal. Check the node-pty installation and root login availability.');
  }
}

export function createTerminalRuntime(auth: CoreAuth, config = terminalConfig()) {
  return {
    origin: auth.publicAppUrl,
    identity: auth.adminSession,
    authorize: auth.authorizeAdminSession,
    status: () => terminalStatus(config),
    manager: new TerminalSessionManager({ spawn: size => spawnRootTerminal(size, config),
      authorize: identity => auth.authorizeAdminSession(identity), audit: appendTerminalAudit })
  };
}
export type TerminalRuntime = ReturnType<typeof createTerminalRuntime>;
