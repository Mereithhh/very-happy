/**
 * Web terminal relay (zero new deps — pure socket routing).
 *
 * Relays raw terminal bytes between a user/web client and the owning machine's
 * daemon. Direction depends on the socket's connection type:
 *   - machine socket → forwards terminal-output / terminal-exit to the user's
 *     web clients (user-scoped room).
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

export function terminalHandler(userId: string, socket: Socket, io: Server, connection: Conn) {
    if (connection.connectionType === 'machine-scoped' && connection.machineId) {
        const machineId = connection.machineId;
        const userRoom = `user:${userId}:user-scoped`;

        socket.on('terminal-output', (data: { terminalId: string; data: string }) => {
            if (!data?.terminalId) return;
            io.to(userRoom).emit('terminal-output', { terminalId: data.terminalId, machineId, data: data.data });
        });
        socket.on('terminal-exit', (data: { terminalId: string; exitCode: number }) => {
            if (!data?.terminalId) return;
            io.to(userRoom).emit('terminal-exit', { terminalId: data.terminalId, machineId, exitCode: data.exitCode });
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

    socket.on('terminal-input', (data: { machineId: string; terminalId: string; data: string }) => {
        void toMachine(data?.machineId, (room) =>
            io.to(room).emit('terminal-input', { terminalId: data.terminalId, data: data.data }));
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
