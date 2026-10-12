# PWA 应用图标未读角标 + 通知「标为未读」

> 状态：Final（主 agent 2026-10-12 review 后定稿：可见时强制重写、SW 10s 新鲜度、登出清理、当前目标不提供标为未读）
> 日期：2026-10-12 ｜ 关联 backlog：B-559 ｜ 参考：Orca `docs/site/content/docs/notifications.mdx`（只读）｜ 相关：B-536（notification seen 去重）、B-086（跨设备 seen）

## 背景

通知中心（铃铛）有未读数，但装成 PWA 后桌面/主屏图标上看不到；用户必须打开应用才知道有没有事。
另外 inbox 条目点开即已读，误点后没有办法「留着待会儿看」。

## 目标

1. 页面里的 inbox 未读数同步到 `navigator.setAppBadge(n)`；为 0 时 `clearAppBadge()`。特性检测，不支持（Firefox、非安装态 Safari 等）静默跳过，不报错。
2. Service Worker 收到 Web Push 时，若没有可见窗口，在「页面最近一次上报的未读数」上 +1 设置角标；从未上报过则设无数字的角标标记。页面再次打开后以页面的精确计数覆盖。
3. inbox 条目菜单（行尾「⋯」与右键/长按共用）提供「标为未读」/「标为已读」。
4. 「标为未读」与现有跨设备 seen 取 AND：标记后，只要该目标在**标记之后**没有在任何设备被打开过，它就保持未读；之后在任一设备打开目标（seen 时间戳越过标记时刻）即自动退回已读。

## 非目标

- 不改 server、push payload、wire；不加 Prisma migration、不加 KV key。
- 「标为未读」不跨设备同步（存在本机 MMKV）。跨设备同步需要新的 KV 状态和合并语义，收益小，留后续。
- 不加设置开关（角标与铃铛数字同源，铃铛本身没有开关）。
- 不改 SW 注册、`skipWaiting`/`clientsClaim`、precache 与 `swTakeover.ts` 更新链路。

## 现状事实（代码已确认，基线 origin/main `ba901bc44`）

| 事实 | 位置 |
|---|---|
| inbox 未读 = 设备本地旧标记（feed 水位线 + 已读 id 覆盖层；local 条目 `read`）AND 跨设备 seen 规则 | `screens/notifications/useInbox.ts`、`sync/notificationSeen.ts` `isEntryUnread` |
| seen 是每目标单调时间戳 `lastSeenAt[key]`，按 max 合并、永不回退；条目未读 ⟺ `createdAt > lastSeenAt[key]` | `sync/notificationSeen.ts` 头注、`planSeenWrites` |
| 因为 seen 不可回退，「标为未读」不能靠改 seen 实现，只能在其上叠一层 | 同上 |
| 铃铛同时挂在 Sidebar 底部与折叠 rail（`NotificationBell` 两处），各自调用 `useInbox()` | `screens/sessions/Sidebar.tsx`、`screens/AppLayout.tsx` |
| 条目行是单个 `<button>`，没有菜单；共享菜单原语 `ActionDropdownMenu` / `ActionContextMenu` | `NotificationBell.tsx`、`ui/Menu.tsx` |
| SW 由 VitePWA generateSW 生成，push/notificationclick 处理在 `public/push-sw.js`（`workbox.importScripts`）；push payload 只有 `{title, body, data:{url}}`，没有未读数 | `vite.config.ts`、`public/push-sw.js`、server `app/push/webPush.ts` |
| 代码库此前没有任何 `setAppBadge` 调用 | `grep -rn setAppBadge packages/happy-web-v2/src` 为空 |

## 设计

### D1 「标为未读」覆盖层（`sync/notificationUnreadMarks.ts` 纯函数 + `notificationUnreadMarksStore.ts`）

- 本机 MMKV：`entryId → markedAt`（上限 200 条，超出淘汰最旧；超出保留期的随 inbox 一起不可见，无需单独清）。
- 判定（纯函数，全表单测）：
  `unread = (legacyUnread AND unreadBySeen) OR (markedAt 存在 AND NOT isSeenAt(seen, key, markedAt))`
  —— 标记本身与「标记后未被看过」取 AND；seen 为空/不可用时退化为「标记即未读」。
- `markEntryRead(entry)` 同时清掉该条标记；「全部已读」清空全部标记。
- 「标为未读」= 写 `markedAt = now`；对当前打开的目标标记会在下一次 seen 心跳（≤60s）后退回已读，接受（用户正看着它）。

### D2 角标同步（`notifications/appBadge.ts` + `AppBadgeSync`）

- 纯函数 `planBadge(count)` → `{ kind: 'set', n } | { kind: 'clear' }`；`applyAppBadge(nav, count)` 做特性检测（`typeof nav.setAppBadge === 'function'`），吞掉 rejection（未安装/权限）。
- 同值去重：只在计数变化时调用；但页面 `visibilitychange → visible` 时 `reset()` 再 `sync()`，强制重写角标与 SW 计数（覆盖隐藏期间 SW 的 +1 估计）。
- 登出（`AuthContext.logout`）调用 `clearNotificationStateOnLogout`：`clearAppBadge`、给 SW 发 count 0、清空「标为未读」标记；任何异常吞掉，不阻塞登出。
- 同时 `postMessage({ type: 'vh-badge-count', count })` 给 `navigator.serviceWorker.controller`（存在才发）。
- `AppBadgeSync`（渲染 null）在 `AppLayout` 挂一次，避免两个铃铛重复写。

### D3 SW（`public/push-sw.js`，只追加监听）

- `message` `vh-badge-count`：把计数写入独立 Cache `vh-badge-v1`（不与 workbox precache 同名，workbox 清理不碰它）。
- 缓存值 `{count, at, from}`：`from='page'` 为页面上报，`'sw'` 为 SW 自己的 +1 估计。
- `push`：在原有 `showNotification` 的同一个 `waitUntil` 里，若 `self.navigator.setAppBadge` 存在且没有 `visibilityState === 'visible'` 的窗口：无缓存 → `setAppBadge()`（无数字标记）；页面上报不足 10s（`VH_BADGE_FRESH_MS`，说明页面仍活着、会自己发精确数）→ 跳过；否则 `count+1` 写回（`from='sw'`）并设置。任何异常吞掉，绝不影响通知展示（iOS 会撤销吞 push 的 worker 的权限）。
- 不改 install/activate/fetch，不改注册；`push-sw.js` 字节变化只会走正常的 SW 更新检测。

### D4 UI（`NotificationBell.tsx`）

- 共享 `.vh-menu` 层级 1500 低于通知层 1600：`ActionDropdownMenu`/`ActionContextMenu` 增加可选 `contentClassName`，行菜单用 `.nc-row-menu`（1700）。

- 行改为 `<div class="nc-row-wrap">`：主 `<button class="nc-row">` 不变 + 行尾 `⋯` `ActionDropdownMenu`；整行包 `ActionContextMenu`（右键 / 触屏长按）。
- 菜单项（`entryReadAction`）：未读 →「标为已读」，已读 →「标为未读」；**当前正打开的目标**（`targetKeyOfPath`）已读时不提供菜单——seen 心跳会在一分钟内把标记自动收回。

## 兼容矩阵与发布顺序

纯 Web（含 SW 脚本）改动；server / CLI / wire 不变，不依赖 session capabilities。

| 组合 | 行为 |
|---|---|
| 新 web + 任意 server/CLI | 角标与铃铛同源；push 依旧由 server 发，SW 本地 +1 |
| 旧页面（缓存的旧 shell）+ 新 SW | 页面不上报计数 → SW 只在 push 时设无数字标记；页面更新后恢复精确计数 |
| 新页面 + 旧 SW（更新完成前） | 旧 SW 忽略未知 message；页面自己 set/clear 角标照常 |
| 旧 web | 无角标、无「标为未读」，与现状一致 |
| 多设备：A 标为未读、B 打开该目标 | B 的 seen 戳同步到 A，A 上该条在 seen 晚于标记后退回已读（D1 的 AND） |

发布：随任意一次 server/Web 镜像；回滚 = 回滚 Web。回滚后旧 SW 不读 `vh-badge-v1` 缓存，残留一个小条目，无害。

## 风险

1. **push 时的 +1 是估计**：同一事件 feed 与 local 双通道去重、或推送对应的条目已被别的设备看过，都会让角标暂时偏大；打开应用即校正。接受。
2. **登出**：已在 `logout` 中清角标、SW 计数与标记；AppLayout 卸载本身不 clear（离开 App 路由不等于登出）。
3. **iOS 角标需安装到主屏 + 通知权限**：浏览器验不了，列真机项。
4. **Radix 菜单在通知面板（portal + backdrop）里的层级/点外关闭**：真浏览器验证。

## 验收标准

- [x] `notificationUnreadMarks.test.ts`：标记→未读；标记后 seen 越过→已读；seen 早于标记→仍未读；标为已读清标记；上限淘汰。
- [x] `appBadge.test.ts`：特性检测缺失静默；同值去重；0 → clear；rejection 被吞；SW message 只在有 controller 时发。
- [x] 桌面 Chromium：未读数变化时 `navigator.setAppBadge` 以正确参数被调用、清零时 `clearAppBadge`（打桩记录调用）。
- [x] SW：注入构建后的 `push-sw.js` 在真实 SW 中收到 `vh-badge-count` 后，模拟 push 调用 `self.navigator.setAppBadge(n+1)`（可行范围内验证）；SW 更新链路未改动（diff 不触碰 `swTakeover.ts`/注册代码）。
- [x] 条目「⋯」与右键菜单：标为未读后铃铛数 +1、行加粗；再标为已读恢复；1280 与 390 coarse × 亮/暗无溢出。
- [x] `tsc --noEmit`、相关 vitest、`vite build` 全绿。

## 验收记录（2026-10-12）

- 自启 Chromium（playwright-core + 缓存 chromium-1187），本地 standalone server + vite + 隔离 daemon：未读 2→`set:2`；⋯ 标为已读→`set:1`；右键标为未读→`set:2`、铃铛 2；该目标 seen 戳晚于标记→`set:1`；全部已读→`clear`。菜单项 `elementFromPoint` 命中 `.vh-menu`（在通知层之上）。1280 亮/暗、390 coarse 亮/暗无横向溢出，⋯ 触屏 40px 常显。
- SW：origin/main 构建 → 本分支构建（保留旧 hashed assets）：`controllerchange` 触发、controller 更换、入口 hash 变化；新 worker `self.navigator.setAppBadge` 为 function；页面上报 3 → 缓存 3；有可见窗口时 push 不动；无窗口 push → 4。

- review 修复复验（自启 Chromium）：当前目标 `/session/s-a` 的已读条目无菜单、另一条有；可见事件在计数不变时重写出 `clear`；登出后角标日志 `clear`、标记数 0；两构建 SW 链路复验通过，页面上报 >10s 后无窗口 push → 4。

## 留真机验证项

- iOS 16.4+ 已安装 PWA：主屏图标数字随未读变化；App 关闭时收到 push 角标出现。
- Android Chrome 已安装 PWA 的角标/圆点表现。
