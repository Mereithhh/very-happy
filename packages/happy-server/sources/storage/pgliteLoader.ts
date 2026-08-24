import { PGlite } from "@electric-sql/pglite";
import * as fs from "fs";
import * as path from "path";
import { acquirePGliteProcessLock } from "./pgliteProcessLock";

type WebAssemblyModuleCtor = new (bytes: Buffer) => WebAssembly.Module;

function getWebAssemblyModuleCtor(): WebAssemblyModuleCtor | null {
    const moduleCtor = (globalThis as { WebAssembly?: { Module?: unknown } }).WebAssembly?.Module;
    return typeof moduleCtor === "function"
        ? (moduleCtor as WebAssemblyModuleCtor)
        : null;
}

function findWasmFiles(): { wasmModule: WebAssembly.Module; fsBundle: Blob } | null {
    const wasmModuleCtor = getWebAssemblyModuleCtor();
    if (!wasmModuleCtor) {
        return null;
    }
    const searchPaths = [
        process.cwd(),
        path.dirname(process.execPath),
    ];

    for (const dir of searchPaths) {
        const wasmPath = path.join(dir, "pglite.wasm");
        const dataPath = path.join(dir, "pglite.data");
        if (fs.existsSync(wasmPath) && fs.existsSync(dataPath)) {
            const wasmModule = new wasmModuleCtor(fs.readFileSync(wasmPath));
            const fsBundle = new Blob([fs.readFileSync(dataPath)]);
            return { wasmModule, fsBundle };
        }
    }
    return null;
}

export function createPGlite(dataDir: string): PGlite {
    const lock = acquirePGliteProcessLock(dataDir);
    try {
        const wasmOpts = findWasmFiles();
        const pg = wasmOpts
            ? new PGlite({ dataDir, ...wasmOpts })
            : new PGlite(dataDir);
        const close = pg.close.bind(pg);
        let closePromise: Promise<void> | undefined;
        pg.close = () => {
            // Never release the exclusivity boundary after a failed database
            // close. A still-live backend is safer than allowing a second
            // process to enter; process exit will release a kernel flock.
            closePromise ??= close().then(() => lock.release());
            return closePromise;
        };
        return pg;
    } catch (error) {
        lock.release();
        throw error;
    }
}
