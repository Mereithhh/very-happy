# 推送整理（同会话顶替 / Topic / 短 TTL / 已读水位）+ 测试通知与开通引导

> 状态：Draft（实现 agent 起草，待主 agent 定稿）
> 日期：2026-10-13 ｜ 关联 backlog：B-569、B-570 ｜ 参考：Orca `mobile/src/notifications/push-dismissal-watermarks.ts`、`push-tray-dismissal.ts`、`mobile/src/onboarding/NotificationOnboardingPreview.tsx`、`mobile/src/notifications/notification-opt-in-gate.ts`（MIT，只借做法）｜ 前身：B-559 `specs/2026-10-pwa-app-badge.md`

## 背景

- **堆叠**：同一个会话连续几次「需要你决策 / 跑完了」会在系统通知栏堆成一列，旧的已经没意义。
- **过期洪水**：Web Push TTL 是 28 天，手机/电脑离线一夜后上线，推送服务把积压的一批「跑完了」一次性吐出来，大多早已处理过。
- **只清本机**：在 A 设备打开会话后，`systemNotificationDismiss` 只能关 A 上的横幅；B 设备通知栏里的旧通知一直挂着。
- **不可验证**：用户开了通知却不知道到底通没通（订阅可能早已过期被清理），没有「发一条试试」的入口。
- **难开通**：通知开关埋在设置里；装成 PWA 后没有任何引导，iOS 又要求必须由用户点击触发授权。

## 目标

B-569 推送整理：
1. SW 展示通知时按目标设 `tag`（`session:<id>` / `terminal:<tid>`），同目标新通知顶替旧通知，且 `renotify: true` 仍会提醒。
2. server 发 Web Push 时带 `Topic`（按目标 hash，≤32 个 URL-safe base64 字符），并按类别缩短 TTL：需要你决策（permission/question）24h，完成类（done/completed）6h，测试 5min。
3. payload 增加可选 `sentAt` 与 `seen`（该用户跨设备已读水位的子集）；SW 收到任何推送时，先用 `getNotifications()` 关掉水位已覆盖的旧通知，再展示本条。
4. B-559 角标与「标为未读」行为不退化。

B-570 通知可验证、可开通：
5. 设置「浏览器通知」分区加「发送测试通知」：server 新接口 `POST /v1/push/test`（鉴权、每账号 10s 1 次），向该账号所有 Web Push 订阅发一条标明「测试」的通知，返回计数；过期订阅按现有逻辑清理。Web 显示「已发送到 N 个设备」/「还没有设备订阅 → 引导开启」；旧 server 返回 404 时按钮变为不可用并说明。
6. 已登录、支持 Web Push、权限仍是 `default`、未关闭过引导时，非阻断式引导卡（含通知样子预览）邀请开启；授权必须在点击处理里直接调用 `requestPermission`（iOS 要求）；可关闭且记住（localStorage，try/catch）。

## 非目标

- 不发「不显示的」推送：每次 push 必须 `showNotification`（iOS 会撤销吞推送的 worker 的权限）。水位清理只搭在正常通知上，不单独发「清理推送」。
- 不改 CLI、wire、Expo 推送通道（废弃 Expo app 不改）；不加 Prisma migration、不加新 KV key、零新 npm 依赖。
- 不改前台 `new Notification`（`webNotifications.ts`，tag = 原始 sessionId）的 tag 语义。
- 不改 SW 注册、`skipWaiting`/`clientsClaim`、precache 与 `swTakeover.ts`。
- 测试通知不发给 Expo token 与 webhook；不做按设备选择发送。
- 角标估计逻辑（B-559 D3）不因水位清理而减数——页面打开即以精确数覆盖。

## 现状事实（代码已确认，基线 origin/main `d912dcbf9`）

| 事实 | 位置 |
|---|---|
| SW `showNotification` 只设 `body/icon/badge/data:{url}`，无 `tag`；同会话通知堆叠 | `packages/happy-web-v2/public/push-sw.js:29-34` |
| B-559 角标：push 的同一 `waitUntil` 里 `bumpAppBadge()`，异常吞掉 | `public/push-sw.js:36-37, 75-90` |
| Web Push TTL 固定 28 天、Urgency high，无 Topic | `packages/happy-server/sources/app/push/webPush.ts:158-159` |
| Web Push payload = `{title, body, data:{sessionId, ...CLI data}}`；CLI data 含 `kind`、`url`（新 CLI）、`sessionTitle` | `app/push/pushDispatch.ts:102-106`、`happy-cli/src/api/pushNotifications.ts:276-283` |
| 终端事件推送走 `dispatchDeviceEventPush`，data = `{kind: completed|permission, url:/terminal/<m>?tid=<t>}`，无 sessionId | `pushDispatch.ts:169-199`、`api/routes/pushRoutes.ts:336-349` |
| 过期订阅（404/410）删除；格式坏的订阅删除 | `pushDispatch.ts:96-110` |
| 跨设备已读水位 = 账号 KV `vh.notif-seen.v1`，值为 UTF-8 JSON `{"seen":{<key>:<ms>}}`（key = sessionId 或 `t:<terminalId>`），按 key 取 max 合并，永不回退 | `happy-web-v2/src/sync/notificationSeenStore.ts:52,134-136`、`sync/notificationSeen.ts` 头注 |
| server KV 表 `UserKVStore(accountId,key)` 唯一，`value Bytes?`；server 侧可直接读，无需 migration | `prisma/schema.prisma:487-499`、`app/kv/kvGet.ts` |
| 本机清横幅只匹配 `tag === key` 或 `data.url` 推出的 key | `src/sync/notificationSeen.ts` `systemNotificationMatchesKey`、`sync/systemNotificationDismiss.ts` |
| 现有按账号限流器 `createAccountRateLimiter({max, windowMs})`（内存） | `app/push/webhookNotify.ts:399-420` |
| 设置通知分区：未支持时只显示提示；支持时 `toggleMaster` = 申请权限 → `enableWebPush` | `src/screens/settings/SettingsRoutes.tsx:1950-2030` |
| PWA 安装卡固定右下角，localStorage try/catch，`never` 键记住 | `src/app/PwaInstallPrompt.tsx`、`app/pwaInstallPolicy.ts` |
| `requestNotificationPermission()` 首个 await 就是 `Notification.requestPermission()`，授权后把本机 prefs.enabled 置 true | `src/sync/webNotifications.ts:47-62` |

## 设计

### D1 SW：tag 顶替 + 水位清理（`public/push-sw.js`）

纯函数放在 push-sw.js 顶层（classic script 不能 import；测试用 `node:vm` 执行真实文件取出函数，沿用 `pushSwBadge.test.ts` 的做法）：

- `vhTargetKeyOfUrl(url)`：`/session/<id>` → `<id>`（`pending-` 前缀除外）；`/terminal/<m>?tid=<t>` → `t:<t>`；其他 → null。与页面 `targetKeyOfPath` 同语义。
- `vhPushKey(data)`：`data.sessionId`（非空字符串）优先，否则 `vhTargetKeyOfUrl(data.url)`。
- `vhNotificationTag(payload)`：`data.kind === 'test'` → `vh-test`；key 为 `t:<t>` → `terminal:<t>`；其他 key → `session:<id>`；无 key → null（不设 tag，退化为旧行为）。
- `vhKeyOfNotification(n)`：tag `session:`/`terminal:` 前缀 → key；否则 `data.key`；否则 `data.url` 推导（覆盖旧 SW 展示的无 tag 通知）。
- `vhNotificationCreatedAt(n)`：`data.createdAt`（数字）→ 否则 `n.timestamp`（Chromium 默认是创建时刻）→ 否则 null。
- `vhParseSeen(x)`：宽松解析，丢弃非正数/非数字；非对象 → `{}`。
- `vhStaleNotifications(list, seen, exceptTag)`：返回 key 存在、createdAt 存在、`seen[key] >= createdAt` 且 `tag !== exceptTag` 的通知。

push 处理：
1. 解析 payload（失败仍展示兜底通知，同现状）。
2. `tag = vhNotificationTag(payload)`；`createdAt = payload.sentAt`（有限正数）否则 `Date.now()`。
3. `waitUntil(Promise.all([ sweep→show, bumpAppBadge ]))`：先 `vhSweepSeen(payload.seen, tag)`（`getNotifications()` + close 过期项，异常吞掉），**之后**一定 `showNotification`。先清后显保证本条永远不会被自己清掉；本条 tag 也被排除，防设备时钟超前导致的自清。
4. options：`{ body, icon, badge, data: { url, key, kind, createdAt } }`，有 tag 时加 `tag` 与 `renotify: true`。
   - **renotify 全部为 true**：服务端已在用户在线时抑制推送，到达 SW 的每条都是「该提醒」；如果 done 静默顶替 permission，用户会错过完成提醒。tag 只解决堆叠，不改变提醒语义。Safari 不支持 renotify，忽略即可；`renotify` 只在 tag 非空时设置（空 tag + renotify 会抛 TypeError）。
   - `url` 缺失但有 sessionId（旧 CLI 不带 url）时补 `/session/<id>`，点击可直达。
5. `notificationclick` 不变（读 `data.url`）。

页面侧 `systemNotificationMatchesKey` 追加识别 `session:<id>` / `terminal:<tid>` tag 与 `data.key`（追加分支，旧匹配保留）。

### D2 server：Topic + TTL（`app/push/pushHygiene.ts` 纯函数 + `webPush.ts`）

- `webPushTopic(key)` = `sha256("vh:" + key)` 的 base64url 前 32 字符。RFC 8030 §5.4 要求 Topic ≤32 字符、URL-safe base64 字母表；hash 避免把 sessionId 原文交给推送服务，也规避 id 字符集与长度。key 规则与 SW 相同（sessionId / `t:<tid>` / `test`）。
- `webPushTtlSeconds(kind)`：
  - `permission` / `question`（及 device 事件 `permission`）→ **24h**：需要你决策的请求在 agent 侧一直阻塞，一天内上线仍值得看；超过一天大概率已在别处处理或会话已失效。
  - `done` / `completed` → **6h**：完成是信息性提醒，离线一夜后再收到「跑完了」只是噪音；完整历史仍在应用内通知中心（保留期 1–30 天），不会丢信息。
  - `test` → **5min**：测试通知过时即无意义。
  - 未知 kind → 24h（保守取长者，不丢可能需要处理的事件）。
- Topic 让推送服务对同一目标只保留最新一条待投递消息，配合短 TTL，离线回来每个会话最多一条。
- `sendWebPush(sub, payload, opts?)` 增加可选 `{ ttlSeconds, topic }`；不传时 TTL 默认 24h（原 28 天）。Urgency 保持 high。

### D3 server：已读水位（`seen`）

- 数据源：同一账号 KV `vh.notif-seen.v1`（Web 已在写，server 只读）。**零 migration、零新 KV key**。
- `dispatchSessionEventPush` / `dispatchDeviceEventPush` 在确定要发 Web Push 后读一次（每次派发一次查询，`findUnique` 走唯一索引）；读失败/无记录 → 不带 `seen`。
- `selectSeenWatermark(seen, now, budgetBytes)`（纯函数）：只取近 7 天（与 24h TTL + 通知栏滞留匹配）、按 lastSeen 新→旧、最多 40 条，并在字节预算内贪心加入。预算 = 3500 − 基础 payload 的 UTF-8 字节数（Web Push 单条明文上限约 3993 字节，留余量）；预算不足时整段省略。
- payload：顶层 `sentAt`（server 毫秒）与 `seen`（`{key: ms}`）。放顶层而非 `data`：`data` 来自 CLI，顶层是 server 独占，不会撞名。
- 时间模型与通知中心一致：通知 createdAt 用 server 时间，seen 戳是看过的设备的本地时间（`notificationSeen.ts` 已接受同样的偏差，`arrivalStampAt` 限制前向偏移 120s）。

### D4 测试通知（B-570 ①）

- server `POST /v1/push/test`（`app.authenticate`）：body `{ title?: ≤100, body?: ≤300 }`（Web 传本地化文案，缺省用英文默认）。`createAccountRateLimiter({ max: 1, windowMs: 10_000 })` → 超限 429 `{ error: 'rate_limited' }`。
- 派发 `sendTestWebPush(userId, copy)`（`pushDispatch.ts`）：不做在线抑制（用户正在页面上点它）；只发 `webpush:` 订阅；data `{ kind: 'test', url: '/settings/notifications' }`，Topic = `webPushTopic('test')`，TTL 300s；过期/坏订阅删除同现有逻辑。
- 返回 200 `{ configured, total, sent, failed, pruned }`：`configured=false`（无 VAPID）时 total 照数、sent=0。
- Web `apiPush.sendTestPush()` 结果联合：`ok`(计数) / `unsupported`(404) / `rate-limited`(429) / `error`。纯函数 `describeTestPushResult()` 映射成文案 key：
  - `sent>0` →「已发送到 N 个设备」（`failed>0` 时追加失败数）；
  - `total=0` 或全部过期 →「还没有设备订阅推送，先打开上面的开关」；
  - `configured=false` →「服务器未配置 Web Push」；
  - `unsupported` →「当前服务器版本不支持测试通知」，按钮置灰（本次页面会话记住）；
  - `rate-limited` →「太频繁了，10 秒后再试」。
- UI：在「浏览器通知」分组里追加一行 Item（标题「发送测试通知」+ 结果作 subtitle + 右侧按钮）。只追加，不重排既有行。

### D5 开通引导卡（B-570 ②，`screens/notifications/NotificationOptInCard.tsx` + `notificationOptIn.ts`）

- 纯 gate `shouldOfferNotificationOptIn({ supported, permission, dismissed, installPromptVisible, onNotificationSettings })`：支持 Web Push 且 `permission === 'default'` 且未关闭过、PWA 安装卡当前不可见、当前不在通知设置页 → 显示。`denied`（拒绝过）/`granted`/不支持 → 永不显示。
- 挂在 `AppLayout`（只在已登录 App 内）；首次满足条件后延迟 2.5s 出现，固定右下（手机底部全宽，16px 内边距），非模态、不抢焦点、`role="region"`。
- 与 PWA 安装卡互斥：`PwaInstallPrompt` 在 guide 变化时写一个小的模块级可见性信号（`app/pwaInstallVisibility.ts`），引导卡订阅之；装卡显示期间引导卡让位。PWA 安装（`appinstalled` 或 standalone 启动）后安装卡消失，引导卡随即可出现——满足「PWA 安装后」的时机。
- 预览：卡内两条静态示例通知（「需要你决策」「跑完了」样式，标明「示例」），`aria-hidden`，减少动态效果时无动画。
- 「开启通知」按钮：点击处理的**第一个异步调用**就是 `requestNotificationPermission()`（内部第一步即 `Notification.requestPermission()`，满足 iOS 用户手势要求）；granted → `enableWebPush(credentials)` → 用 `registration.showNotification` 弹一条本地「通知已开启」预览（tag `vh-test`，失败忽略）→ 关卡；denied → 关卡（之后 gate 永不再显示）。
- 「以后再说」/ ×：写 `vh-notif-optin-dismissed-v1 = 1`（try/catch；存储不可用时仅本次隐藏）。

## 兼容矩阵与发布顺序

CLI 不涉及：CLI 只调用既有 `/v1/sessions/:id/push-event`、`/v1/webhook/notify`，请求体不变；Topic/TTL/`seen`/`sentAt` 全由 server 在派发时附加，新旧 CLI 行为相同。旧 CLI 不带 `data.url` 时由新 SW 用 sessionId 补 url/tag（反而改善）。

| server \ web(SW) | 新 web（新 SW） | 旧 web（旧 SW） |
|---|---|---|
| **新 server** | 全功能：tag 顶替、Topic、短 TTL、水位清理、测试通知、引导卡 | 旧 SW 只读 `title/body/data.url`，忽略顶层 `sentAt/seen` → 照旧堆叠但 Topic/TTL 已生效（离线洪水在服务端消除）；无测试按钮/引导卡 |
| **旧 server** | 无 `seen/sentAt` → 不清理，`createdAt` 取 SW 当前时间；tag 仍按 `data.sessionId`/`data.url` 生效（旧 server 也发 sessionId）；测试接口 404 → 按钮置灰「服务器不支持」；引导卡照常（只依赖既有订阅接口） | 现状 |

- 新页面 + 旧 SW（SW 更新完成前）：测试通知仍由旧 SW 展示（`kind` 被忽略，无 tag）；引导卡授权走既有 `enableWebPush`。
- 旧页面 + 新 SW：SW 行为只取决于 payload，与页面版本无关。
- 新 SW 展示、旧页面清本机横幅：旧页面的 `systemNotificationMatchesKey` 不认识 `session:` tag，但 `data.url` 仍在（有 sessionId 时 SW 会补 url）→ 仍可匹配。
- 多设备：A 打开会话 → KV 水位前移 → 下次任何推送到达 B 时，B 上该会话的旧通知被关掉；B 若一直收不到新推送，旧横幅保留（不发静默推送，接受）。

发布：server 与 Web 同一镜像，一次发布即可；无先后依赖。回滚 = 回滚镜像：旧 server 恢复 28 天 TTL 无 Topic；新 SW 已安装的设备在回滚前后都兼容（见上表）。

## 风险

1. **水位清理依赖下一条推送**：B 设备若之后再没收到任何推送，旧通知不会被清。iOS 禁止静默推送，接受；打开应用后本机 `systemNotificationDismiss` 仍会清。
2. **时钟偏差**：seen 戳是设备本地时钟。设备时钟超前时可能把略早的通知判为已读而关掉——只影响「旧」通知，本条推送被排除（先清后显 + 排除本 tag），最坏是早关一条旧横幅；接受。
3. **payload 体积**：`seen` 有 3500 字节总预算与 40 条上限，预算不足整段省略；CLI 传来的超大 data 本来就可能超限（与本改动无关）。
4. **Topic 支持度**：RFC 8030 标准头，FCM / Mozilla autopush / Apple Web Push 均声明支持；不支持的服务会忽略该头，不影响投递。
5. **renotify 在 Safari 无效**：iOS 上同 tag 顶替时是否再次响铃以真机为准（列真机项）；最坏为静默顶替，用户仍能在通知栏看到最新一条。
6. **测试接口限流是内存级**：多实例/重启会放宽，用途是防误连点，不是安全边界；接受。
7. **引导卡打扰**：仅 `permission === 'default'` 且未关闭过时出现，关闭即永久记住；与 PWA 安装卡互斥，不叠两张卡。

## 验收标准

- [ ] `pushSwHygiene.test.ts`（vm 跑真实 push-sw.js）：tag 计算（session/terminal/test/无 key）；同 tag 带 `renotify:true`；无 tag 不带 renotify；`seen` 覆盖的旧通知被 close、未覆盖/无 createdAt/本 tag 的不关；无 `seen`（旧 server）不关任何通知；sweep 抛错仍 showNotification；旧 SW 无 tag 通知按 url+timestamp 被识别。
- [ ] `pushSwBadge.test.ts`（B-559）原样全绿。
- [ ] server `pushHygiene.spec.ts`：Topic ≤32、字符集 `[A-Za-z0-9_-]`、同 key 稳定/不同 key 不同；TTL 分类；水位选择（近 7 天、上限、预算省略、坏数据宽松）。
- [ ] server `webPush.spec.ts`：真实加密 + 打桩 fetch，断言 `TTL`、`Topic` 头；不传 opts 时 TTL=86400 无 Topic。
- [ ] server `pushTest.spec.ts`：`POST /v1/push/test` 401/200 计数/429（10s 内第二次）/过期订阅清理；`sendTestWebPush` 不做在线抑制。
- [ ] Web：`systemNotificationMatchesKey` 认新 tag；`describeTestPushResult` 全分支；`shouldOfferNotificationOptIn` 全分支。
- [ ] server `tsc --noEmit` + `vitest run`；web `tsc --noEmit` + 相关 vitest + `vite build`。
- [ ] 真浏览器（自启 Chromium）：同 tag 两次 `showNotification` 后 `getNotifications()` 只剩 1 条（顶替）；测试按钮 404 降级与结果文案；引导卡 1280 / 390 coarse × 亮 / 暗无溢出。

## 留真机验证项

- iOS 16.4+ 已安装 PWA：同会话第二条推送顶替第一条；顶替时是否响铃（renotify 不支持）。
- iOS PWA：引导卡「开启通知」点击即弹系统授权框；授权后收到「测试通知」。
- iOS/Android：A 设备看过会话后，B 设备收到另一条推送时旧通知被清掉。
- 离线 >6h 后上线：完成类积压推送不再出现；同会话最多一条。
