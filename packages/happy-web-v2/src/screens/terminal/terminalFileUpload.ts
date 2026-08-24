import {
  machineUploadFile,
  machineUploadFileChunk,
  type MachineUploadFileChunkRequest,
  type MachineUploadFileResponse,
} from '@/sync/ops';

export const TERMINAL_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const TERMINAL_UPLOAD_CHUNK_BYTES = 96 * 1024;
const LEGACY_UPLOAD_MAX_BYTES = 128 * 1024;

export interface TerminalUploadRpc {
  chunk(machineId: string, request: MachineUploadFileChunkRequest): Promise<MachineUploadFileResponse>;
  legacy(machineId: string, name: string, content: string): Promise<MachineUploadFileResponse>;
}

const defaultRpc: TerminalUploadRpc = {
  chunk: machineUploadFileChunk,
  legacy: machineUploadFile,
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function uploadId(): string {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  return `upload_${Date.now().toString(36)}_${random[0].toString(36)}${random[1].toString(36)}`;
}

export function terminalUploadName(name: string, now = Date.now()): string {
  return `drop-${now.toString(36)}-${name || 'file'}`;
}

export type TerminalPathQuoteStyle = 'posix' | 'powershell' | 'cmd' | 'unknown';

export function quoteTerminalUploadPath(path: string, style: TerminalPathQuoteStyle = 'posix'): string | null {
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (style === 'posix') return "'" + path.replace(/'/g, "'\\''") + "'";
  if (style === 'powershell') return "'" + path.replace(/'/g, "''") + "'";
  // Native cmd expands %VAR% and, with delayed expansion, !VAR! even inside
  // double quotes. Refuse those ambiguous homes instead of pasting a different
  // path than the daemon returned. Windows file names cannot contain `"`.
  if (style === 'cmd' && !/["%!]/.test(path)) return `"${path}"`;
  return null;
}

function isLegacyDaemonError(error: string | undefined): boolean {
  return /(?:method not (?:found|available)|unsupported)/i.test(error || '');
}

export async function uploadTerminalFile(
  machineId: string,
  file: File,
  options: {
    rpc?: TerminalUploadRpc;
    onProgress?: (sent: number, total: number) => void;
    createUploadId?: () => string;
  } = {},
): Promise<MachineUploadFileResponse> {
  const rpc = options.rpc ?? defaultRpc;
  if (file.size > TERMINAL_UPLOAD_MAX_BYTES) {
    return { success: false, error: 'File exceeds the 8 MB terminal upload limit' };
  }

  const id = options.createUploadId?.() ?? uploadId();
  const started = await rpc.chunk(machineId, {
    action: 'start',
    uploadId: id,
    name: file.name || 'file',
    totalSize: file.size,
    subdir: 'terminal',
  });

  // Older daemons do not register uploadFileChunk. Preserve the previously
  // shipped small-file path while refusing payloads that would exceed the
  // relay's encrypted RPC envelope.
  if (!started.success) {
    if (isLegacyDaemonError(started.error) && file.size <= LEGACY_UPLOAD_MAX_BYTES) {
      const content = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      return rpc.legacy(machineId, file.name || 'file', content);
    }
    if (isLegacyDaemonError(started.error)) {
      return {
        success: false,
        error: 'This file needs a newer Very Happy daemon. Update the CLI and restart the daemon.',
      };
    }
    return started;
  }

  let sent = 0;
  let complete = false;
  try {
    while (sent < file.size) {
      const end = Math.min(sent + TERMINAL_UPLOAD_CHUNK_BYTES, file.size);
      const bytes = new Uint8Array(await file.slice(sent, end).arrayBuffer());
      const result = await rpc.chunk(machineId, {
        action: 'append',
        uploadId: id,
        offset: sent,
        content: bytesToBase64(bytes),
      });
      if (!result.success) return result;
      sent = end;
      options.onProgress?.(sent, file.size);
    }
    const finished = await rpc.chunk(machineId, { action: 'finish', uploadId: id });
    complete = finished.success;
    return finished;
  } finally {
    if (!complete) {
      await rpc.chunk(machineId, { action: 'abort', uploadId: id }).catch(() => {});
    }
  }
}
