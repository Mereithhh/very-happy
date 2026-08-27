# Durable queued message cancellation

> 状态：Final
> 日期：2026-08-27 ｜ 关联 backlog：B-240 ｜ 前身：`specs/2026-08-queued-message-controls.md`

## 背景

新版 composer 会把 agent 工作期间的新输入先留在浏览器本地，并提供编辑、删除和立即干预；但已经通过同步层投递给 CLI 的输入由 transcript 里的另一套 `cl-queue` 展示。后者仍是旧卡片、没有操作，消息只能等当前 turn 结束。仅从 Web 隐藏它会造成“界面说删了、CLI 稍后仍执行”的数据一致性事故。

## 目标

- durable queue 使用与 composer command buffer 一致的紧凑 Console 视觉。
- 用户可取消仍在 CLI 内存队列中的输入；操作期间有行级 loading，失败时消息保留并明确报错。
- 取消结果写入加密会话历史，刷新、分页回填和其他浏览器不会把它重新显示或误当作正常用户消息。
- 本地 queue 的编辑、删除、立即干预在桌面和触摸端都直接可见，不依赖 hover。

## 非目标

- 不撤回已经被 SDK 取走并开始执行的 prompt；此时取消 RPC 返回失败，UI 不假装成功。
- 不修改 server 数据库 schema，也不物理删除历史 message row。
- 本批只为 Claude runner 宣告 durable queue cancellation；其他 flavor 不展示不可用按钮。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| durable queued 输入由 `queuedAt` 和首个 turn-end 推导，并单独渲染为 `cl-queue` | `packages/happy-web-v2/src/sync/reducer/reducer.ts:1330`、`packages/happy-web-v2/src/screens/session/ChatList.tsx:91` |
| `cl-queue` 只有文本行，没有 edit/delete/intervene 控件 | `packages/happy-web-v2/src/screens/session/ChatList.tsx:314` |
| composer 本地 queue 已有三项操作，但桌面默认 `opacity: 0` | `packages/happy-web-v2/src/screens/session/input.css` |
| CLI `MessageQueue2` 的 item 没有来源 id，也没有按项移除方法 | `packages/happy-cli/src/utils/MessageQueue2.ts` |
| server message envelope 已有稳定 `localId`，CLI 三条 inbound 路径解密时都能取得，但未传入 `UserMessageSchema.localKey` | `packages/happy-cli/src/api/apiSession.ts:240`、`:553`、`:694` |

## 设计

### 可寻址 CLI queue

`ApiSession` 在 central socket、HTTP backfill、relay direct 三条入站路径把 server `localId` 注入 user message 的既有 optional `localKey`。`MessageQueue2.QueueItem` 增加 optional `sourceId`，Claude 入队时传入 `message.localKey`。

Claude session 注册 `cancelQueuedMessage` RPC，参数为 `localKey` 与原文。队列优先按 `sourceId` 删除；为兼容升级前已进入当前进程、没有 source id 的 item，再回退删除第一条完全相同文本。RPC 只在 item 仍位于 pending queue 时返回 `removed: true`。

### 可恢复的取消墓碑

Web 只在 session metadata 宣告 `queueCancellation: true` 时显示取消。RPC 成功后，Web 追加一个加密 session envelope：`role=user`、`ev.t=queue-cancel`、`targetLocalKeys=[...]`。它是控制事件而不是 user text，因此旧 CLI 不会把它投入 prompt queue；server 仍只存 opaque ciphertext。

Web normalizer 把该 envelope 转为不可见的 `queue-cancel` event。Reducer 保存 canceled local-key set：无论墓碑先到还是目标消息先到，都把目标标成 `inputState=canceled`；ChatList 与 assistant view 都排除 canceled。附件与对应文本的连续 queued local ids 一起写入墓碑，但 RPC 仍按承载附件的 text queue item 删除。

### UI

durable queue 改为 composer 同款的轻量 command-buffer surface：弱化外框与阴影，header 使用 mono 标签与状态文案；每个可取消文本行常显一个中性 trash button。取消时按钮换 Spinner 并禁用重复操作；失败 toast。accent 不用于普通删除动作。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 Web + 新 CLI（Claude） | metadata 宣告能力；可真实取消并持久隐藏 |
| 新 Web + 旧 CLI | 能力字段缺失，不展示会失败的取消按钮；旧 durable queue 仍只读 |
| 旧 Web + 新 CLI | 不调用 RPC、不发送墓碑；行为不变 |
| 旧 Web 遇到新墓碑 | session event schema 不认识时忽略；不会成为 prompt |

无需 server 变更。发布顺序 CLI → `vh-update` 重启 daemon → Web；Web 可独立回滚，CLI optional RPC/metadata 留存无副作用。

## 风险

1. **相同文本误删**：正常路径按 `localKey`；文本 fallback 只服务升级前无 id 的遗留 item，并只删第一项。
2. **RPC 成功、墓碑持久化失败**：当前 reducer 先乐观处理墓碑；Web 同步重试 outbox。即使短时重现，CLI item 已真实删除，不会执行。
3. **墓碑早于目标分页到达**：reducer 的 canceled set 独立于消息到达顺序，目标后到仍隐藏。
4. **附件残影**：Web 将目标文本之前连续的 queued file local ids 与文本 id 一起取消。

## 验收标准

- [ ] CLI 队列可按 source id 删除；legacy item 可按完整文本 fallback；已被取走时返回失败。
- [ ] 三条 CLI 入站路径都保留 server localId，去重逻辑不回归。
- [ ] durable queued 文本可取消，有 loading；失败保留并 toast。
- [ ] 取消墓碑在目标前/后到达都能隐藏目标，且自身不渲染。
- [ ] local queue 三项操作在桌面不 hover 也可见。
- [ ] 中英文文案、亮暗主题、320/390px 无溢出。
- [ ] Web vitest/build/tsc 与 CLI test/runtime smoke 全绿。

## 留真机验证项

- iOS/Android 与桌面：取消带附件 queued input；断网重连后取消项不复活。
