# Claude SDK live permission mode

**Status:** Final
**Date:** 2026-08-28
**Backlog:** B-254

## Problem

Web 当前只把权限选择写入本地 session/default，并在下一条 user message 的 meta 中交给 CLI。Claude Agent SDK 的当前 `Query` 不会因此改变，所以 running turn 即使 UI 已显示 YOLO，仍可能为 `Write` 等工具发出 `Permission required`。新会话还有一条独立的不一致：review-first spawn 实际用 `plan`，但 session 尚未进入 store 时该模式未被记住，composer 会按代码默认回退成 YOLO，首条消息也可能不携带真实 spawn mode。

## Contract

1. 新 CLI 在 metadata 宣告 `claude-live-permission-v1`，并为 Claude remote session 提供 `set-permission-mode` RPC。请求只接受 Happy 已知权限枚举，并在 Claude 边界归一为 `default | acceptEdits | bypassPermissions | plan`；`yolo` 映射为 `bypassPermissions`。Remote Query 创建时始终设置 SDK 的 `allowDangerouslySkipPermissions` opt-in；它本身不绕过审批，只让用户随后显式切入 `bypassPermissions` 不被 SDK 拒绝。
2. running turn 中，Web 仅在 capability 存在时调用 RPC；RPC 成功后才更新当前 session 选择及该 agent 的 synced default。失败时保留旧显示并给出错误，不声称已生效。idle 时仍只更新本地/default，由下一条消息生效。
3. CLI 对一次切换串行更新三处状态：当前 SDK `Query`、`PermissionHandler`、`runClaude` 的 sticky mode。之后同一 Query 的下一次权限边界和后续 turn 使用新模式；launcher 的 mode/hash 同步更新，避免 Steer 依据旧模式误判。
4. 若切换后的模式可自动允许一个已挂起的普通 tool permission，CLI 先完成该 `canUseTool` 回调，再更新 Query，解除当前阻塞：
   - `bypassPermissions`：所有普通工具；
   - `acceptEdits`：edit 类工具；
   - `plan`：只读且非 dangerous 工具（正常情况下这些不会形成 pending）。
5. `AskUserQuestion`、`ExitPlanMode`、MCP elicitation 与 user dialog 永不因 live mode 切换自动完成。`ExitPlanMode` 审批回调仍只完成当前审批，不在响应前嵌套第二条 SDK control request。
   若这类交互正在阻塞 Query，handler 先在本地采用新模式，SDK control request 延迟到最后一个 pending callback 完成后的下一 event-loop turn，避免嵌套控制死锁。
6. 降权不能撤回已经开始执行的工具；它从当前 Query 的下一权限边界生效。直接 SDK 切换失败时 CLI 回滚 handler/sticky mode；已经按用户升权请求放行的当前工具无法逆转，但不得发生未经用户请求的额外放行。因交互 callback 阻塞而延迟的 SDK 更新失败时，当前 Query 仍由本地 handler 执行用户所选策略，后续 Query 使用已更新的 sticky mode，并记录诊断日志。
7. spawn 成功后，Web 必须在导航或发送 optional first command 前按返回的 session id 持久化这次 spawn 的权限模式；session snapshot 随后到达时继续采用该显式值。

## Compatibility matrix

| Web | CLI | Running selection |
|---|---|---|
| new | new capability | RPC 立即作用于当前 Query；成功后更新 UI/default |
| new | old/no capability | 保留旧行为：选择写入下一 turn，不发送未知 RPC |
| old | new | 不发送 RPC；CLI 继续按 message meta/启动参数工作 |

不改 server/wire schema：session RPC 名称和 metadata capability 都是既有可扩展通道。`permission-mode-changed` 持久事件不作为本规格的正确性依赖，避免把控制 ACK 渲染进 transcript。

## Verification

- 纯函数：非法模式 fail closed，`yolo` 正确映射。
- CLI：default 下挂起 `Write` 后 live 切到 bypass 会 resolve；`ExitPlanMode` / interaction 不会；SDK setter 失败不把未来请求留在新模式；连续切换按请求顺序执行。
- launcher/runClaude：RPC 回 ACK、sticky mode 和 live mode/hash 同步；capability 发布。
- Web：running + capability 才发 RPC，失败不提交 UI；idle/旧 CLI 降级；spawn mode 在 session snapshot 到达前即可持久化并进入首条 message meta。
