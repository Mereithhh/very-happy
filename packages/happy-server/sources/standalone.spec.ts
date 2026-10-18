import { describe, expect, it } from "vitest";
import { isStandaloneEntrypoint, resolveBindHost, resolveBrandHtmlConfig, resolveDatabaseProvider, resolveHtmlConfig } from "./standalone";

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

    it("B-624: emits brand and landing keys only when the operator sets them, and rejects unsafe values", () => {
        expect(resolveBrandHtmlConfig({} as NodeJS.ProcessEnv)).toEqual({});
        expect(resolveHtmlConfig({ BRAND_NAME: " Apodex Vibe ", BRAND_LOGO_URL: "https://cdn.example/logo.svg", WEB_LANDING: "off" } as NodeJS.ProcessEnv))
            .toEqual({ serverUrl: "same-origin", brand: { name: "Apodex Vibe", logoUrl: "https://cdn.example/logo.svg" }, landing: false });
        expect(resolveBrandHtmlConfig({ BRAND_LOGO_URL: "/brand/logo.png", WEB_LANDING: "on" } as NodeJS.ProcessEnv)).toEqual({ brand: { logoUrl: "/brand/logo.png" } });
        expect(() => resolveBrandHtmlConfig({ BRAND_LOGO_URL: "javascript:alert(1)" } as NodeJS.ProcessEnv)).toThrow("BRAND_LOGO_URL");
        expect(() => resolveBrandHtmlConfig({ BRAND_LOGO_URL: "//evil.example/x.png" } as NodeJS.ProcessEnv)).toThrow("BRAND_LOGO_URL");
        expect(() => resolveBrandHtmlConfig({ WEB_LANDING: "false" } as NodeJS.ProcessEnv)).toThrow("WEB_LANDING");
        // Explicit JSON still wins over env for operators who already inject it.
        expect(resolveHtmlConfig({ BRAND_NAME: "A", HAPPY_INJECT_HTML_CONFIG: '{"brand":{"name":"B"}}' } as NodeJS.ProcessEnv)).toEqual({ serverUrl: "same-origin", brand: { name: "B" } });
    });
});

describe("resolveBindHost", () => {
    it("stays loopback-only for an unpackaged standalone server", () => {
        expect(resolveBindHost({} as NodeJS.ProcessEnv)).toBe("127.0.0.1");
    });

    it("honors an explicit host and preserves the legacy production bind mount", () => {
        expect(resolveBindHost({ HOST: " 192.0.2.10 " } as NodeJS.ProcessEnv)).toBe("192.0.2.10");
        expect(resolveBindHost({ HAPPY_STATIC_DIR: "/webapp" } as NodeJS.ProcessEnv)).toBe("0.0.0.0");
    });
});
