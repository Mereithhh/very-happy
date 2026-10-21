/**
 * B-688 per-machine cache of `model-config-read` (memory only). The settings
 * page and the editor load it; the composer picker reads `pickerModels` from it
 * so a model saved in the editor shows up in the picker at once. Transport is
 * injectable for tests (btwStore precedent).
 */
import { create } from 'zustand';
import type { ModelConfigRpcResult } from './modelConfigOps';
import type { HarnessConfigView, HarnessId, ModelConfigReadResult } from './modelConfigTypes';

export type MachineModelConfigState =
    | { status: 'loading'; data?: ModelConfigReadResult }
    | { status: 'ready'; data: ModelConfigReadResult; at: number }
    | { status: 'error'; error: string; unsupported: boolean; data?: ModelConfigReadResult };

interface ModelConfigStoreState {
    machines: Record<string, MachineModelConfigState>;
    /** Load (deduped); `force` refetches even when fresh. */
    load: (machineId: string, opts?: { force?: boolean }) => Promise<void>;
    /** Replace one harness view after a write (the daemon returns the fresh view). */
    setHarnessView: (machineId: string, view: HarnessConfigView) => void;
}

export interface ModelConfigStoreDeps {
    read: (machineId: string) => Promise<ModelConfigRpcResult<ModelConfigReadResult>>;
    now: () => number;
    /** How long a ready entry counts as fresh for non-forced loads. */
    ttlMs?: number;
}

export function createModelConfigStore(deps: ModelConfigStoreDeps) {
    const ttl = deps.ttlMs ?? 60_000;
    const inFlight = new Map<string, Promise<void>>();
    return create<ModelConfigStoreState>((set, get) => ({
        machines: {},
        load: (machineId, opts) => {
            const current = get().machines[machineId];
            if (!opts?.force && current?.status === 'ready' && deps.now() - current.at < ttl) return Promise.resolve();
            const pending = inFlight.get(machineId);
            if (pending) return pending;
            set((s) => ({ machines: { ...s.machines, [machineId]: { status: 'loading', data: s.machines[machineId]?.data } } }));
            const run = deps.read(machineId).then((result) => {
                set((s) => ({
                    machines: {
                        ...s.machines,
                        [machineId]: result.ok
                            ? { status: 'ready', data: result.data, at: deps.now() }
                            : { status: 'error', error: result.error, unsupported: result.unsupported, data: s.machines[machineId]?.data },
                    },
                }));
            }).finally(() => inFlight.delete(machineId));
            inFlight.set(machineId, run);
            return run;
        },
        setHarnessView: (machineId, view) => set((s) => {
            const current = s.machines[machineId];
            const data = current?.data ?? { version: 1, harnesses: [] };
            const harnesses = data.harnesses.some((h) => h.harness === view.harness)
                ? data.harnesses.map((h) => (h.harness === view.harness ? view : h))
                : [...data.harnesses, view];
            return { machines: { ...s.machines, [machineId]: { status: 'ready', data: { ...data, harnesses }, at: deps.now() } } };
        }),
    }));
}

export const modelConfigStore = createModelConfigStore({
    read: (machineId) => import('./modelConfigOps').then((ops) => ops.modelConfigRead(machineId)),
    now: () => Date.now(),
});

const NO_MODELS: readonly string[] = Object.freeze([]);

export function useMachineModelConfig(machineId: string | null | undefined): MachineModelConfigState | undefined {
    return modelConfigStore((s) => (machineId ? s.machines[machineId] : undefined));
}

/** Custom model keys for this machine × harness (empty until loaded). */
export function useCustomPickerModels(machineId: string | null | undefined, harness: HarnessId | null): readonly string[] {
    return modelConfigStore((s) => {
        if (!machineId || !harness) return NO_MODELS;
        return s.machines[machineId]?.data?.harnesses.find((h) => h.harness === harness)?.pickerModels ?? NO_MODELS;
    });
}
