import { describe, expect, it } from 'vitest'
import { isHostSessionEnvKey, stripHostSessionEnv } from './hostSessionEnv'

describe('B-657 host-session env isolation', () => {
    it('strips what a managed session exports and keeps machine configuration', () => {
        const env: NodeJS.ProcessEnv = {
            VH_TEAM_SCOPE_FILE: '/x/scope.json', VH_TEAM_OPERATION_ID: 'op', VH_PEER_SESSION_ID: 's', VH_TERMINAL_ID: 'term_1',
            HAPPY_MANAGED: '1', HAPPY_SPAWNED_BY: 'assistant', HAPPY_DAEMON_SUPERVISOR: 'systemd', HAPPY_MCP_URL: 'http://127.0.0.1:1/',
            HAPPY_RECONNECT_SESSION_ID: 'r', HAPPY_FORKED_FROM_SESSION_ID: 'f',
            HAPPY_HOME_DIR: '/tmp/iso', HAPPY_SERVER_URL: 'http://127.0.0.1:3005', HAPPY_WEBAPP_URL: 'http://127.0.0.1:8082',
            HAPPY_RUN_SANDBOX_NETWORK_TESTS: '1', PATH: '/usr/bin',
        }
        stripHostSessionEnv(env)
        expect(env).toEqual({
            HAPPY_HOME_DIR: '/tmp/iso', HAPPY_SERVER_URL: 'http://127.0.0.1:3005', HAPPY_WEBAPP_URL: 'http://127.0.0.1:8082',
            HAPPY_RUN_SANDBOX_NETWORK_TESTS: '1', PATH: '/usr/bin',
        })
    })

    it('the unit setup already ran: no host-session key is visible to a unit test', () => {
        expect(Object.keys(process.env).filter(isHostSessionEnvKey)).toEqual([])
    })
})
