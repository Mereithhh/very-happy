import { useEffect, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { ChevronLeft } from 'lucide-react';
import { apiSocket } from '@/sync/apiSocket';
import {
  machineOpenTerminal,
  encryptTerminalData,
  decryptTerminalData,
  machineUploadFile,
  machineSetTerminalTitle,
} from '@/sync/ops';
import { useMachine } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useIsDesktop } from '@/app/useMediaQuery';
import { ensureImeFix } from './imeFix';
import './terminal.css';

// xterm wants base64 of raw bytes both ways.
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
  background: '#0B0E13',
  foreground: '#E8EDF4',
  cursor: '#34E2C4',
  cursorAccent: '#04110E',
  selectionBackground: 'rgba(52,226,196,0.25)',
  black: '#0B0E13',
  brightBlack: '#5B6675',
  red: '#FF6B6B',
  green: '#34E2C4',
  yellow: '#E6B450',
  blue: '#7AA2D6',
  magenta: '#C792EA',
  cyan: '#34E2C4',
  white: '#E8EDF4',
};

export function WebTerminalScreen() {
  const { machineId } = useParams<{ machineId: string }>();
  const [params] = useSearchParams();
  const tid = params.get('tid') ?? undefined;
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const machine = useMachine(machineId ?? '');
  const hostRef = useRef<HTMLDivElement>(null);
  const autoTitle = useTerminalSessions((s) => s.autoTitle);

  useEffect(() => {
    if (!machineId || !hostRef.current) return;
    ensureImeFix();

    const term = new Terminal({
      fontFamily: 'var(--font-mono), monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: THEME,
      allowProposedApi: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    try {
      fit.fit();
    } catch {
      /* host not measured yet */
    }

    let terminalId = '';
    let enc = false;
    let disposed = false;
    let titleBuf = '';
    let titled = false;
    // serialize encrypt/decrypt to preserve byte order
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
        encryptTerminalData(machineId, b64).then((cipher) => {
          if (cipher && !disposed) apiSocket.send('terminal-input', { machineId, terminalId, data: cipher, enc: true });
        });
      } else {
        apiSocket.send('terminal-input', { machineId, terminalId, data: b64 });
      }
    };

    const dataDisp = term.onData(sendInput);

    // auto-title from the first typed line (onKey, not onData — onData carries
    // terminal query replies that would corrupt the title; see SKILL note).
    const keyDisp = term.onKey(({ key, domEvent }) => {
      if (titled) return;
      if (domEvent.key === 'Enter') {
        const t = titleBuf.trim();
        if (t && tid) {
          autoTitle(tid, t.slice(0, 60));
          machineSetTerminalTitle(machineId, terminalId, t.slice(0, 60), true).catch(() => {});
        }
        titled = true;
      } else if (domEvent.key === 'Backspace') {
        titleBuf = titleBuf.slice(0, -1);
      } else if (key.length === 1 && !domEvent.ctrlKey && !domEvent.metaKey && !domEvent.altKey) {
        titleBuf += key;
      }
    });

    const doFit = () => {
      try {
        fit.fit();
        if (terminalId) apiSocket.send('terminal-resize', { machineId, terminalId, cols: term.cols, rows: term.rows });
      } catch {
        /* ignore */
      }
    };
    const ro = new ResizeObserver(() => doFit());
    ro.observe(hostRef.current);

    (async () => {
      const res = await machineOpenTerminal(machineId, {
        terminalId: tid,
        cols: term.cols,
        rows: term.rows,
        encStream: true,
      });
      if (disposed) return;
      if (!res.success) {
        term.writeln(`\x1b[38;2;255;107;107m✗ ${res.error}\x1b[0m`);
        return;
      }
      terminalId = res.terminalId;
      enc = res.encStream === true;
      doFit();
      term.focus();
    })();

    // drag-and-drop file upload → paste absolute path (never auto-runs)
    const host = hostRef.current;
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      host.classList.add('is-dragover');
    };
    const onDragLeave = () => host.classList.remove('is-dragover');
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      host.classList.remove('is-dragover');
      const files = Array.from(e.dataTransfer?.files ?? []);
      for (const f of files) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        const res = await machineUploadFile(machineId, f.name, btoa(bin));
        if (res.success && res.path) term.paste(`'${res.path}' `);
      }
    };
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);

    return () => {
      disposed = true;
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
    };
  }, [machineId, tid, autoTitle]);

  return (
    <div className="term-screen">
      {!isDesktop && (
        <header className="term-header">
          <button className="term-back" onClick={() => navigate('/')}>
            <ChevronLeft size={18} /> {machine?.metadata?.displayName ?? machine?.metadata?.host ?? 'Terminal'}
          </button>
        </header>
      )}
      <div ref={hostRef} className="term-host" />
    </div>
  );
}
