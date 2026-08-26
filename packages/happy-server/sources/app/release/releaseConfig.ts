export type ReleaseSlot = 'blue' | 'green';

export type ReleaseConfig = {
    slot: ReleaseSlot;
    release: string;
    adminToken: string;
    adapterWarmupMs: number;
};

function positiveInteger(value: string | undefined, fallback: number): number {
    if (!value?.trim()) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('VH_RELEASE_ADAPTER_WARMUP_MS must be a positive integer');
    return parsed;
}
export function resolveReleaseConfig(env: NodeJS.ProcessEnv = process.env): ReleaseConfig | null {
    const values = [env.VH_RELEASE_SLOT, env.VH_RELEASE_SHA, env.VH_RELEASE_ADMIN_TOKEN];
    if (values.every((value) => !value?.trim())) return null;
    if (values.some((value) => !value?.trim())) {
        throw new Error('VH_RELEASE_SLOT, VH_RELEASE_SHA and VH_RELEASE_ADMIN_TOKEN must be configured together');
    }
    const slot = env.VH_RELEASE_SLOT!.trim();
    if (slot !== 'blue' && slot !== 'green') throw new Error('VH_RELEASE_SLOT must be blue or green');
    const release = env.VH_RELEASE_SHA!.trim();
    if (!/^[0-9a-f]{40}$/.test(release)) throw new Error('VH_RELEASE_SHA must be a 40-character lowercase commit SHA');
    const adminToken = env.VH_RELEASE_ADMIN_TOKEN!.trim();
    if (adminToken.length < 32) throw new Error('VH_RELEASE_ADMIN_TOKEN must be at least 32 characters');
    return {
        slot,
        release,
        adminToken,
        adapterWarmupMs: positiveInteger(env.VH_RELEASE_ADAPTER_WARMUP_MS, 10_000),
    };
}
