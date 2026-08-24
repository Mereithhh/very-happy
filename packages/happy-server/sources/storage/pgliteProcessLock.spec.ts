import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { once } from "events";
import { spawn } from "child_process";
import { createPGlite } from "./pgliteLoader";
import {
    acquirePGliteProcessLock,
    pgliteLockTarget,
    resolveFcntlPython,
} from "./pgliteProcessLock";

const roots: string[] = [];
const pythonExecutable = resolveFcntlPython();

function tempDataDir(): string {
    const root = mkdtempSync(join(tmpdir(), "very-happy-pglite-lock-"));
    roots.push(root);
    return join(root, "db");
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PGlite process lock", () => {
    it("rejects a second live owner and releases idempotently", () => {
        const dataDir = tempDataDir();
        const first = acquirePGliteProcessLock(dataDir);

        expect(() => acquirePGliteProcessLock(dataDir)).toThrow(/already open by another process/);

        first.release();
        first.release();
        const next = acquirePGliteProcessLock(dataDir);
        next.release();
    });

    it("canonicalizes symlink aliases to the same kernel lock", () => {
        const root = mkdtempSync(join(tmpdir(), "very-happy-pglite-alias-"));
        roots.push(root);
        const dataDir = join(root, "real-db");
        const aliasDir = join(root, "alias-db");
        mkdirSync(dataDir);
        symlinkSync(dataDir, aliasDir, "dir");

        expect(pgliteLockTarget(aliasDir)).toBe(pgliteLockTarget(dataDir));
        const first = acquirePGliteProcessLock(dataDir);
        expect(() => acquirePGliteProcessLock(aliasDir)).toThrow(/already open by another process/);
        first.release();
    });

    it.skipIf(!pythonExecutable)(
        "lets the kernel release a crashed cross-process owner",
        async () => {
            const dataDir = tempDataDir();
            const lockTarget = pgliteLockTarget(dataDir);
            const child = spawn(pythonExecutable!, ["-u", "-c", [
                "import fcntl, os, sys, time",
                "fd = os.open(sys.argv[1], os.O_RDONLY)",
                "fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
                "print('ready', flush=True)",
                "time.sleep(30)",
            ].join("\n"), lockTarget], {
                stdio: ["ignore", "pipe", "pipe"],
            });
            try {
                await Promise.race([
                    once(child.stdout!, "data"),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("lock child did not become ready")), 3_000)),
                ]);
                expect(() => acquirePGliteProcessLock(dataDir)).toThrow(/already open by another process/);
                child.kill("SIGKILL");
                await once(child, "exit");

                const recovered = acquirePGliteProcessLock(dataDir);
                recovered.release();
            } finally {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }
        },
    );

    it.skipIf(!pythonExecutable)("allows exactly one winner under concurrent kernel contenders", async () => {
        const dataDir = tempDataDir();
        const lockTarget = pgliteLockTarget(dataDir);
        const barrier = join(dataDir, "contenders-ready");
        const script = [
            "import fcntl, os, sys, time",
            "while not os.path.exists(sys.argv[2]): time.sleep(0.005)",
            "fd = os.open(sys.argv[1], os.O_RDONLY)",
            "try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
            "except BlockingIOError: sys.exit(3)",
            "time.sleep(1)",
        ].join("\n");
        const contenders = Array.from({ length: 10 }, () =>
            spawn(pythonExecutable!, ["-c", script, lockTarget, barrier], { stdio: "ignore" }),
        );
        writeFileSync(barrier, "go");
        const statuses = await Promise.all(contenders.map(async child => {
            const [status] = await once(child, "exit");
            return status;
        }));
        expect(statuses.filter(status => status === 0)).toHaveLength(1);
        expect(statuses.filter(status => status === 3)).toHaveLength(9);
    }, 10_000);

    it("holds the guard for the full PGlite lifetime", async () => {
        const dataDir = tempDataDir();
        const pg = createPGlite(dataDir);
        await pg.waitReady;

        expect(() => createPGlite(dataDir)).toThrow(/already open by another process/);

        await pg.close();
        const reopened = createPGlite(dataDir);
        await reopened.waitReady;
        expect((await reopened.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
        await reopened.close();
    }, 15_000);
});
