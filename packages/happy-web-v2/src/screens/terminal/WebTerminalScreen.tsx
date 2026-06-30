import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronLeft, Pencil, ListPlus } from 'lucide-react';
import { apiSocket } from '@/sync/apiSocket';
import {
  machineOpenTerminal,
  encryptTerminalData,
  decryptTerminalData,
  machineUploadFile,
  machineSetTerminalTitle,
} from '@/sync/ops';
import { useSettings } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useIsDesktop } from '@/app/useMediaQuery';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { ensureImeFix } from './imeFix';
import './terminal.css';

function strToB64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const THEME = {
  background: '#0B0E13', foreground: '#E8EDF4', cursor: '#34E2C4', cursorAccent: '#04110E',
  selectionBackground: 'rgba(52,226,196,0.25)', black: '#0B0E13', brightBlack: '#5B6675',
  red: '#FF6B6B', green: '#34E2C4', yellow: '#E6B450', blue: '#7AA2D6', magenta: '#C792EA',
  cyan: '#34E2C4', white: '#E8EDF4',
};

export function WebTerminalScreen() {
  const { machineId } = useParams<{ machineId: string }>();
  const [params] = useSearchParams();
  const tid = params.get('tid') ?? undefined;
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const { t } = useTranslation();
  const settings = useSettings();
  const terminals = useTerminalSessions((s) => s.terminals);
  const renameTerminal = useTerminalSessions((s) => s.rename);
  const autoTitle = useTerminalSessions((s) => s.autoTitle);
  const meta = terminals.find((x) => x.id === tid);
  const title = meta?.title || meta?.machineName || t('newSessionModal.terminalTitle' as any);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [connecting, setConnecting] = useState(true);

  useEffect(() => {
    if (!machineId || !hostRef.current) return;
    ensureImeFix();

    const term = new Terminal({
      fontFamily: 'var(--font-mono), monospace',
      fontSize: 13, cursorBlink: true, theme: THEME, allowProposedApi: true, convertEol: false,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    termRef.current = term;

    const safeFit = () => {
      try { fit.fit(); } catch { /* not laid out yet */ }
    };
    requestAnimationFrame(safeFit);
    const t0 = setTimeout(safeFit, 60);

    let terminalId = '';
    let enc = false;
    let disposed = false;
    let titleBuf = '';
    let titled = false;
    let outChain: Promise<void> = Promise.resolve();

    const onOutput = (e: { terminalId: string; data: string; enc?: boolean }) => {
      if (disposed || e.terminalId !== terminalId) return;
      if (e.enc) {
        outChain = outChain.then(async () => {
          const plain = await decryptTerminalData(machineId, e.data);
          if (plain && !disposed) term.write(b64ToBytes(plain));
        });
      } else {
        term.write(b64ToBytes(e.data));
      }
    };
    const onExit = (e: { terminalId: string; exitCode?: number }) => {
      if (disposed || e.terminalId !== terminalId) return;
      term.writeln(`\r\n\x1b[38;2;91;102;117m[process exited${e.exitCode != null ? ` (${e.exitCode})` : ''}]\x1b[0m`);
    };
    apiSocket.onMessage('terminal-output', onOutput);
    apiSocket.onMessage('terminal-exit', onExit);

    const sendInput = (d: string) => {
      const b64 = strToB64(d);
      if (enc) {
        encryptTerminalData(machineId, b64).then((c) => {
          if (c && !disposed) apiSocket.send('terminal-input', { machineId, terminalId, data: c, enc: true });
        });
      } else {
        apiSocket.send('terminal-input', { machineId, terminalId, data: b64 });
      }
    };
    const dataDisp = term.onData(sendInput);

    const keyDisp = term.onKey(({ key, domEvent }) => {
      if (titled) return;
      if (domEvent.key === 'Enter') {
        const tt = titleBuf.trim();
        if (tt && tid) {
          autoTitle(tid, tt.slice(0, 60));
          machineSetTerminalTitle(machineId, terminalId, tt.slice(0, 60), true).catch(() => {});
        }
        titled = true;
      } else if (domEvent.key === 'Backspace') titleBuf = titleBuf.slice(0, -1);
      else if (key.length === 1 && !domEvent.ctrlKey && !domEvent.metaKey && !domEvent.altKey) titleBuf += key;
    });

    const doFit = () => {
      safeFit();
      if (terminalId) apiSocket.send('terminal-resize', { machineId, terminalId, cols: term.cols, rows: term.rows });
    };
    // Debounce refits to the next frame so a burst of resize ticks collapses into
    // one fit AFTER layout settles — otherwise the xterm canvas keeps its old
    // (too-tall) size mid-resize and the host shows a scrollbar instead of reflowing.
    let fitRaf = 0;
    const scheduleFit = () => {
      if (fitRaf) cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0;
        doFit();
      });
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(hostRef.current);
    window.addEventListener('resize', scheduleFit);

    (async () => {
      safeFit();
      const res = await machineOpenTerminal(machineId, { terminalId: tid, cols: term.cols, rows: term.rows, encStream: true });
      if (disposed) return;
      if (!res.success) {
        term.writeln(`\x1b[38;2;255;107;107m✗ ${res.error}\x1b[0m`);
        setConnecting(false);
        return;
      }
      terminalId = res.terminalId;
      enc = res.encStream === true;
      setConnecting(false);
      requestAnimationFrame(doFit);
      term.focus();
    })();

    const host = hostRef.current;
    const onDragOver = (e: DragEvent) => { e.preventDefault(); host.classList.add('is-dragover'); };
    const onDragLeave = () => host.classList.remove('is-dragover');
    const onDrop = async (e: DragEvent) => {
      e.preventDefault(); host.classList.remove('is-dragover');
      for (const f of Array.from(e.dataTransfer?.files ?? [])) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        const r = await machineUploadFile(machineId, f.name, btoa(bin));
        if (r.success && r.path) term.paste(`'${r.path}' `);
      }
    };
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);

    return () => {
      disposed = true;
      clearTimeout(t0);
      if (fitRaf) cancelAnimationFrame(fitRaf);
      window.removeEventListener('resize', scheduleFit);
      ro.disconnect();
      apiSocket.offMessage('terminal-output', onOutput);
      apiSocket.offMessage('terminal-exit', onExit);
      host.removeEventListener('dragover', onDragOver);
      host.removeEventListener('dragleave', onDragLeave);
      host.removeEventListener('drop', onDrop);
      dataDisp.dispose();
      keyDisp.dispose();
      if (terminalId) apiSocket.send('terminal-close', { machineId, terminalId });
      term.dispose();
      termRef.current = null;
    };
  }, [machineId, tid, autoTitle]);

  const runCommand = (command: string) => {
    const tm = termRef.current;
    if (!tm) return;
    tm.paste(command); // user presses Enter to run — never auto-execute
    tm.focus();
  };

  const onRename = async () => {
    if (!tid) return;
    const next = await Modal.prompt(t('common.rename' as any), undefined, { defaultValue: title });
    if (next != null) renameTerminal(tid, next);
  };

  const cmds = (settings.terminalCommands ?? []) as Array<{ id: string; title: string; command: string }>;

  return (
    <div className="term-screen">
      <header className="term-header">
        {!isDesktop && (
          <button className="term-back" onClick={() => navigate('/')} aria-label="back">
            <ChevronLeft size={18} />
          </button>
        )}
        <button className="term-title" onClick={onRename} title={t('common.rename' as any)}>
          <span className="term-title-text">{title}</span>
          <Pencil size={13} className="term-title-edit" />
        </button>
        <div className="term-header-right">
          {connecting && <span className="term-connecting mono">{t('common.loading' as any)}</span>}
          {cmds.length > 0 && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="sb-icon-btn" title={t('settingsSnippets.terminalCommands' as any)}>
                  <ListPlus size={18} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="vh-menu" align="end" sideOffset={6}>
                  {cmds.map((c) => (
                    <DropdownMenu.Item key={c.id} className="vh-menu-item" onSelect={() => runCommand(c.command)}>
                      {c.title}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      </header>
      <div ref={hostRef} className="term-host" />
    </div>
  );
}
