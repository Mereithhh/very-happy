import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { stashReconnectEnv, takeReconnectEnv } from './reconnectEnv';

const handoff = () => ({
    HAPPY_RECONNECT_SESSION_ID: 's1',
    HAPPY_RECONNECT_ENCRYPTION_KEY: 'a2V5',
    HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey',
    HAPPY_RECONNECT_SEQ: '42',
    HAPPY_RECONNECT_METADATA_VERSION: '7',
    HAPPY_RECONNECT_AGENT_STATE_VERSION: '3',
});

describe('reconnect env hand-off (B-858)', () => {
    afterEach(() => {
        takeReconnectEnv({});
        for (const key of Object.keys(handoff())) delete process.env[key];
    });

    it('stash removes every HAPPY_RECONNECT_* from env and keeps the rest', () => {
        const env: NodeJS.ProcessEnv = { ...handoff(), HAPPY_HOME_DIR: '/h', PATH: '/bin' };
        stashReconnectEnv(env);
        expect(env).toEqual({ HAPPY_HOME_DIR: '/h', PATH: '/bin' });
        expect(takeReconnectEnv(env)).toEqual(handoff());
    });

    it('take hands the stash out once', () => {
        stashReconnectEnv({ ...handoff() });
        expect(takeReconnectEnv({}).HAPPY_RECONNECT_ENCRYPTION_KEY).toBe('a2V5');
        expect(takeReconnectEnv({})).toEqual({});
    });

    it('take strips and prefers a hand-off still in env (runner entered without main)', () => {
        stashReconnectEnv({ ...handoff() });
        const env: NodeJS.ProcessEnv = { HAPPY_RECONNECT_SESSION_ID: 's2', HAPPY_RECONNECT_ENCRYPTION_KEY: 'b3RoZXI=', HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'legacy' };
        expect(takeReconnectEnv(env)).toEqual({ HAPPY_RECONNECT_SESSION_ID: 's2', HAPPY_RECONNECT_ENCRYPTION_KEY: 'b3RoZXI=', HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'legacy' });
        expect(env).toEqual({});
    });

    it('not a reconnect: empty, nothing removed', () => {
        const env: NodeJS.ProcessEnv = { HAPPY_RECONNECTED: 'x' };
        stashReconnectEnv(env);
        expect(takeReconnectEnv(env)).toEqual({});
        expect(env).toEqual({ HAPPY_RECONNECTED: 'x' });
    });

    it('a child spawned after the stash inherits none of it', () => {
        Object.assign(process.env, handoff());
        stashReconnectEnv();
        const child = spawnSync(process.execPath, ['-e', 'console.log(Object.keys(process.env).filter((k) => k.startsWith("HAPPY_RECONNECT_")).length)'], { encoding: 'utf8' });
        expect(child.stdout.trim()).toBe('0');
        expect(takeReconnectEnv().HAPPY_RECONNECT_ENCRYPTION_KEY).toBe('a2V5');
    });
});
