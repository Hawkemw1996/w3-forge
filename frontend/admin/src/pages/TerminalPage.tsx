import { consoleText, consoleMachineText } from "../../../../shared/consoleApp";
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Eraser, Maximize2, Minimize2, Plug, Unplug, TerminalSquare } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { SectionHeader } from '../components/ui/SectionHeader';
import { terminalRequest, TerminalConnection, TerminalStatus } from '../lib/terminal';
import { clearTerminalScreen } from '../lib/terminalScreen';

export function TerminalPage() {
  const status = useQuery({ queryKey: ['admin', 'terminal', 'status'], queryFn: () => terminalRequest<TerminalStatus>('/status'), retry: false });
  const statusData = status.isError ? undefined : status.data;
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const fit = useRef<FitAddon>();
  const connection = useRef<TerminalConnection>();
  const mounted = useRef(false);
  const [state, setState] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [message, setMessage] = useState(consoleMachineText('Connect to open a terminal in this container.'));
  const [hasError, setHasError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);

  useEffect(() => {
    mounted.current = true;
    const term = new Terminal({ cursorBlink: false, disableStdin: true, fontSize: 14,
      fontFamily: 'Consolas, "Liberation Mono", monospace', scrollback: 5000,
      screenReaderMode: false, allowProposedApi: false,
      theme: { background: '#0c1016', foreground: '#e8edf4', cursor: '#d9a441',
        selectionBackground: '#d9a44144', black: '#202936', brightBlack: '#8492a5',
        red: '#ef7b80', green: '#8dc993', yellow: '#e2bf78', blue: '#8db5f5', magenta: '#c6a2e8', cyan: '#7ecbc4', white: '#e8edf4' } });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(host.current!);
    terminal.current = term;
    fit.current = addon;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!host.current || host.current.clientWidth < 50) return;
        addon.fit();
        void connection.current?.resize({ cols: Math.min(500, Math.max(10, term.cols)), rows: Math.min(200, Math.max(2, term.rows)) });
      }, 100);
    });
    observer.observe(host.current!);
    const input = term.onData(data => connection.current?.send(data));
    const onPageHide = () => connection.current?.stop();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mounted.current = false;
      connection.current?.stop();
      connection.current = undefined;
      window.removeEventListener('pagehide', onPageHide);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect(); input.dispose(); term.dispose();
      terminal.current = undefined; fit.current = undefined;
    };
  }, []);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    const connected = state === 'connected';
    term.options.disableStdin = !connected;
    term.options.cursorBlink = connected;
    term.options.screenReaderMode = connected;
    if (connected) term.focus(); else term.blur();
  }, [state]);

  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [expanded]);

  function clearScreen() {
    const term = terminal.current;
    const client = connection.current;
    if (!term || !client || state !== 'connected') return;
    clearTerminalScreen(term, () => {
      if (!mounted.current || terminal.current !== term || connection.current !== client) return;
      setHasOutput(false);
      // Ctrl+U/Ctrl+K discard input on both sides of the cursor; Ctrl+L redraws.
      // No Enter or interrupt is sent: clearing must never execute the input.
      client.send('\x15\x0b\x0c');
      term.focus();
    });
  }

  function connect() {
    if (!terminal.current || !statusData?.available || state !== 'disconnected') return;
    const term = terminal.current;
    setState('connecting'); setHasError(false); setHasOutput(false); setMessage(consoleMachineText('Connecting to the container…'));
    const client = new TerminalConnection({
      output: data => new Promise<void>(resolve => {
        if (!mounted.current || connection.current !== client) { resolve(); return; }
        term.write(data, () => {
          if (mounted.current && connection.current === client) setHasOutput(true);
          resolve();
        });
      }),
      connected: session => {
        if (!mounted.current || connection.current !== client) return;
        setState('connected');
        setMessage(session.access === 'root-login' ? consoleMachineText('Enter the container’s root password when prompted.') : 'Root shell connected.');
      },
      closed: (reason, error) => {
        if (!mounted.current || connection.current !== client) return;
        connection.current = undefined;
        term.options.disableStdin = true;
        term.options.screenReaderMode = false;
        term.blur();
        term.write('\x1bc');
        setHasOutput(false);
        setState('disconnected'); setMessage(reason); setHasError(error);
      }
    });
    connection.current = client;
    // Drain and reset old output before opening a new session, including screen-reader announcements.
    term.write('\x1bc', () => {
      if (!mounted.current || connection.current !== client) return;
      fit.current?.fit();
      void client.connect({ cols: Math.min(500, Math.max(10, term.cols)), rows: Math.min(200, Math.max(2, term.rows)) });
    });
  }

  const unavailable = status.error ? (status.error instanceof Error ? status.error.message : 'Could not check terminal availability.')
    : statusData && !statusData.available ? statusData.message : undefined;
  const connected = state === 'connected';
  return (
    <section className={expanded ? 'fixed inset-0 z-50 flex flex-col gap-4 p-4 sm:p-6' : 'flex flex-col gap-4'}
      style={expanded ? { background: 'var(--w3-bg)' } : undefined} aria-label={consoleMachineText("Container Terminal")}>
      <SectionHeader title="Terminal" subtitle={statusData ? ("" + (statusData.hostname) + consoleMachineText(" · Container Root Access")) : consoleMachineText('Container Root Access')}
        actions={<div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn" onClick={clearScreen} disabled={!connected || !hasOutput} title="Clear visible terminal output" aria-label="Clear Screen">
            <Eraser size={14} /><span className="hidden sm:inline">Clear Screen</span>
          </button>
          <button type="button" className="btn" onClick={() => setExpanded(value => !value)} aria-label={expanded ? 'Collapse Terminal' : 'Expand Terminal'} aria-pressed={expanded}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          {state === 'disconnected' ? <button type="button" className="btn btn-primary" disabled={!statusData?.available} onClick={connect}>
            <Plug size={14} />Connect
          </button> : <button type="button" className="btn" onClick={() => connection.current?.stop()}>
            <Unplug size={14} />{state === 'connecting' ? 'Cancel' : 'Disconnect'}
          </button>}
        </div>} />
      {unavailable && <div role="alert" className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: 'var(--w3-border)', color: 'var(--w3-text-muted)' }}>
        {unavailable}<button type="button" className="btn ml-3" onClick={() => void status.refetch()}>Check Again</button>
      </div>}
      <div className={`card flex min-h-0 flex-col overflow-hidden ${expanded ? 'flex-1' : ''}`}>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--w3-border)' }}>
          <div className="flex items-center gap-2 text-sm font-medium"><TerminalSquare size={16} style={{ color: 'var(--w3-gold-400)' }} />
            {statusData?.access === 'root-login' ? 'Root Login' : 'Root Shell'}
          </div>
          <span className={`badge ${connected ? 'badge-success' : state === 'connecting' ? 'badge-warning' : 'badge-slate'}`}>
            {connected ? 'Connected' : state === 'connecting' ? 'Connecting' : 'Disconnected'}
          </span>
        </div>
        <div className={`relative min-w-0 overflow-hidden ${expanded ? 'flex-1 min-h-0' : 'h-[62vh] min-h-[300px]'}`} style={{ background: '#0c1016' }}>
          {/* FitAddon measures this box; inset it instead of adding padding to its measured size. */}
          <div ref={host} className="absolute inset-3 overflow-hidden" style={{ visibility: connected ? 'visible' : 'hidden' }}
            aria-hidden={!connected} aria-label={consoleMachineText("Interactive Container Terminal")} />
          {!connected && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ color: 'var(--w3-text-muted)' }}>
            {state === 'connecting' ? <TerminalSquare size={34} style={{ color: 'var(--w3-gold-400)', opacity: 0.8 }} />
              : <Unplug size={34} style={{ color: 'var(--w3-gold-400)', opacity: 0.8 }} />}
            <p className="text-sm">{state === 'connecting' ? 'Opening Terminal…' : 'Terminal Disconnected'}</p>
            <p className="max-w-sm text-xs">{status.isLoading ? 'Checking connection availability…'
              : state === 'connecting' ? consoleMachineText('Waiting for the container’s shell…') : consoleText('Press Connect to access the W3 BuildCost Terminal')}</p>
          </div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs" style={{ borderColor: 'var(--w3-border)', color: 'var(--w3-text-muted)' }}>
          <span role="status" aria-live="polite" style={hasError ? { color: 'var(--status-danger, #ef7b80)' } : undefined}>{message}</span>
          {connected && <span>Ctrl+C To Interrupt · 15-Minute Idle Timeout</span>}
        </div>
      </div>
      <p className="text-xs" style={{ color: 'var(--w3-text-muted)' }}>Root commands affect this {consoleMachineText("container")}. Closing this page disconnects the terminal.</p>
    </section>
  );
}
