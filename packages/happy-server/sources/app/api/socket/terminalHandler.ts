/**
 * Web terminal relay (zero new deps — pure socket routing).
 *
 * Relays raw terminal bytes between a user/web client and the owning machine's
 * daemon. Direction depends on the socket's connection type:
 *   - machine socket → forwards terminal-output / terminal-exit / and the
 *     realtime terminal-activity ordering hint to the user's web clients
 *     (user-scoped room).
 *   - user/web socket → forwards terminal-input / terminal-resize /
 *     terminal-close to the specific machine, but ONLY after validating the
 *     machine belongs to this account (machines are account-scoped).
 *
 * The machineId in the web→machine direction is the security check; the
 * machine→web direction is implicitly scoped (the daemon socket already
 * authenticated as this account's machine).
 */
import { Server, Socket } from "socket.io";
import { activityCache } from "@/app/presence/sessionCache";

type Conn = { connectionType: string; machineId?: string };

/**
 * Hard cap on ids in ONE terminal-activity frame. The daemon caps live ptys at
 * 24 and only reports terminals it actually tracks, so this is purely a
 * defensive bound on a malformed/hostile frame — it must never let one socket
 * message fan a large payload out to every client of the account.
 */
const MAX_ACTIVITY_ITEMS = 200;

/**
 * Sanitize a daemon-supplied activity batch: keep only well-formed
 * `{ id, activityAt }` pairs, drop everything else (extra fields included —
 * the relay rebuilds each item, so a future daemon can't smuggle anything
 * through), and bound the length. Returns [] when there is nothing to send.
 * Pure; unit-tested.
 */
export function sanitizeTerminalActivity(raw: unknown): Array<{ id: string; activityAt: number }> {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ id: string; activityAt: number }> = [];
    for (const item of raw) {
        if (out.length >= MAX_ACTIVITY_ITEMS) break;
        if (!item || typeof item !== 'object') continue;
        const { id, activityAt } = item as { id?: unknown; activityAt?: unknown };
        if (typeof id !== 'string' || id.length === 0) continue;
        if (typeof activityAt !== 'number' || !Number.isFinite(activityAt) || activityAt <= 0) continue;
        out.push({ id, activityAt });
    }
    return out;
}

export function terminalHandler(userId: string, socket: Socket, io: Server, connection: Conn) {
    if (connection.connectionType === 'machine-scoped' && connection.machineId) {
        const machineId = connection.machineId;
        const userRoom = `user:${userId}:user-scoped`;

        socket.on('terminal-output', (data: { terminalId: string; data: string; seq?: number; enc?: boolean }) => {
            if (!data?.terminalId) return;
            // Forward `enc` so the client knows the byte stream is encrypted with
            // the per-machine key (the relay can't read it). Must pass through —
            // dropping it makes the client render ciphertext as plaintext.
            // `seq` is the daemon's monotonic output counter the client tracks for
            // gap-based reconnect; it must pass through too. (open-terminal's
            // snapshot/replay travels over the RPC channel, which is opaque, so
            // only this live-output event needs field passthrough here.)
            io.to(userRoom).emit('terminal-output', { terminalId: data.terminalId, machineId, data: data.data, seq: data.seq, enc: data.enc });
        });
        socket.on('terminal-exit', (data: { terminalId: string; exitCode: number }) => {
            if (!data?.terminalId) return;
            io.to(userRoom).emit('terminal-exit', { terminalId: data.terminalId, machineId, exitCode: data.exitCode });
        });
        // ── Realtime sidebar ordering ────────────────────────────────────────
        // "These terminals just produced output, now." An ordering hint only:
        // the durable terminal list (membership, titles, cwd, agent state) keeps
        // travelling encrypted inside daemonState.webTerminals, whose activity
        // value is deliberately quantized to 60s buckets because every write
        // there costs a CAS + DB write + broadcast. This lane costs one tiny
        // frame and is stored nowhere, so it can be a hundred times fresher.
        //
        // WHY IT LIVES HERE rather than on eventRouter's `ephemeral` bus, which
        // is the other transient lane on this server:
        //   1. `ephemeral` payloads are all SERVER-authored (presence, usage) —
        //      no daemon has ever been able to author one, and the builders have
        //      no notion of a relaying machine. This is machine-authored data,
        //      which is precisely what this relay (and clipboardHandler) exist
        //      for. Both are non-persisted machine → web signals; reusing that
        //      pattern is reusing an existing mechanism, not adding a lane.
        //   2. Compat. The web's `ephemeral` handler zod-validates a CLOSED
        //      union and console.errors on anything it doesn't know, so an old
        //      bundle in a forgotten tab/PWA would log an error PER FRAME (up
        //      to 1/s per machine, forever). A distinct event name is dispatched
        //      through the client's `onAny` → handler map, where an unknown name
        //      is silently dropped. "Old clients ignore new events" has to mean
        //      actually ignore them.
        //
        // Costs nothing when quiet: the daemon only sends a frame when a value
        // really moved, so an idle machine produces no traffic here at all.
        // `machineId` comes from the AUTHENTICATED connection, never the body.
        socket.on('terminal-activity', (data: { terminals?: unknown }) => {
            const terminals = sanitizeTerminalActivity(data?.terminals);
            if (terminals.length === 0) return;
            io.to(userRoom).emit('terminal-activity', { machineId, terminals });
        });
        return;
    }

    // User / web client → machine. Validate machine ownership on every event.
    const toMachine = async (
        machineId: string | undefined,
        emit: (room: string) => void,
    ) => {
        if (!machineId) return;
        if (!(await activityCache.isMachineValid(machineId, userId))) return;
        emit(`user:${userId}:machine:${machineId}`);
    };

    socket.on('terminal-input', (data: { machineId: string; terminalId: string; data: string; enc?: boolean }) => {
        void toMachine(data?.machineId, (room) =>
            io.to(room).emit('terminal-input', { terminalId: data.terminalId, data: data.data, enc: data.enc }));
    });
    socket.on('terminal-resize', (data: { machineId: string; terminalId: string; cols: number; rows: number }) => {
        void toMachine(data?.machineId, (room) =>
            io.to(room).emit('terminal-resize', { terminalId: data.terminalId, cols: data.cols, rows: data.rows }));
    });
    socket.on('terminal-close', (data: { machineId: string; terminalId: string }) => {
        void toMachine(data?.machineId, (room) =>
            io.to(room).emit('terminal-close', { terminalId: data.terminalId }));
    });
}
