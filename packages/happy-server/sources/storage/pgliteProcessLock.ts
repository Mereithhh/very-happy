import * as fs from "fs";
import { spawnSync } from "child_process";

export interface PGliteProcessLock {
    lockTarget: string;
    strategy: "flock" | "python-fcntl";
    release: () => void;
}

export function pgliteLockTarget(dataDir: string): string {
    fs.mkdirSync(dataDir, { recursive: true });
    return fs.realpathSync.native(dataDir);
}

export function resolveFlockExecutable(): string | null {
    for (const candidate of ["/usr/bin/flock", "/bin/flock", "/usr/local/bin/flock", "/opt/homebrew/opt/util-linux/bin/flock"]) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // Try the next fixed system location. Never execute from PATH.
        }
    }
    return null;
}

export function resolveFcntlPython(): string | null {
    for (const candidate of ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // A fixed interpreter path is a development fallback for macOS.
        }
    }
    return null;
}

/**
 * PGlite's host filesystem backend must never be opened by two processes.
 * Lock the canonical database directory inode itself so containers mounting the
 * same volume at different paths still contend on one kernel advisory lock.
 * The inherited fd keeps the lock in this process after the helper exits; the
 * kernel releases it on close, crash, SIGKILL, or container exit.
 */
export function acquirePGliteProcessLock(dataDir: string): PGliteProcessLock {
    const lockTarget = pgliteLockTarget(dataDir);
    const fd = fs.openSync(lockTarget, fs.constants.O_RDONLY);
    const flockExecutable = resolveFlockExecutable();
    const pythonExecutable = flockExecutable ? null : resolveFcntlPython();

    if (!flockExecutable && !pythonExecutable) {
        fs.closeSync(fd);
        throw new Error("Persistent PGlite requires the host flock utility or Python fcntl support");
    }

    const result = flockExecutable
        ? spawnSync(flockExecutable, ["--nonblock", "3"], {
            stdio: ["ignore", "pipe", "pipe", fd],
            encoding: "utf8",
        })
        : spawnSync(pythonExecutable!, [
            "-c",
            "import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)",
        ], {
            stdio: ["ignore", "pipe", "pipe", fd],
            encoding: "utf8",
        });

    if (result.error) {
        fs.closeSync(fd);
        throw new Error("Could not execute the host advisory-lock helper for PGlite");
    }
    if (result.status !== 0) {
        fs.closeSync(fd);
        if (result.status === 1) {
            throw new Error("PGlite data directory is already open by another process");
        }
        throw new Error(`Host advisory-lock helper failed while guarding PGlite (exit ${result.status ?? "unknown"})`);
    }

    let released = false;
    return {
        lockTarget,
        strategy: flockExecutable ? "flock" : "python-fcntl",
        release: () => {
            if (released) return;
            released = true;
            fs.closeSync(fd);
        },
    };
}
