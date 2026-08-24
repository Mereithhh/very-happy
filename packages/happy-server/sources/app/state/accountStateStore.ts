import type { Machine, Prisma, Session } from '@prisma/client';
import {
    assertAccountResourceQuota,
    configuredResourceLimit,
    enforceAccountWriteRate,
    lockAccountResources,
} from '@/app/api/resourceLimits';
import { base64BytesSchema, utf8StringSchema } from '@/app/api/resourceSchemas';
import { inTx } from '@/storage/inTx';
import { decodePrismaBytes } from '@/storage/prismaBytes';
import { allocateUserSeq } from '@/storage/seq';
import { z } from 'zod';

export const STATE_ID_MAX_BYTES = 256;
export const SESSION_TAG_MAX_BYTES = 256;
export const SESSION_METADATA_MAX_BYTES = 256 * 1024;
export const SESSION_AGENT_STATE_MAX_BYTES = 512 * 1024;
export const MACHINE_METADATA_MAX_BYTES = 256 * 1024;
export const MACHINE_DAEMON_STATE_MAX_BYTES = 512 * 1024;
export const STATE_DATA_KEY_MAX_DECODED_BYTES = 4 * 1024;
export const STATE_WRITE_UNIT_BYTES = 64 * 1024;

export const stateIdSchema = utf8StringSchema({ minBytes: 1, maxBytes: STATE_ID_MAX_BYTES });
export const sessionTagSchema = utf8StringSchema({ minBytes: 1, maxBytes: SESSION_TAG_MAX_BYTES });
export const sessionMetadataSchema = utf8StringSchema({ maxBytes: SESSION_METADATA_MAX_BYTES });
export const sessionAgentStateSchema = utf8StringSchema({ maxBytes: SESSION_AGENT_STATE_MAX_BYTES }).nullable();
export const machineMetadataSchema = utf8StringSchema({ maxBytes: MACHINE_METADATA_MAX_BYTES });
export const machineDaemonStateValueSchema = utf8StringSchema({ maxBytes: MACHINE_DAEMON_STATE_MAX_BYTES });
export const machineDaemonStateSchema = machineDaemonStateValueSchema.nullable();
export const stateDataKeySchema = base64BytesSchema(STATE_DATA_KEY_MAX_DECODED_BYTES).nullable();

export const sessionCreateSchema = z.object({
    tag: sessionTagSchema,
    metadata: sessionMetadataSchema,
    agentState: sessionAgentStateSchema.optional(),
    dataEncryptionKey: stateDataKeySchema.optional(),
}).strict();

export const machineCreateSchema = z.object({
    id: stateIdSchema,
    metadata: machineMetadataSchema,
    daemonState: machineDaemonStateSchema.optional(),
    dataEncryptionKey: stateDataKeySchema.optional(),
}).strict();

function storedBytes(...values: Array<string | null | undefined>): number {
    return values.reduce<number>((total, value) => total + (value === null || value === undefined
        ? 0
        : Buffer.byteLength(value, 'utf8')), 0);
}

function writeUnits(...values: Array<string | null | undefined>): number {
    return Math.max(1, Math.ceil(storedBytes(...values) / STATE_WRITE_UNIT_BYTES));
}

async function enforceSessionStateWriteRate(accountId: string, ...values: Array<string | null | undefined>) {
    await enforceAccountWriteRate({
        accountId,
        resource: 'session_state',
        units: writeUnits(...values),
        envName: 'MAX_SESSION_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE',
        fallback: 600,
    });
}

async function enforceMachineStateWriteRate(accountId: string, ...values: Array<string | null | undefined>) {
    await enforceAccountWriteRate({
        accountId,
        resource: 'machine_state',
        units: writeUnits(...values),
        envName: 'MAX_MACHINE_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE',
        fallback: 240,
    });
}

async function sessionStateBytes(tx: Prisma.TransactionClient, accountId: string): Promise<number> {
    const rows = await tx.$queryRawUnsafe<Array<{ bytes: bigint }>>(
        `SELECT COALESCE(SUM(octet_length("metadata") + COALESCE(octet_length("agentState"), 0)), 0)::bigint AS "bytes"
         FROM "Session"
         WHERE "accountId" = $1`,
        accountId,
    );
    return Number(rows[0]?.bytes ?? 0);
}

async function machineStateBytes(tx: Prisma.TransactionClient, accountId: string): Promise<number> {
    const rows = await tx.$queryRawUnsafe<Array<{ bytes: bigint }>>(
        `SELECT COALESCE(SUM(octet_length("metadata") + COALESCE(octet_length("daemonState"), 0)), 0)::bigint AS "bytes"
         FROM "Machine"
         WHERE "accountId" = $1`,
        accountId,
    );
    return Number(rows[0]?.bytes ?? 0);
}

function assertStateBytes(resource: 'session_state' | 'machine_state', current: number, delta: number) {
    assertAccountResourceQuota({
        resource,
        current: { count: 0, bytes: current },
        delta: { count: 0, bytes: delta },
        limits: {
            count: 0,
            bytes: configuredResourceLimit(
                resource === 'session_state'
                    ? 'MAX_SESSION_STATE_BYTES_PER_ACCOUNT'
                    : 'MAX_MACHINE_STATE_BYTES_PER_ACCOUNT',
                resource === 'session_state' ? 256 * 1024 * 1024 : 16 * 1024 * 1024,
            ),
        },
    });
}

export type CreateSessionResult =
    | { kind: 'count-limit'; limit: number }
    | { kind: 'success'; session: Session; updateSeq: number | null; created: boolean };

export async function createSessionWithQuota(options: {
    accountId: string;
    tag: string;
    metadata: string;
    agentState?: string | null;
    dataEncryptionKey?: string | null;
}): Promise<CreateSessionResult> {
    const parsed = sessionCreateSchema.parse({
        tag: options.tag,
        metadata: options.metadata,
        agentState: options.agentState,
        dataEncryptionKey: options.dataEncryptionKey,
    });
    await enforceSessionStateWriteRate(options.accountId, parsed.metadata, parsed.agentState);
    const maxSessions = configuredResourceLimit('MAX_SESSIONS_PER_ACCOUNT', 500);

    return inTx(async (tx) => {
        await lockAccountResources(tx, options.accountId);
        const existing = await tx.session.findFirst({ where: { accountId: options.accountId, tag: parsed.tag } });
        if (existing) return { kind: 'success' as const, session: existing, updateSeq: null, created: false };
        if (maxSessions > 0 && await tx.session.count({ where: { accountId: options.accountId } }) >= maxSessions) {
            return { kind: 'count-limit' as const, limit: maxSessions };
        }
        assertStateBytes(
            'session_state',
            await sessionStateBytes(tx, options.accountId),
            storedBytes(parsed.metadata, parsed.agentState),
        );
        const updateSeq = await allocateUserSeq(options.accountId, tx);
        const session = await tx.session.create({
            data: {
                accountId: options.accountId,
                tag: parsed.tag,
                metadata: parsed.metadata,
                agentState: parsed.agentState ?? null,
                agentStateVersion: parsed.agentState ? 1 : 0,
                dataEncryptionKey: parsed.dataEncryptionKey ? decodePrismaBytes(parsed.dataEncryptionKey) : undefined,
            },
        });
        return { kind: 'success' as const, session, updateSeq, created: true };
    });
}

export type CreateMachineResult =
    | { kind: 'count-limit'; limit: number }
    | { kind: 'success'; machine: Machine; updateSeqs: [number, number] | null; created: boolean };

export async function createMachineWithQuota(options: {
    accountId: string;
    id: string;
    metadata: string;
    daemonState?: string | null;
    dataEncryptionKey?: string | null;
}): Promise<CreateMachineResult> {
    const parsed = machineCreateSchema.parse({
        id: options.id,
        metadata: options.metadata,
        daemonState: options.daemonState,
        dataEncryptionKey: options.dataEncryptionKey,
    });
    await enforceMachineStateWriteRate(options.accountId, parsed.metadata, parsed.daemonState);
    const maxMachines = configuredResourceLimit('MAX_MACHINES_PER_ACCOUNT', 20);

    return inTx(async (tx) => {
        await lockAccountResources(tx, options.accountId);
        const existing = await tx.machine.findFirst({ where: { accountId: options.accountId, id: parsed.id } });
        if (existing) return { kind: 'success' as const, machine: existing, updateSeqs: null, created: false };
        if (maxMachines > 0 && await tx.machine.count({ where: { accountId: options.accountId } }) >= maxMachines) {
            return { kind: 'count-limit' as const, limit: maxMachines };
        }
        assertStateBytes(
            'machine_state',
            await machineStateBytes(tx, options.accountId),
            storedBytes(parsed.metadata, parsed.daemonState),
        );
        const machine = await tx.machine.create({
            data: {
                id: parsed.id,
                accountId: options.accountId,
                metadata: parsed.metadata,
                metadataVersion: 1,
                daemonState: parsed.daemonState ?? null,
                daemonStateVersion: parsed.daemonState ? 1 : 0,
                dataEncryptionKey: parsed.dataEncryptionKey ? decodePrismaBytes(parsed.dataEncryptionKey) : undefined,
                active: false,
            },
        });
        const updateSeqs: [number, number] = [
            await allocateUserSeq(options.accountId, tx),
            await allocateUserSeq(options.accountId, tx),
        ];
        return { kind: 'success' as const, machine, updateSeqs, created: true };
    });
}

export type UpdateSessionStateResult =
    | { kind: 'not-found' }
    | { kind: 'version-mismatch'; session: Session }
    | { kind: 'success'; session: Session; updateSeq: number };

export async function updateSessionStateWithQuota(options: {
    accountId: string;
    sessionId: string;
    field: 'metadata' | 'agentState';
    value: string | null;
    expectedVersion: number;
}): Promise<UpdateSessionStateResult> {
    const sessionId = stateIdSchema.parse(options.sessionId);
    const value = options.field === 'metadata'
        ? sessionMetadataSchema.parse(options.value)
        : sessionAgentStateSchema.parse(options.value);
    const expectedVersion = z.number().int().min(0).parse(options.expectedVersion);
    await enforceSessionStateWriteRate(options.accountId, value);

    return inTx(async (tx) => {
        await lockAccountResources(tx, options.accountId);
        const session = await tx.session.findFirst({ where: { id: sessionId, accountId: options.accountId } });
        if (!session) return { kind: 'not-found' as const };
        const versionField = options.field === 'metadata' ? 'metadataVersion' : 'agentStateVersion';
        if (session[versionField] !== expectedVersion) {
            return { kind: 'version-mismatch' as const, session };
        }
        const currentValue = session[options.field];
        assertStateBytes(
            'session_state',
            await sessionStateBytes(tx, options.accountId),
            storedBytes(value) - storedBytes(currentValue),
        );
        const updated = await tx.session.update({
            where: { id: session.id },
            data: options.field === 'metadata'
                ? { metadata: value as string, metadataVersion: expectedVersion + 1 }
                : { agentState: value, agentStateVersion: expectedVersion + 1 },
        });
        return {
            kind: 'success' as const,
            session: updated,
            updateSeq: await allocateUserSeq(options.accountId, tx),
        };
    });
}

export type UpdateMachineStateResult =
    | { kind: 'not-found' }
    | { kind: 'version-mismatch'; machine: Machine }
    | { kind: 'success'; machine: Machine; updateSeq: number };

export async function updateMachineStateWithQuota(options: {
    accountId: string;
    machineId: string;
    field: 'metadata' | 'daemonState';
    value: string | null;
    expectedVersion: number;
}): Promise<UpdateMachineStateResult> {
    const machineId = stateIdSchema.parse(options.machineId);
    const value = options.field === 'metadata'
        ? machineMetadataSchema.parse(options.value)
        : machineDaemonStateValueSchema.parse(options.value);
    const expectedVersion = z.number().int().min(0).parse(options.expectedVersion);
    await enforceMachineStateWriteRate(options.accountId, value);

    return inTx(async (tx) => {
        await lockAccountResources(tx, options.accountId);
        const machine = await tx.machine.findFirst({ where: { id: machineId, accountId: options.accountId } });
        if (!machine) return { kind: 'not-found' as const };
        const versionField = options.field === 'metadata' ? 'metadataVersion' : 'daemonStateVersion';
        if (machine[versionField] !== expectedVersion) {
            return { kind: 'version-mismatch' as const, machine };
        }
        const currentValue = machine[options.field];
        assertStateBytes(
            'machine_state',
            await machineStateBytes(tx, options.accountId),
            storedBytes(value) - storedBytes(currentValue),
        );
        const updated = await tx.machine.update({
            where: { accountId_id: { accountId: options.accountId, id: machine.id } },
            data: options.field === 'metadata'
                ? { metadata: value as string, metadataVersion: expectedVersion + 1 }
                : {
                    daemonState: value,
                    daemonStateVersion: expectedVersion + 1,
                    active: true,
                    lastActiveAt: new Date(),
                },
        });
        return {
            kind: 'success' as const,
            machine: updated,
            updateSeq: await allocateUserSeq(options.accountId, tx),
        };
    });
}
