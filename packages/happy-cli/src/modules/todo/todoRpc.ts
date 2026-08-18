/**
 * 机器级 todo RPC（B-007）：`todo-list` / `todo-complete` / `todo-create`。
 *
 * 注册在 daemon 的 machine-scoped RpcHandlerManager 上（同 fsRpc），让 web 能看到并
 * 操作**外部** todo 系统 —— 而 very-happy 对那个系统一无所知：它只跑一条用户在本机
 * 配的命令，按 `docs/channels.md` 的契约收 JSON。
 *
 * ⚠️ 安全边界（spec 风险 1）：provider 命令 = 机器上的任意代码执行。它**只从
 * ~/.happy/settings.json 读，web 端绝不可写** —— 否则一个被劫持的 web 会话就等于 RCE。
 * daemon 本就暴露 `bash`，所以能力面没变，但「谁能设置它」是新的攻击面。
 *
 * ⚠️ 全程 argv 列表 + env dict，**绝不经 shell**。todo 标题来自外部系统，是不可信
 * 输入；2026-08-17 在另一个项目实测过：把标题拼进 `bash -c` 时一个撇号就是语法错误、
 * 构造过的标题可执行任意命令。
 *
 * 错误按 fsRpc 的约定抛成带稳定 code 的 Error，RpcHandlerManager 会编码成 `{error}`
 * 正常响应（B-003 坑：web 侧必须显式检查 `error` 字段）。
 */
import { spawn } from 'node:child_process';
import { logger } from '@/ui/logger';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { readSettings } from '@/persistence';
import { buildProviderArgv, parseTodoList, TODO_TITLE_MAX_CHARS, type TodoListParse } from './todoContract';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

export interface TodoProviderConfig {
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
}

async function readProviderConfig(): Promise<TodoProviderConfig | null> {
    const settings = await readSettings();
    const raw = (settings as { todoProvider?: unknown } | null)?.todoProvider;
    if (!raw || typeof raw !== 'object') return null;
    const cfg = raw as Record<string, unknown>;
    if (typeof cfg.command !== 'string' || !cfg.command.trim()) return null;
    return {
        command: cfg.command.trim(),
        args: Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : undefined,
        cwd: typeof cfg.cwd === 'string' && cfg.cwd.trim() ? cfg.cwd : undefined,
        timeoutMs: typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? cfg.timeoutMs : undefined,
    };
}

interface RunResult { stdout: string; stderr: string; code: number | null }

function runProvider(config: TodoProviderConfig, argv: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const [command, ...args] = argv;
        // 注意：没有 shell:true。参数原样进 execve，标题里的引号/分号无从被解释。
        const child = spawn(command, args, {
            cwd: config.cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new Error('timeout'));
        }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        child.stdout.on('data', (chunk: Buffer) => {
            if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            if (stderr.length < 8192) stderr += chunk.toString('utf8');
        });
        // 每个 stdio 流都要有 error 监听——裸管道下未监听的 error 会成为未捕获异常
        // 打死进程（very-happy B-123 的 EPIPE 事故就是这么来的）。
        child.stdout.on('error', () => { });
        child.stderr.on('error', () => { });
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`spawn-failed: ${err.message}`));
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, code });
        });
    });
}

async function invoke(verb: 'list' | 'complete' | 'create', operand?: string): Promise<RunResult> {
    const config = await readProviderConfig();
    if (!config) {
        throw new Error('not-configured');
    }
    const argv = buildProviderArgv(config, verb, operand);
    let result: RunResult;
    try {
        result = await runProvider(config, argv);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(msg === 'timeout' ? 'timeout' : msg);
    }
    if (result.code !== 0) {
        // provider 自己的 stderr 是最有用的诊断信息，原样带给用户——
        // 显示 "unknown error" 等于把人锁在门外
        const tail = (result.stderr || result.stdout || '').trim().slice(-500);
        throw new Error(`provider-error: ${tail || `exit ${result.code}`}`);
    }
    return result;
}

export function registerTodoHandlers(manager: RpcHandlerManager): void {
    manager.registerHandler('todo-list', async (): Promise<TodoListParse & { machineConfigured: true }> => {
        const { stdout } = await invoke('list');
        const parsed = parseTodoList(stdout);
        if ('error' in parsed) {
            throw new Error(`bad-output: ${parsed.error}`);
        }
        logger.debug(`[todo] list → ${parsed.items.length} items (dropped ${parsed.dropped})`);
        return { ...parsed, machineConfigured: true };
    });

    manager.registerHandler('todo-complete', async (params: { id?: unknown }) => {
        const id = typeof params?.id === 'string' ? params.id.trim() : '';
        if (!id) throw new Error('invalid-params: id is required');
        await invoke('complete', id);
        // 结果不解析（契约 D1）：不同后端返回体千奇百怪，解析等于把后端形状焊进来。
        // 要确认结果由调用方重新 list——以外部系统的实际状态为准。
        return { ok: true };
    });

    manager.registerHandler('todo-create', async (params: { title?: unknown }) => {
        const raw = typeof params?.title === 'string' ? params.title.replace(/\s+/g, ' ').trim() : '';
        if (!raw) throw new Error('invalid-params: title is required');
        await invoke('create', raw.slice(0, TODO_TITLE_MAX_CHARS));
        return { ok: true };
    });
}
