import { BUILTIN_TODO_DISCOVERY } from '@/modules/todo/skill';
vi.mock('@/claude/utils/attachmentContent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/claude/utils/attachmentContent')>(),
  stageClaudeAttachments: async (files: any[]) => files.map((file) => ({ path: `/test/uploads/${file.name}`, name: file.name, mimeType: file.mimeType, size: file.data.length })),
}));
vi.mock('@/teams/piRuntime', () => ({ preparePiTeamsRuntime: async () => ({ PI_ACP_PI_COMMAND: 'official-pi-wrapper' }) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sessionHandlers = new Map<string, (params: any) => Promise<any> | any>();
  let userMessageHandler: ((message: any) => void) | null = null;
  let killHandler: (() => Promise<void>) | null = null;

  const mockSession = {
    sessionId: 'happy-session-1',
    onFileEvent: vi.fn(),
    downloadAndDecryptAttachment: vi.fn(async () => new Uint8Array([1, 2, 3])),
    trackAttachmentDownload: vi.fn(),
    getMetadata: vi.fn(() => ({})),
    drainAttachmentsForUserMessage: vi.fn(async (): Promise<any[]> => []),
    onUserMessage: vi.fn((handler: (message: any) => void) => {
      userMessageHandler = handler;
    }),
    keepAlive: vi.fn(),
    sendSessionProtocolMessage: vi.fn(),
    sendStreamFrame: vi.fn(),
    sendSessionEvent: vi.fn(),
    sendAgentUsageSnapshot: vi.fn(),
    updateMetadata: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    updateAgentState: vi.fn((handler: (state: Record<string, unknown>) => Record<string, unknown>) => {
      handler({});
    }),
    rpcHandlerManager: {
      registerHandler: vi.fn((name: string, handler: (params: any) => Promise<any> | any) => {
        sessionHandlers.set(name, handler);
      }),
    },
  };

  const backendState = {
    listeners: [] as Array<(message: any) => void>,
    prompts: [] as Array<{ sessionId: string; prompt: string; attachments?: any[] }>,
    setConfigOptionCalls: [] as Array<{ configId: string; value: string }>,
    setModeCalls: [] as string[],
    setModelCalls: [] as string[],
    startSessionMessages: [] as any[],
    modelSwitchMessages: [] as any[],
    startSessionCalls: 0,
    cancelCalls: [] as string[],
    disposeCalls: 0,
    constructorArgs: null as any,
    /** Per-test override of the backend's sendPrompt emission sequence (null = default script). */
    sendPromptScript: null as null | ((emit: (message: any) => void) => Promise<void>),
  };

  return {
    mockReadSettings: vi.fn(async () => ({ machineId: 'machine-1', sandboxConfig: undefined })),
    mockApiCreate: vi.fn(),
    mockGetOrCreateMachine: vi.fn(async () => ({})),
    mockGetOrCreateSession: vi.fn(async () => ({ id: 'session-1' })),
    mockSetupOfflineReconnection: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(async () => ({ error: null })),
    mockStartHappyServer: vi.fn(),
    mockProjectPath: vi.fn(() => '/tmp/happy'),
    mockSetBackend: vi.fn(),
    mockKillRegister: vi.fn((_rpc: unknown, handler: () => Promise<void>) => {
      killHandler = handler;
    }),
    mockLoggerDebug: vi.fn(),
    mockConsoleLog: vi.spyOn(console, 'log').mockImplementation(() => {}),
    sessionHandlers,
    getUserMessageHandler: () => userMessageHandler,
    setUserMessageHandler: (handler: ((message: any) => void) | null) => {
      userMessageHandler = handler;
    },
    /** Replace the default sendPrompt emission script (see `sendPromptScript`). */
    setSendPromptScript: (script: null | ((emit: (message: any) => void) => Promise<void>)) => {
      mocks.backendState.sendPromptScript = script;
    },
    getKillHandler: () => killHandler,
    setKillHandler: (handler: (() => Promise<void>) | null) => {
      killHandler = handler;
    },
    mockSession,
    backendState,
    titleGeneratorState: {
      sessions: [] as any[],
      seeds: [] as string[],
    },
    modeFileState: {
      writes: [] as Array<{ sessionId: string; mode: string }>,
      removes: [] as string[],
      failWrites: false,
    },
  };
});

// Keep the pure normalizer; record the file side effects instead of touching
// the real happy home (sessionModeFile.test.ts covers the on-disk shape).
vi.mock('./sessionModeFile', async () => {
  const actual = await vi.importActual<typeof import('./sessionModeFile')>('./sessionModeFile');
  return {
    ...actual,
    writeSessionModeFile: (sessionId: string, mode: string) => {
      if (mocks.modeFileState.failWrites) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      mocks.modeFileState.writes.push({ sessionId, mode });
      return { permissionMode: mode, updatedAt: 0 };
    },
    removeSessionModeFile: (sessionId: string) => {
      mocks.modeFileState.removes.push(sessionId);
    },
  };
});

vi.mock('@/persistence', async () => {
  const actual = await vi.importActual<typeof import('@/persistence')>('@/persistence');
  return {
    ...actual,
    readSettings: mocks.mockReadSettings,
  };
});

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mocks.mockApiCreate,
  },
}));

vi.mock('@/daemon/run', () => ({
  initialMachineMetadata: { host: 'host', platform: 'darwin', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happy', happyLibDir: '/tmp/happy' },
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
  setupOfflineReconnection: mocks.mockSetupOfflineReconnection,
}));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonSessionStarted: mocks.mockNotifyDaemonSessionStarted,
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
  registerKillSessionHandler: mocks.mockKillRegister,
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
  startHappyServer: mocks.mockStartHappyServer,
}));

// The real generator spawns `claude -p`; record the seed text it is handed.
vi.mock('@/claude/utils/titleGenerator', () => ({
  TitleGenerator: class MockTitleGenerator {
    constructor(session: any) {
      mocks.titleGeneratorState.sessions.push(session);
    }
    maybeGenerate(text: string) {
      mocks.titleGeneratorState.seeds.push(text);
    }
  },
}));

vi.mock('@/projectPath', () => ({
  projectPath: mocks.mockProjectPath,
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
  connectionState: {
    setBackend: mocks.mockSetBackend,
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}));

vi.mock('./AcpBackend', () => ({
  AcpBackend: class MockAcpBackend {
    constructor(args: any) {
      mocks.backendState.constructorArgs = args;
    }

    onMessage(handler: (message: any) => void) {
      mocks.backendState.listeners.push(handler);
    }

    offMessage(handler: (message: any) => void) {
      mocks.backendState.listeners = mocks.backendState.listeners.filter((item) => item !== handler);
    }

    async startSession() {
      mocks.backendState.startSessionCalls += 1;
      for (const message of mocks.backendState.startSessionMessages) {
        for (const listener of mocks.backendState.listeners) {
          listener(message);
        }
      }
      return { sessionId: 'acp-session-1' };
    }

    async sendPrompt(sessionId: string, prompt: string, attachments?: any[]) {
      mocks.backendState.prompts.push({ sessionId, prompt, ...(attachments?.length ? { attachments } : {}) });
      const emit = (message: any) => {
        for (const listener of mocks.backendState.listeners) {
          listener(message);
        }
      };
      if (mocks.backendState.sendPromptScript) {
        await mocks.backendState.sendPromptScript(emit);
        return;
      }
      emit({ type: 'status', status: 'running' });
      emit({ type: 'model-output', textDelta: 'hello' });
      emit({ type: 'tool-call', toolName: 'ReadFile', args: { path: 'README.md' }, callId: 'tool-1' });
      emit({ type: 'tool-result', toolName: 'ReadFile', result: { ok: true }, callId: 'tool-1' });
      emit({ type: 'status', status: 'idle' });
    }

    async setSessionConfigOption(configId: string, value: string) {
      mocks.backendState.setConfigOptionCalls.push({ configId, value });
      if (configId === 'model') for (const message of mocks.backendState.modelSwitchMessages) {
        for (const listener of mocks.backendState.listeners) listener(message);
      }
      return true;
    }

    async setSessionMode(modeId: string) {
      mocks.backendState.setModeCalls.push(modeId);
      return true;
    }

    async setSessionModel(modelId: string) {
      mocks.backendState.setModelCalls.push(modelId);
      for (const message of mocks.backendState.modelSwitchMessages) {
        for (const listener of mocks.backendState.listeners) listener(message);
      }
      return true;
    }

    async cancel(sessionId: string) {
      mocks.backendState.cancelCalls.push(sessionId);
      for (const listener of mocks.backendState.listeners) {
        listener({ type: 'status', status: 'idle', detail: 'Cancelled by user' });
      }
    }

    async dispose() {
      mocks.backendState.disposeCalls += 1;
    }
  },
}));

import { runAcp } from './runAcp';

describe('runAcp', () => {
  const stripAnsi = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '');
  const stripLogPrefix = (line: string) => stripAnsi(line).replace(/^\[\d{2}:\d{2}\] /, '');
  const consoleLines = () => mocks.mockConsoleLog.mock.calls
    .map((args) => args.map((arg) => String(arg)).join(' '))
    .map(stripLogPrefix);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionHandlers.clear();
    mocks.setUserMessageHandler(null);
    mocks.setKillHandler(null);
    mocks.backendState.listeners = [];
    mocks.backendState.prompts = [];
    mocks.backendState.setConfigOptionCalls = [];
    mocks.backendState.setModeCalls = [];
    mocks.backendState.setModelCalls = [];
    mocks.backendState.startSessionMessages = [];
    mocks.backendState.modelSwitchMessages = [];
    mocks.backendState.startSessionCalls = 0;
    mocks.backendState.cancelCalls = [];
    mocks.titleGeneratorState.sessions = [];
    mocks.titleGeneratorState.seeds = [];
    mocks.modeFileState.writes = [];
    mocks.modeFileState.removes = [];
    mocks.modeFileState.failWrites = false;
    mocks.backendState.disposeCalls = 0;
    mocks.backendState.constructorArgs = null;
    mocks.backendState.sendPromptScript = null;

    mocks.mockApiCreate.mockResolvedValue({
      getOrCreateMachine: mocks.mockGetOrCreateMachine,
      getOrCreateSession: mocks.mockGetOrCreateSession,
    });
    mocks.mockSetupOfflineReconnection.mockImplementation(() => ({
      session: mocks.mockSession,
      reconnectionHandle: { cancel: vi.fn() },
      isOffline: false,
    }));
    mocks.mockStartHappyServer.mockResolvedValue({
      url: 'http://127.0.0.1:9876',
      stop: vi.fn(),
    });
  });

  it('exports the happy MCP url and session id into the ACP child env (pi-acp ignores mcpServers)', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi',
      command: 'pi-acp',
      args: [],
    });

    await vi.waitFor(() => {
      expect(mocks.getKillHandler()).toBeTypeOf('function');
    });
    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.env).toEqual({
      PI_ACP_PI_COMMAND: 'official-pi-wrapper',
      HAPPY_MCP_URL: 'http://127.0.0.1:9876',
      HAPPY_SESSION_ID: 'happy-session-1',
      HAPPY_PERMISSION_MODE: 'default',
    });
    // The ACP handoff stays for agents that honour it.
    expect(mocks.backendState.constructorArgs.mcpServers.happy.args).toEqual(['--url', 'http://127.0.0.1:9876']);
  });

  describe('file-backed permission mode (agents without an ACP mode selector, i.e. pi)', () => {
    const publishedModes = () => mocks.mockSession.updateMetadata.mock.calls
      .map((call) => (call[0] as (meta: Record<string, unknown>) => Record<string, unknown>)({}).permissionMode)
      .filter((mode) => mode !== undefined);

    it('exports the initial mode to the child env, writes the mode file and publishes metadata on start, removes it on exit', async () => {
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'pi',
        command: 'pi-acp',
        args: [],
        permissionMode: 'bypassPermissions',
      });
      await vi.waitFor(() => {
        expect(mocks.modeFileState.writes).toHaveLength(1);
      });
      expect(mocks.backendState.constructorArgs.env.HAPPY_PERMISSION_MODE).toBe('bypassPermissions');
      expect(mocks.modeFileState.writes).toEqual([{ sessionId: 'happy-session-1', mode: 'bypassPermissions' }]);
      expect(publishedModes()).toEqual(['bypassPermissions']);
      expect(mocks.modeFileState.removes).toEqual([]);

      await mocks.getKillHandler()!();
      await runPromise;
      expect(mocks.modeFileState.removes).toEqual(['happy-session-1']);
    });

    it('rewrites the file and metadata on a live switch from message meta (yolo alias), ignores unknown values and no-op repeats', async () => {
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'pi',
        command: 'pi-acp',
        args: [],
      });
      await vi.waitFor(() => {
        expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
        expect(mocks.modeFileState.writes).toHaveLength(1);
      });
      expect(mocks.modeFileState.writes[0]).toEqual({ sessionId: 'happy-session-1', mode: 'default' });

      const send = (text: string, permissionMode: string) => {
        mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text }, meta: { permissionMode } });
      };
      send('go yolo', 'yolo');
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      send('still yolo', 'bypassPermissions');
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(2));
      send('nonsense', 'safe-yolo');
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(3));
      send('back', 'default');
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(4));

      await mocks.getKillHandler()!();
      await runPromise;

      expect(mocks.modeFileState.writes.map((w) => w.mode)).toEqual(['default', 'bypassPermissions', 'default']);
      expect(publishedModes()).toEqual(['default', 'bypassPermissions', 'default']);
      // Never went through an ACP selector: pi-acp has none.
      expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
      expect(mocks.backendState.setModeCalls).toEqual([]);
      expect(mocks.modeFileState.removes).toEqual(['happy-session-1']);
    });

    it('honours the set-permission-mode RPC the web picker uses while working (yolo alias, invalid rejected)', async () => {
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'pi',
        command: 'pi-acp',
        args: [],
      });
      await vi.waitFor(() => expect(mocks.modeFileState.writes).toHaveLength(1));
      const setPermissionMode = mocks.sessionHandlers.get('set-permission-mode')!;
      expect(setPermissionMode).toBeTypeOf('function');

      await expect(setPermissionMode({ mode: 'yolo' })).resolves.toEqual({ mode: 'bypassPermissions' });
      await expect(setPermissionMode({ mode: 'safe-yolo' })).rejects.toThrow('Invalid permission mode');
      await expect(setPermissionMode({})).rejects.toThrow('Invalid permission mode');
      await expect(setPermissionMode({ mode: 'bypassPermissions' })).resolves.toEqual({ mode: 'bypassPermissions' });

      await mocks.getKillHandler()!();
      await runPromise;

      expect(mocks.modeFileState.writes.map((w) => w.mode)).toEqual(['default', 'bypassPermissions']);
      expect(publishedModes()).toEqual(['default', 'bypassPermissions']);
      expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
      expect(mocks.modeFileState.removes).toEqual(['happy-session-1']);
    });

    it('does not publish a mode it could not write (rule 14: intent is not fact) and skips removal on exit', async () => {
      mocks.modeFileState.failWrites = true;
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'pi',
        command: 'pi-acp',
        args: [],
        permissionMode: 'bypassPermissions',
      });
      await vi.waitFor(() => expect(mocks.sessionHandlers.get('set-permission-mode')).toBeTypeOf('function'));
      await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));

      // Live switch while the file is unwritable: rejected, nothing published.
      await expect(mocks.sessionHandlers.get('set-permission-mode')!({ mode: 'default' }))
        .rejects.toThrow('Failed to write session mode file');

      await mocks.getKillHandler()!();
      await runPromise;

      expect(mocks.modeFileState.writes).toEqual([]);
      expect(publishedModes()).toEqual([]);
      expect(mocks.modeFileState.removes).toEqual([]);
      expect(mocks.backendState.constructorArgs.env.HAPPY_PERMISSION_MODE).toBe('bypassPermissions');
    });

    it('pi stays file-backed even though pi-acp advertises legacy modes (they are thinking levels, B-351)', async () => {
      mocks.backendState.startSessionMessages = [
        {
          type: 'event',
          name: 'modes_update',
          payload: {
            currentModeId: 'medium',
            availableModes: [{ id: 'off', name: 'Thinking: off' }, { id: 'medium', name: 'Thinking: medium' }],
          },
        },
        {
          type: 'event',
          name: 'config_options_update',
          payload: {
            configOptions: [
              { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
              { type: 'select', id: 'thought_level', name: 'Thinking', category: 'thought_level', currentValue: 'medium', options: [{ value: 'medium', name: 'medium' }] },
            ],
          },
        },
      ];
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'pi',
        command: 'pi-acp',
        args: [],
      });
      await vi.waitFor(() => expect(mocks.modeFileState.writes).toHaveLength(1));
      mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'x' }, meta: { permissionMode: 'yolo' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      await mocks.getKillHandler()!();
      await runPromise;

      expect(mocks.modeFileState.writes.map((w) => w.mode)).toEqual(['default', 'bypassPermissions']);
      expect(mocks.backendState.setModeCalls).toEqual([]);
      expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
      expect(publishedModes()).toEqual(['default', 'bypassPermissions']);
    });

    it('stays out of the way when the agent advertises an ACP mode selector (gemini/opencode path unchanged)', async () => {
      mocks.backendState.startSessionMessages = [
        {
          type: 'event',
          name: 'config_options_update',
          payload: {
            configOptions: [
              {
                type: 'select', id: 'permission-mode', name: 'Permission Mode', category: 'mode', currentValue: 'ask',
                options: [{ value: 'ask', name: 'Ask' }, { value: 'code', name: 'Code' }],
              },
            ],
          },
        },
      ];
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'opencode',
        command: 'opencode',
        args: ['acp'],
      });
      await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
      mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'x' }, meta: { permissionMode: 'Code' } });
      await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
      await mocks.getKillHandler()!();
      await runPromise;

      expect(mocks.backendState.setConfigOptionCalls).toEqual([{ configId: 'permission-mode', value: 'code' }]);
      expect(mocks.modeFileState.writes).toEqual([]);
      expect(mocks.modeFileState.removes).toEqual([]);
      expect(publishedModes()).toEqual([]);
    });
  });

  describe('startHappyServer assistant flag (HAPPY_SESSION_VARIANT, env-only meta-agent spawn)', () => {
    const runUntilKilled = async () => {
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'pi',
        command: 'pi-acp',
        args: [],
      });
      await vi.waitFor(() => {
        expect(mocks.getKillHandler()).toBeTypeOf('function');
      });
      await mocks.getKillHandler()!();
      await runPromise;
    };

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('passes assistant=true when HAPPY_SESSION_VARIANT=assistant so sessions_* reach pi over HAPPY_MCP_URL', async () => {
      vi.stubEnv('HAPPY_SESSION_VARIANT', 'assistant');
      await runUntilKilled();
      expect(mocks.mockStartHappyServer).toHaveBeenCalledTimes(1);
      expect(mocks.mockStartHappyServer.mock.calls[0][1]).toEqual({ assistant: true, onContextUsage: expect.any(Function) });
    });

    it('passes assistant=false when HAPPY_SESSION_VARIANT is unset', async () => {
      vi.stubEnv('HAPPY_SESSION_VARIANT', '');
      delete process.env.HAPPY_SESSION_VARIANT;
      await runUntilKilled();
      expect(mocks.mockStartHappyServer).toHaveBeenCalledTimes(1);
      expect(mocks.mockStartHappyServer.mock.calls[0][1]).toEqual({ assistant: false, onContextUsage: expect.any(Function) });
    });
  });

  it('delivers a file event followed by attachment-only text to the ACP prompt', async () => {
    const running = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi', command: 'pi-acp', args: [],
    });
    await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
    const fileHandler = mocks.mockSession.onFileEvent.mock.calls[0][0] as (event: any) => void;
    fileHandler({ content: { data: { ev: { ref: 'image-ref', name: 'sample.png', mimeType: 'image/png' } } } });
    const tracked = mocks.mockSession.trackAttachmentDownload.mock.calls[0][0] as Promise<any>;
    mocks.mockSession.drainAttachmentsForUserMessage.mockImplementationOnce(async () => [await tracked]);
    mocks.getUserMessageHandler()!({ content: { text: '' }, localKey: 'attachment-only' });
    await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
    expect(mocks.mockSession.downloadAndDecryptAttachment).toHaveBeenCalledWith('image-ref');
    expect(mocks.backendState.prompts[0].attachments).toEqual([{ data: new Uint8Array([1, 2, 3]), name: 'sample.png', mimeType: 'image/png' }]);
    expect(mocks.backendState.prompts[0].prompt).toContain('/test/uploads/sample.png');
    await mocks.getKillHandler()!();
    await running;
  });

  it('preserves arrival order while the first message waits for attachment downloads', async () => {
    let finishDownload!: (value: []) => void;
    mocks.mockSession.drainAttachmentsForUserMessage.mockReturnValueOnce(new Promise<[]>((resolve) => { finishDownload = resolve; }));
    const running = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi', command: 'pi-acp', args: [],
    });
    await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
    mocks.getUserMessageHandler()!({ content: { text: 'first-download' } });
    mocks.getUserMessageHandler()!({ content: { text: 'second-text' } });
    await Promise.resolve();
    expect(mocks.backendState.prompts).toEqual([]);
    finishDownload([]);
    await vi.waitFor(() => expect(mocks.backendState.prompts.map((entry) => entry.prompt).join('\n')).toContain('second-text'));
    const delivered = mocks.backendState.prompts.map((entry) => entry.prompt).join('\n');
    expect(delivered.indexOf('first-download')).toBeLessThan(delivered.indexOf('second-text'));
    await mocks.getKillHandler()!();
    await running;
  });

  it('seeds the auto-title from the first user prompt only, never from assistant output such as the pi banner', async () => {
    mocks.backendState.startSessionMessages = [
      { type: 'model-output', textDelta: 'pi v0.84.4 — type /help' },
    ];
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi',
      command: 'pi-acp',
      args: [],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    expect(mocks.titleGeneratorState.sessions).toEqual([mocks.mockSession]);
    expect(mocks.titleGeneratorState.seeds).toEqual([]);

    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: '' } });
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'Summarise the repo' } });
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'second prompt' } });

    // MessageQueue2 may batch the two prompts into one turn; only the seeds matter here.
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts.length).toBeGreaterThanOrEqual(1);
    });
    await mocks.getKillHandler()!();
    await runPromise;

    // Empty prompts are dropped before the generator; the generator itself
    // gates to the first call (titleGenerator.test.ts), so runAcp forwards each
    // non-empty prompt exactly like runClaude.
    expect(mocks.titleGeneratorState.seeds).toEqual(['Summarise the repo', 'second prompt']);
  });

  it('injects Todo skill discovery only into the first backend prompt, preserving title and logs', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi', command: 'pi-acp', args: [],
    });
    await vi.waitFor(() => expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'List my todos' } });
    await vi.waitFor(() => expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' }));
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'Continue' } });
    await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(2));
    await mocks.getKillHandler()!();
    await runPromise;
    expect(mocks.backendState.prompts.map(entry => entry.prompt)).toEqual([
      `List my todos\n\n${BUILTIN_TODO_DISCOVERY}`, 'Continue',
    ]);
    expect(mocks.titleGeneratorState.seeds).toEqual(['List my todos', 'Continue']);
    expect(consoleLines()).toContain('Incoming prompt: List my todos');
    expect(consoleLines().some(line => line.includes(BUILTIN_TODO_DISCOVERY))).toBe(false);
  });

  it('wires backend messages through mapper into session envelopes', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Build a test plan' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.constructorArgs.command).toBe('opencode');
    expect(mocks.backendState.constructorArgs.args).toEqual(['--acp']);
    expect(mocks.backendState.prompts[0]).toEqual({
      sessionId: 'acp-session-1',
      prompt: `Build a test plan\n\n${BUILTIN_TODO_DISCOVERY}`,
    });

    const envelopeTypes = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope.ev.t);
    expect(envelopeTypes).toEqual(['turn-start', 'text', 'tool-call-start', 'tool-call-end', 'turn-end']);
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    expect(mocks.mockSession.close).toHaveBeenCalled();
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Happy Session ID: session-1',
      'Incoming prompt: Build a test plan',
      'Status: running',
      'Outgoing message: "hello"',
      'Tool: ReadFile started (callId=tool-1)',
      'Tool: ReadFile completed (callId=tool-1)',
      'Status: idle',
    ]));
  });

  it('relays streamed text as live-draft frames whose key the persisted envelope carries (B-371)', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi',
      command: 'pi-acp',
      args: [],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'hi' } });
    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });
    await mocks.getKillHandler()!();
    await runPromise;

    const envelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope);
    const turnStart = envelopes.find((e) => e.ev.t === 'turn-start')!;
    const text = envelopes.find((e) => e.ev.t === 'text')!;
    const frames = mocks.mockSession.sendStreamFrame.mock.calls.map(([frame]) => frame);

    // The web sees the draft before the tool card, then swaps it for the real
    // text via the shared key — the key is `<turn id>:<block index>`.
    const expectedKey = `${turnStart.turn}:0`;
    expect(text.streamKey).toBe(expectedKey);
    expect(frames).toEqual([
      { t: 'block-start', mid: turnStart.turn, idx: 0, kind: 'text' },
      { t: 'block-delta', mid: turnStart.turn, idx: 0, text: 'hello' },
      { t: 'block-end', mid: turnStart.turn, idx: 0 },
      { t: 'turn-end' },
    ]);
    // turn-end (the web's sweep countdown) goes out AFTER the turn's envelopes.
    const turnEndEnvelopeCall = mocks.mockSession.sendSessionProtocolMessage.mock.invocationCallOrder.at(-1)!;
    const turnEndFrameCall = mocks.mockSession.sendStreamFrame.mock.invocationCallOrder.at(-1)!;
    expect(turnEndFrameCall).toBeGreaterThan(turnEndEnvelopeCall);
  });

  it('honours HAPPY_SESSION_STREAM_DISABLED=1: no frames, no streamKey, envelopes unchanged', async () => {
    vi.stubEnv('HAPPY_SESSION_STREAM_DISABLED', '1');
    try {
      const runPromise = runAcp({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        agentName: 'pi',
        command: 'pi-acp',
        args: [],
      });
      await vi.waitFor(() => {
        expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
      });
      mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'hi' } });
      await vi.waitFor(() => {
        expect(mocks.backendState.prompts).toHaveLength(1);
      });
      await mocks.getKillHandler()!();
      await runPromise;
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mocks.mockSession.sendStreamFrame).not.toHaveBeenCalled();
    const envelopeTypes = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope.ev.t);
    expect(envelopeTypes).toEqual(['turn-start', 'text', 'tool-call-start', 'tool-call-end', 'turn-end']);
    const text = mocks.mockSession.sendSessionProtocolMessage.mock.calls.map(([e]) => e).find((e) => e.ev.t === 'text')!;
    expect(text.streamKey).toBeUndefined();
  });

  it('stores ACP token-count messages as the selected agent snapshot', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => expect(mocks.backendState.listeners).toHaveLength(1));
    const usage = { type: 'token-count', totalTokens: 30, inputTokens: 20, outputTokens: 10 };
    mocks.backendState.listeners[0](usage);

    expect(mocks.mockSession.sendAgentUsageSnapshot).toHaveBeenCalledWith('opencode', usage);
    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('holds the keepAlive thinking lease for the whole turn even though the backend flips idle/running mid-turn (B-376)', async () => {
    // Ordered log of what the web would see, in emission order: keepAlive
    // lease values and session-protocol envelope types.
    const wire: string[] = [];
    mocks.mockSession.keepAlive.mockImplementation((thinking: boolean) => {
      wire.push(`keepAlive:${thinking}`);
    });
    mocks.mockSession.sendSessionProtocolMessage.mockImplementation((envelope: any) => {
      wire.push(`ev:${envelope.ev.t}`);
    });
    // Replays the status sequence AcpBackend produced for one real pi turn
    // (2026-09-07 probe, ~/code/github/skills/tmp/vh-t015/timeline.json):
    // text → [500ms gap] idle → tool_call running → tool done idle →
    // [4.1s model output] → prompt resolves. Awaits between steps make each
    // status observable by the runner before the next one lands.
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
    mocks.backendState.sendPromptScript = async (emit) => {
      emit({ type: 'status', status: 'running' });
      emit({ type: 'model-output', textDelta: "I'll run it." });
      await tick();
      emit({ type: 'status', status: 'idle' });
      await tick();
      emit({ type: 'status', status: 'running' });
      emit({ type: 'tool-call', toolName: 'execute', args: { command: 'sleep 8' }, callId: 'tool-1' });
      await tick();
      emit({ type: 'tool-result', toolName: 'execute', result: { ok: true }, callId: 'tool-1' });
      emit({ type: 'status', status: 'idle' });
      await tick();
      emit({ type: 'model-output', textDelta: 'Done.' });
      await tick();
    };

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi',
      command: 'pi-acp',
      args: [],
    });
    try {
      await vi.waitFor(() => {
        expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
      });
      mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'run sleep' } });
      await vi.waitFor(() => {
        expect(wire).toContain('ev:turn-end');
      });

      const turnStart = wire.indexOf('ev:turn-start');
      const turnEnd = wire.indexOf('ev:turn-end');
      const inTurn = wire.slice(turnStart, turnEnd + 1);
      // The lease goes up right at turn start …
      expect(inTurn[1]).toBe('keepAlive:true');
      // … and is never released inside the turn: two backend `idle`s were
      // observed in there and neither may reach the web as `thinking:false`.
      const leaseInTurn = inTurn.filter((entry) => entry.startsWith('keepAlive:'));
      expect(leaseInTurn.length).toBeGreaterThan(0);
      expect(leaseInTurn.every((entry) => entry === 'keepAlive:true')).toBe(true);
      expect(inTurn).toEqual(expect.arrayContaining(['ev:text', 'ev:tool-call-start', 'ev:tool-call-end']));
      // Released exactly once, after the turn's final envelopes are on the wire.
      const after = wire.slice(turnEnd + 1);
      expect(after[0]).toBe('keepAlive:false');
    } finally {
      mocks.mockSession.keepAlive.mockReset();
      mocks.mockSession.sendSessionProtocolMessage.mockReset();
      await mocks.getKillHandler()!();
      await runPromise;
    }
  });

it('keeps the session usable after cancelling an in-flight turn', async () => {
  let release!: () => void;
  mocks.backendState.sendPromptScript = async emit => {
    emit({type:'status',status:'running'});
    await new Promise<void>(resolve => { release = resolve; });
  };
  const runPromise = runAcp({credentials:{token:'token',encryption:{type:'legacy',secret:new Uint8Array(32)}},agentName:'pi',command:'pi-acp',args:[]});
  try {
    await vi.waitFor(()=>expect(mocks.getUserMessageHandler()).toBeTypeOf('function'));
    mocks.getUserMessageHandler()!({role:'user',content:{type:'text',text:'first'}});
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    await mocks.sessionHandlers.get('abort')!({});
    release();
    await vi.waitFor(()=>expect(mocks.mockSession.sendSessionProtocolMessage.mock.calls.some(([m])=>m.ev.t==='turn-end'&&m.ev.status==='cancelled')).toBe(true));
    expect(mocks.backendState.disposeCalls).toBe(0);
    mocks.backendState.sendPromptScript = null;
    mocks.getUserMessageHandler()!({role:'user',content:{type:'text',text:'second'}});
    await vi.waitFor(()=>expect(mocks.backendState.prompts).toHaveLength(2));
    await vi.waitFor(()=>expect(mocks.mockSession.keepAlive).toHaveBeenLastCalledWith(false,'remote'));
  } finally { release?.(); await mocks.getKillHandler()!(); await runPromise; }
});

  it('registers abort handler that cancels the ACP backend session', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    const abortHandler = mocks.sessionHandlers.get('abort');
    expect(abortHandler).toBeTypeOf('function');

    await abortHandler!({});
    await vi.waitFor(() => {
      expect(mocks.backendState.cancelCalls).toEqual(['acp-session-1']);
    });

    await mocks.getKillHandler()!();
    await runPromise;
  });

  it('emits thinking messages in default mode', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['--acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    const listener = mocks.backendState.listeners[0];
    const prompts = mocks.backendState.prompts;
    if (!listener) {
      throw new Error('Expected backend listener to be registered');
    }

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Think first' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    listener({ type: 'event', name: 'thinking', payload: { text: 'Analyzing request' } });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(prompts).toHaveLength(1);
    expect(consoleLines()).toEqual(expect.arrayContaining([
      'Thinking: "Analyzing request"',
    ]));
  });

  it('emits raw backend and envelope logs when verbose is enabled', async () => {
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run the command' },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const lines = consoleLines();
    expect(lines.some((line) => line.startsWith('Outgoing raw backend message from opencode: '))).toBe(true);
    expect(lines.some((line) => line.startsWith('Incoming raw envelope for opencode: '))).toBe(true);
    expect(lines).toEqual(expect.arrayContaining([
      'Outgoing message: "hello"',
      'Tool: ReadFile started (callId=tool-1)',
    ]));
  });

  it('logs slash commands, modes, and models line by line when verbose is enabled', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'available_commands',
        payload: [
          { name: 'init', description: 'create/update AGENTS.md' },
          { name: 'review', description: 'review uncommitted changes' },
        ],
      },
      {
        type: 'event',
        name: 'modes_update',
        payload: {
          availableModes: [
            { id: 'build', name: 'build', description: 'Executes tools' },
            { id: 'plan', name: 'plan', description: 'Disallows edit tools' },
          ],
          currentModeId: 'build',
        },
      },
      {
        type: 'event',
        name: 'models_update',
        payload: {
          currentModelId: 'gemini-2.5-pro',
          availableModels: [
            { modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { modelId: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'gemini',
      command: 'gemini',
      args: ['--experimental-acp'],
      verbose: true,
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const lines = consoleLines();
    expect(lines).toEqual(expect.arrayContaining([
      'Outgoing slash commands from gemini (2):',
      '  /init - create/update AGENTS.md',
      '  /review - review uncommitted changes',
      'Outgoing modes from gemini (2), current=build:',
      '  mode=build name=build - Executes tools',
      '  mode=plan name=plan - Disallows edit tools',
      'Outgoing models from gemini (2), current=gemini-2.5-pro:',
      '  model=gemini-2.5-pro name=Gemini 2.5 Pro',
      '  model=gemini-2.5-flash name=Gemini 2.5 Flash',
    ]));
  });

  it('exits when backend reports terminal startup status', async () => {
    mocks.backendState.startSessionMessages = [
      { type: 'status', status: 'error', detail: 'spawn opencode ENOENT' },
    ];

    await runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    expect(consoleLines()).toContain('Status: error: spawn opencode ENOENT');
    expect(mocks.mockSession.close).toHaveBeenCalled();
    expect(mocks.backendState.disposeCalls).toBe(1);
  });

  it('updates session metadata with ACP config options (models and operating modes)', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              currentValue: 'code',
              options: [
                { value: 'ask', name: 'Ask', description: 'Q&A mode' },
                { value: 'code', name: 'Code', description: 'Implementation mode' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet', description: 'Balanced model' },
                { value: 'claude-opus', name: 'Claude Opus', description: 'Deep reasoning model' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.startSessionCalls).toBe(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    const metadataHandlers = mocks.mockSession.updateMetadata.mock.calls.map((call) => call[0]);
    const baseMetadata = {
      path: '/repo',
      host: 'host',
      homeDir: '/home/user',
      happyHomeDir: '/home/user/.happy',
      happyLibDir: '/repo/.happy/lib',
      happyToolsDir: '/repo/.happy/tools',
    };
    const appliedMetadata = metadataHandlers.map((handler) => handler(baseMetadata));

    expect(appliedMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentModelCode: 'claude-sonnet',
          currentOperatingModeCode: 'code',
          models: [
            { code: 'claude-sonnet', value: 'Claude Sonnet', description: 'Balanced model' },
            { code: 'claude-opus', value: 'Claude Opus', description: 'Deep reasoning model' },
          ],
          operatingModes: [
            { code: 'ask', value: 'Ask', description: 'Q&A mode' },
            { code: 'code', value: 'Code', description: 'Implementation mode' },
          ],
        }),
      ]),
    );
  });

  it('reports an unavailable saved model instead of silently reverting to the backend default', async () => {
    mocks.backendState.startSessionMessages = [{ type: 'event', name: 'config_options_update', payload: {
      configOptions: [{ type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: 'zai/glm-5.3', options: [
        { value: 'zai/glm-5.3', name: 'GLM' },
      ] }],
    } }];
    const running = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi', command: 'pi-acp', args: [], model: 'llm-hub/claude-fable-5-1',
    });
    await vi.waitFor(() => expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message', message: 'The saved model is unavailable for this agent; using its current model.',
    }));
    expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
    await mocks.getKillHandler()!();
    await running;
  });

  it('applies the saved initial model after the agent advertises models and before any prompt', async () => {
    mocks.backendState.startSessionMessages = [{ type: 'event', name: 'config_options_update', payload: {
      configOptions: [{ type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: 'zai/glm-5.3', options: [
        { value: 'zai/glm-5.3', name: 'GLM' }, { value: 'llm-hub/claude-fable-5-1', name: 'Fable 5.1' },
      ] }],
    } }];
    const running = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi', command: 'pi-acp', args: [], model: 'llm-hub/claude-fable-5-1',
    });
    await vi.waitFor(() => expect(mocks.backendState.setConfigOptionCalls).toContainEqual({ configId: 'model', value: 'llm-hub/claude-fable-5-1' }));
    expect(mocks.backendState.prompts).toEqual([]);
    await mocks.getKillHandler()!();
    await running;
  });

  it('keeps the prompt and runner alive when switching to a model with fewer thinking levels', async () => {
    const config = (model: string, levels: string[]) => ({
      type: 'event', name: 'config_options_update', payload: { configOptions: [
        { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: model,
          options: ['deep', 'small'].map(value => ({ value, name: value })) },
        { type: 'select', id: 'thinking', name: 'Thinking', category: 'thought_level', currentValue: 'medium',
          options: levels.map(value => ({ value, name: value })) },
      ] },
    });
    mocks.backendState.startSessionMessages = [config('deep', ['medium', 'xhigh'])];
    mocks.backendState.modelSwitchMessages = [config('small', ['medium'])];
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi', command: 'pi-acp', args: [],
    });
    await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'Switch model and answer' },
      meta: { model: 'small', effort: 'xhigh' } });
    await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
    expect(mocks.backendState.setConfigOptionCalls).toEqual([{ configId: 'model', value: 'small' }]);
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'Continue' }, meta: {} });
    await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(2));
    expect(mocks.backendState.disposeCalls).toBe(0);
    await mocks.getKillHandler()!();
    await runPromise;
  });

  it.each([true, false])('routes pi effort independently from yolo (config=%s)', async (useConfig) => {
    mocks.backendState.startSessionMessages = [useConfig ? {
      type: 'event', name: 'config_options_update', payload: { configOptions: [{
        type: 'select', id: 'thinking', name: 'Thinking', category: 'thought_level',
        currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'xhigh', name: 'Extra high' }],
      }] },
    } : {
      type: 'event', name: 'modes_update', payload: { currentModeId: 'medium', availableModes: [
        { id: 'medium', name: 'Thinking: medium' }, { id: 'xhigh', name: 'Thinking: xhigh' },
      ] },
    }];
    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'pi', command: 'pi-acp', args: [],
    });
    await vi.waitFor(() => expect(mocks.backendState.startSessionCalls).toBe(1));
    mocks.getUserMessageHandler()!({ role: 'user', content: { type: 'text', text: 'Reason deeply' },
      meta: { permissionMode: 'bypassPermissions', effort: 'xhigh' } });
    await vi.waitFor(() => expect(mocks.backendState.prompts).toHaveLength(1));
    await mocks.getKillHandler()!();
    await runPromise;
    expect(mocks.modeFileState.writes).toContainEqual({ sessionId: 'happy-session-1', mode: 'bypassPermissions' });
    expect(mocks.backendState.setConfigOptionCalls).toEqual(useConfig ? [{ configId: 'thinking', value: 'xhigh' }] : []);
    expect(mocks.backendState.setModeCalls).toEqual(useConfig ? [] : ['xhigh']);
  });

  it('switches ACP model and permission mode when requested values match config options', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'permission-mode',
              name: 'Permission Mode',
              category: 'mode',
              currentValue: 'ask',
              options: [
                { value: 'ask', name: 'Ask' },
                { value: 'code', name: 'Code' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet' },
                { value: 'claude-opus', name: 'Claude Opus' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Apply settings then run' },
      meta: {
        permissionMode: 'Code',
        model: 'claude-opus',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([
      { configId: 'permission-mode', value: 'code' },
      { configId: 'model', value: 'claude-opus' },
    ]);
    expect(mocks.backendState.setModeCalls).toEqual([]);
    expect(mocks.backendState.setModelCalls).toEqual([]);
  });

  it('ignores ACP model and permission mode requests when values do not match advertised options', async () => {
    mocks.backendState.startSessionMessages = [
      {
        type: 'event',
        name: 'config_options_update',
        payload: {
          configOptions: [
            {
              type: 'select',
              id: 'permission-mode',
              name: 'Permission Mode',
              category: 'mode',
              currentValue: 'ask',
              options: [
                { value: 'ask', name: 'Ask' },
                { value: 'code', name: 'Code' },
              ],
            },
            {
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'claude-sonnet',
              options: [
                { value: 'claude-sonnet', name: 'Claude Sonnet' },
                { value: 'claude-opus', name: 'Claude Opus' },
              ],
            },
          ],
        },
      },
    ];

    const runPromise = runAcp({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      agentName: 'opencode',
      command: 'opencode',
      args: ['acp'],
    });

    await vi.waitFor(() => {
      expect(mocks.getUserMessageHandler()).toBeTypeOf('function');
    });

    mocks.getUserMessageHandler()!({
      role: 'user',
      content: { type: 'text', text: 'Run without switching' },
      meta: {
        permissionMode: 'invalid-mode',
        model: 'invalid-model',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.backendState.prompts).toHaveLength(1);
    });

    await mocks.getKillHandler()!();
    await runPromise;

    expect(mocks.backendState.setConfigOptionCalls).toEqual([]);
    expect(mocks.backendState.setModeCalls).toEqual([]);
    expect(mocks.backendState.setModelCalls).toEqual([]);
  });
});

describe('extractConfigSelector (B-351)', () => {
  it('does not mistake a categorised model option for the mode selector (pi-acp shape)', async () => {
    const { extractConfigSelector } = await import('./runAcp');
    const options = [
      { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
      { id: 'thought_level', category: 'thought_level', name: 'Thinking', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'low' }] },
    ] as any;
    expect(extractConfigSelector(options, 'mode')).toBeNull();
    expect(extractConfigSelector(options, 'model')?.configId).toBe('model');
  });

  it('still finds an uncategorised mode option by name, and never by "model"', async () => {
    const { extractConfigSelector } = await import('./runAcp');
    const options = [
      { id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
      { id: 'approval', name: 'Permission mode', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'ask' }] },
    ] as any;
    expect(extractConfigSelector(options, 'mode')?.configId).toBe('approval');
    expect(extractConfigSelector(options, 'model')?.configId).toBe('model');
  });



});
