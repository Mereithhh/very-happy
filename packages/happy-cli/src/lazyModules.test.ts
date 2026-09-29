import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAZY_MODULES } from './lazyModules';

/**
 * B-512: `--self-check` is only a smoke test if it loads every module the CLI
 * can reach through a dynamic `import()`. This test fails when an `import()`
 * anywhere under src/ is missing from LAZY_MODULES.
 */
const SRC = __dirname;
const IMPORT_CALL = /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g;

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            if (name === 'testing' || name === 'node_modules') continue;
            out.push(...sourceFiles(full));
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}

/** Runtime `import('x')` targets. Type positions (`import('x').T`, `typeof import('x')`) and comments are skipped. */
export function runtimeImportTargets(source: string): string[] {
    const targets: string[] = [];
    for (const line of source.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        for (const match of line.matchAll(IMPORT_CALL)) {
            const after = line.slice(match.index! + match[0].length);
            const before = line.slice(0, match.index!);
            if (after.startsWith('.') || /typeof\s*$/.test(before)) continue;
            targets.push(match[2]);
        }
    }
    return targets;
}

/** Canonical key: a path relative to src/ without extension, or the bare package name. */
function canonical(target: string, fromFile: string): string | null {
    if (target.startsWith('node:')) return null;
    let base: string;
    if (target.startsWith('@/')) base = join(SRC, target.slice(2));
    else if (target.startsWith('.')) base = resolve(dirname(fromFile), target);
    else return target;
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
        if (existsSync(candidate)) return relative(SRC, candidate).replace(/\.tsx?$/, '').replace(/\/index$/, '');
    }
    throw new Error(`cannot resolve import('${target}') from ${relative(SRC, fromFile)}`);
}

describe('LAZY_MODULES (B-512 --self-check coverage)', () => {
    const listFile = join(SRC, 'lazyModules.ts');
    const listed = new Set(runtimeImportTargets(readFileSync(listFile, 'utf8')).map((t) => canonical(t, listFile)));

    it('lists every runtime import() target under src/', () => {
        const missing: string[] = [];
        for (const file of sourceFiles(SRC)) {
            if (file === listFile) continue;
            for (const target of runtimeImportTargets(readFileSync(file, 'utf8'))) {
                const key = canonical(target, file);
                if (key && !listed.has(key)) missing.push(`${relative(SRC, file)}: import('${target}')`);
            }
        }
        expect(missing).toEqual([]);
    });

    it('has one loader per entry and every loader is a literal import()', () => {
        expect(listed.size).toBe(LAZY_MODULES.length);
        expect(new Set(LAZY_MODULES.map(([name]) => name)).size).toBe(LAZY_MODULES.length);
    });

    it('recognises runtime vs type-position imports', () => {
        expect(runtimeImportTargets(`const { a } = await import('./a');`)).toEqual(['./a']);
        expect(runtimeImportTargets(`await (await import('./b')).run()`)).toEqual(['./b']);
        expect(runtimeImportTargets(`let x: import('./types').T;`)).toEqual([]);
        expect(runtimeImportTargets(`type M = typeof import('node:fs');`)).toEqual([]);
        expect(runtimeImportTargets(`// await import('./c')`)).toEqual([]);
    });
});
