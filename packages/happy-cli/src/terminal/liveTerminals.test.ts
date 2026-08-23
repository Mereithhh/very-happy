import { describe, it, expect } from "vitest";
import {
    sanitizeLiveSnapshot,
    serializeLiveSnapshot,
    liveSnapshotChanged,
    pickMirrorForTerminal,
    isClaudeSessionId,
    LIVE_SNAPSHOT_TTL_MS,
    type LiveTerminalInfo,
} from "./liveTerminals";

const NOW = 1_800_000_000_000;
const UUID = "c0c26854-5e0c-4063-aaeb-d4428fe8ed94";

function map(entries: Array<[string, LiveTerminalInfo]>): Map<string, LiveTerminalInfo> {
    return new Map(entries);
}

describe("sanitizeLiveSnapshot", () => {
    it("keeps well-formed entries and drops malformed ones", () => {
        const out = sanitizeLiveSnapshot({
            a: { title: "t", cwd: "/x", seenAt: NOW - 1000 },
            b: { seenAt: "nope" },
            c: null,
            d: { title: "  ", cwd: "", seenAt: NOW },
        }, NOW);
        expect([...out.keys()].sort()).toEqual(["a", "d"]);
        expect(out.get("a")).toEqual({ title: "t", cwd: "/x", seenAt: NOW - 1000 });
        // blank title / empty cwd normalize to undefined rather than "" noise
        expect(out.get("d")).toEqual({ title: undefined, cwd: undefined, seenAt: NOW });
    });

    it("returns empty for non-object input (missing / corrupt file)", () => {
        expect(sanitizeLiveSnapshot(undefined, NOW).size).toBe(0);
        expect(sanitizeLiveSnapshot("x", NOW).size).toBe(0);
        expect(sanitizeLiveSnapshot([1, 2], NOW).size).toBe(0);
    });

    it("drops entries past the TTL", () => {
        const out = sanitizeLiveSnapshot({
            fresh: { seenAt: NOW - 1000 },
            stale: { seenAt: NOW - LIVE_SNAPSHOT_TTL_MS - 1 },
        }, NOW);
        expect([...out.keys()]).toEqual(["fresh"]);
    });

    it("caps at max, keeping the newest", () => {
        const raw: Record<string, LiveTerminalInfo> = {};
        for (let i = 0; i < 10; i++) raw["id" + i] = { seenAt: NOW - i * 1000 };
        const out = sanitizeLiveSnapshot(raw, NOW, LIVE_SNAPSHOT_TTL_MS, 3);
        expect([...out.keys()]).toEqual(["id0", "id1", "id2"]);
    });
});

describe("serializeLiveSnapshot", () => {
    it("round-trips through sanitize", () => {
        const m = map([["a", { title: "t", cwd: "/x", seenAt: NOW }]]);
        expect(sanitizeLiveSnapshot(serializeLiveSnapshot(m), NOW)).toEqual(m);
    });

    it("caps newest-first", () => {
        const m = map([
            ["old", { seenAt: NOW - 5000 }],
            ["new", { seenAt: NOW }],
        ]);
        expect(Object.keys(serializeLiveSnapshot(m, 1))).toEqual(["new"]);
    });
});

describe("liveSnapshotChanged", () => {
    it("is false when only seenAt drifts (the common tick writes nothing)", () => {
        const prev = map([["a", { title: "t", cwd: "/x", seenAt: NOW - 60_000 }]]);
        const next = map([["a", { title: "t", cwd: "/x", seenAt: NOW }]]);
        expect(liveSnapshotChanged(prev, next)).toBe(false);
    });

    it("is true on membership, title or cwd change", () => {
        const base = map([["a", { title: "t", cwd: "/x", seenAt: NOW }]]);
        expect(liveSnapshotChanged(base, map([]))).toBe(true);
        expect(liveSnapshotChanged(base, map([["b", { seenAt: NOW }]]))).toBe(true);
        expect(liveSnapshotChanged(base, map([["a", { title: "u", cwd: "/x", seenAt: NOW }]]))).toBe(true);
        expect(liveSnapshotChanged(base, map([["a", { title: "t", cwd: "/y", seenAt: NOW }]]))).toBe(true);
    });
});

describe("isClaudeSessionId", () => {
    it("accepts a uuid and rejects anything a command line must not see", () => {
        expect(isClaudeSessionId(UUID)).toBe(true);
        expect(isClaudeSessionId("c0c26854")).toBe(false);
        expect(isClaudeSessionId(UUID + "; rm -rf /")).toBe(false);
        expect(isClaudeSessionId(undefined)).toBe(false);
    });
});

describe("pickMirrorForTerminal", () => {
    const sessions = {
        older: { savedAt: 1000, metadata: { flavor: "terminal-mirror", terminalId: "t1", claudeSessionId: UUID } },
        newer: { savedAt: 2000, metadata: { flavor: "terminal-mirror", terminalId: "t1", claudeSessionId: "11111111-2222-3333-4444-555555555555" } },
        other: { savedAt: 3000, metadata: { flavor: "terminal-mirror", terminalId: "t2", claudeSessionId: UUID } },
        noMeta: { savedAt: 4000, metadata: null },
    };

    it("picks the newest session of the exact terminal", () => {
        expect(pickMirrorForTerminal(sessions, "t1")).toEqual({
            sessionId: "newer",
            claudeSessionId: "11111111-2222-3333-4444-555555555555",
        });
    });

    it("never bleeds across terminals and tolerates junk", () => {
        expect(pickMirrorForTerminal(sessions, "t3")).toBeNull();
        expect(pickMirrorForTerminal({}, "t1")).toBeNull();
        expect(pickMirrorForTerminal(sessions, "")).toBeNull();
    });

    it("reports the mirror without a claude id when the id is malformed", () => {
        const res = pickMirrorForTerminal({
            s: { savedAt: 1, metadata: { terminalId: "t1", claudeSessionId: "not-a-uuid" } },
        }, "t1");
        expect(res).toEqual({ sessionId: "s", claudeSessionId: undefined });
    });
});
