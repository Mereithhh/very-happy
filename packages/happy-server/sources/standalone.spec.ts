import { describe, expect, it } from "vitest";
import { isStandaloneEntrypoint, resolveDatabaseProvider, resolveHtmlConfig } from "./standalone";

describe("isStandaloneEntrypoint", () => {
    it("recognizes standalone script paths on Windows and POSIX", () => {
        expect(isStandaloneEntrypoint("C:\\Projects\\Work\\happy\\packages\\happy-server\\sources\\standalone.ts")).toBe(true);
        expect(isStandaloneEntrypoint("/repo/packages/happy-server/sources/standalone.ts")).toBe(true);
        expect(isStandaloneEntrypoint("/repo/packages/happy-server/dist/happy-server")).toBe(true);
        expect(isStandaloneEntrypoint("C:\\repo\\packages\\happy-server\\dist\\happy-server.exe")).toBe(true);
    });

    it("rejects unrelated entrypoints", () => {
        expect(isStandaloneEntrypoint("C:\\repo\\node_modules\\vitest\\vitest.mjs")).toBe(false);
        expect(isStandaloneEntrypoint("/repo/packages/happy-server/sources/main.ts")).toBe(false);
    });
});

describe("resolveDatabaseProvider", () => {
    it("uses Postgres whenever DATABASE_URL is configured", () => {
        expect(resolveDatabaseProvider({ DATABASE_URL: "postgresql://db/example" } as NodeJS.ProcessEnv)).toBe("postgres");
        expect(resolveDatabaseProvider({ DB_PROVIDER: "postgres" } as NodeJS.ProcessEnv)).toBe("postgres");
    });

    it("keeps explicit and default standalone PGlite behavior", () => {
        expect(resolveDatabaseProvider({} as NodeJS.ProcessEnv)).toBe("pglite");
        expect(resolveDatabaseProvider({ DB_PROVIDER: "pglite", DATABASE_URL: "postgresql://ignored" } as NodeJS.ProcessEnv)).toBe("pglite");
    });
});

describe("resolveHtmlConfig", () => {
    it("keeps a self-hosted Web bundle on the serving origin by default", () => {
        expect(resolveHtmlConfig({} as NodeJS.ProcessEnv)).toEqual({ serverUrl: "same-origin" });
        expect(resolveHtmlConfig({ PUBLIC_URL: "https://relay.example" } as NodeJS.ProcessEnv))
            .toEqual({ serverUrl: "https://relay.example" });
    });

    it("merges operator metadata without losing the safe default and fails closed on malformed JSON", () => {
        expect(resolveHtmlConfig({ HAPPY_INJECT_HTML_CONFIG: '{"buildCommitSha":"abc"}' } as NodeJS.ProcessEnv))
            .toEqual({ serverUrl: "same-origin", buildCommitSha: "abc" });
        expect(resolveHtmlConfig({ HAPPY_INJECT_HTML_CONFIG: 'not-json' } as NodeJS.ProcessEnv))
            .toEqual({ serverUrl: "same-origin" });
    });
});
