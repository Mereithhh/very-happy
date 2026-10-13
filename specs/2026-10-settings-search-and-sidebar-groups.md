# 设置项级搜索 + ⌘K 深链；侧栏分组可折叠并定位当前会话

> 状态：Draft
> 日期：2026-10-13 ｜ 关联 backlog：B-575、B-580 ｜ 出处/前身：Orca `SearchableSetting` / `*-search.ts` / `openSettingsTarget`；`use-collapsed-groups.ts` / `worktree-reveal-group-keys.ts` / `ScrollToCurrentWorkspaceToolbarButton.tsx`（只借鉴做法）

## 背景

- 设置页左栏搜索框只按**分类名**过滤（「搜索设置分类…」），而 `SettingsRoutes.tsx` 两千六百多行里有几十项设置。
  想改「提示音」「免打扰」「diff 换行」的人必须先猜它在哪个分类。⌘K 里只有一条「打开设置」。
- 侧栏只有「已完成（今日）」可折叠；按工作区 / 标签分组时组数一多就要长距离滚动，
  从 ⌘K、通知或直链进入会话时侧栏也不会把当前行滚进视野。

## 目标

### B-575 设置项搜索

1. 声明式设置项索引：每项含稳定 id、分类（= 设置路由 path）、标题与描述（取自现有翻译 key，
   中英同源，不另写文案）、关键词（中英别名，如 提示音/sound/chime、免打扰/quiet hours/DND、换行/wrap）。
2. 设置页搜索框占位改为「搜索设置…」/「Search settings…」。有查询时先列匹配的分类，再列匹配的设置项，
   设置项显示「分类 › 设置项」；点击 → 跳到该分类页，**只滚动设置内容自己的滚动容器**把该行/组滚到上方，
   并以中性 `--bg-3` 短暂高亮（约 1.6s 后淡出）；减少动态效果时无滚动动画、无淡出过渡（静态出现/消失，不闪）。
3. 深链形状：`/settings/<分类>?setting=<id>`（可刷新、可分享；⌘K 用同一个链接）。
4. ⌘K：查询（自由文本）命中设置项时出现一组「设置」，最多 6 行，行标题为设置项、副标题为分类；Enter 直达。
5. 手机：搜索开关展开后同样出现结果列表，点结果后收起搜索并跳转；输入框 16px。
6. 一致性测试：渲染每个分类页，断言索引里每个 id 在页面上有 `data-setting-id` 锚点；索引 id 唯一；
   所有翻译 key 在中英两份文案里都存在。

### B-580 侧栏分组

1. 所有有标题的分组头（状态视图的等待操作/运行中/已完成、工作区分组、标签分组）都可折叠；
   折叠状态按分组 id 存 `localStorage`（`vh:sidebar-collapsed-groups:v1`，读写 try/catch，失败退回内存）。
   「已完成（今日）」默认折叠（保持现状），其余默认展开。
2. 折叠时组头显示会话数 + 组内状态汇总：等待操作（warn 图标 + 数）、运行中（Spinner + 数）、未读（红点 + 数），
   为零的不显示；展开时不显示汇总（行上已有，不重复展示状态）。
3. 被折叠组的行不渲染，也**不占** ⌘1–9 编号、上移/下移的位置（`displayRows` 与渲染一致）。
4. 进入会话（路由变化：⌘K / 通知 / 直链 / 点击）或首次加载时，若当前行所在组折叠则展开它，
   并把该行滚进侧栏列表自己的滚动容器（`.sb-list`，nearest 语义，可见就不动；不用会滚祖先的 `scrollIntoView`）。
   只在路由变化时触发，用户之后手动折叠当前行所在组不会被弹回。
5. 分组菜单加「定位当前会话」：展开 + 滚动；当前视图里没有该行（如在归档视图看活跃会话）时切回列表视图再定位；
   当前路由不是会话/终端时禁用。
6. 键盘：组头是 `<button aria-expanded>`，Enter/Space 切换；focus-visible 用局部底色。触屏组头命中区 ≥44px。
7. 拖拽排序与分组视图规则不变（分组时仍禁止拖拽；归档视图不分组）。

## 非目标

- 不改设置项的持久化、能力门控与文案；不把 SettingsRoutes 拆文件（只加 `settingId` 属性）。
- 不做设置内容的「按查询过滤整页」（Orca `SearchableSetting` 的隐藏行为）——跳转 + 高亮即可，保持页面完整。
- 不新增翻译 key（新 UI 文案沿用 SettingsLayout/Sidebar 现有的 `zh ? … : …` 内联写法，避开 `_default.ts`/`zh-Hans.ts` 热区）。
- 不加「全部折叠/全部展开」、不改团队历史分组（`expandedTeams` 已有自动展开）。
- 不做跨设备同步折叠状态（设备本地偏好）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 设置搜索只按分类名 `label(s).includes(query)` 过滤，占位「搜索设置分类…」 | `packages/happy-web-v2/src/screens/settings/SettingsLayout.tsx:39-43` |
| 设置分类表 `settingsSections`（path/key/icon），路由在 `SettingsRoutes` 内 | `SettingsLayout.tsx:9-24`、`SettingsRoutes.tsx:2588-2605` |
| 设置行/组原语 `Item`/`ItemGroup` 不接受任何额外属性 | `src/ui/Item.tsx:12-71` |
| 设置内容滚动容器 `.set-scroll`（`overflow-y:auto`） | `screens/settings/settings.css:3-8` |
| 窄屏（容器 ≤700px）搜索框靠 `.settings-search-toggle` 展开，结果复用 nav，`input` 字号 12px | `settings.css:541-566` |
| 设置页可用 `renderToStaticMarkup` + `installBrowserTestGlobals` 行为渲染 | `screens/settings/agentsSettingsRender.test.tsx` |
| 通知分区在不支持 Web Push 时只渲染 声音/通知中心/webhook 指针 三组 | `SettingsRoutes.tsx:1950-1972` |
| ⌘K 只有 `action:settings` → `navigate('/settings')` | `screens/command/CommandPalette.tsx:413-420` |
| ⌘K 分组顺序 `PALETTE_GROUP_ORDER`，过滤 `filterPaletteItems`（`#tag` 语法） | `screens/command/paletteModel.ts:19-26,149-165` |
| 侧栏只有 `completed` 分组 `collapsible: true`，状态 `completedOpen` 仅内存 | `screens/sessions/Sidebar.tsx:426,796-860,1046-1060` |
| 工作区/标签分组 `collapsible:false`；分组 id `workspace:<key>` / `tag:<tag>` / `untagged` | `Sidebar.tsx:830-857` |
| ⌘1–9 与上移/下移读 `displayRows`（必须等于渲染序），已完成折叠时不占号 | `Sidebar.tsx:453-466,486-494,720-737` |
| 侧栏滚动容器 `.sb-list`（`listRef`），行包裹 `[data-dragkey]` | `Sidebar.tsx:301,1033,1101-1106`；`sidebar.css:98-105` |
| 行状态位语义 `agentStatusSignal(execution, unread)`：running/background/input/unread/… | `src/sync/agentStatus.ts:54-58`；`Sidebar.tsx:1603-1607` |
| design-language：右侧标签激活「不能使用会滚动祖先的 scrollIntoView」；菜单/高亮中性 `--bg-3`；不隐藏关键状态 | `docs/design-language.md` 第 187、247、159 行 |
| 动效 token 在减少动态效果时归零 | `src/styles/tokens.css:248-266` |

## 设计

### 设置索引（`screens/settings/settingsIndex.ts`，纯模块）

```ts
interface SettingsIndexEntry {
  id: string;                 // 稳定锚点，如 'notifications.quietHours'
  section: string;            // settingsSections 的 path
  title: SimpleTranslationKey | { en: string; zh: string };
  description?: SimpleTranslationKey | { en: string; zh: string };
  keywords: string[];         // 中英别名，小写
  requires?: 'webPush';       // 仅在浏览器支持 Web Push 时渲染的分组
}
```

- 文案只存翻译 key：页面与索引读同一个 key，改文案不会漂移；`{en, zh}` 字面量仅用于页面本身就是内联双语的项（团队入口）。
- 搜索 `searchSettings(entries, query, {lang, webPush})`：查询小写去空白；对 当前语言标题、英文标题、中文标题、描述（中英）、
  分类名（中英）、关键词逐项打分（参考 Orca：标题 exact/prefix/substring 700/650/600，描述 500/450/400，关键词 300/250/200，
  分类名 150）；多词查询要求每个词都命中（AND），总分取各词最高分之和；同分保持索引顺序。
- `settingHref(entry, basePath)` = `${basePath}/${section}?setting=${id}`（overview 分类 path 为空时省略段）。

### 锚点

- `Item`/`ItemGroup` 增加可选 `settingId`，渲染为 `data-setting-id`；不传时 DOM 不变。
- `SettingsRoutes.tsx` / `VoiceSettings.tsx` / `MachinesSettings.tsx` 只在已有 JSX 上追加 `settingId="…"`（单选型设置锚在组上，开关型锚在行上）。
  通知分区（r3-push 归属）只在 `ItemGroup` 上加，减少冲突面。

### 跳转与高亮（`screens/settings/settingsReveal.ts`）

- `SettingsWorkspace` 监听 `location.key`：有 `?setting=` 时在 `.settings-content` 内以 rAF 轮询（≤2s）找 `[data-setting-id]`，
  找到后：`revealTop()` 纯函数算出容器 `scrollTop`（目标顶部减 16px 余量），`container.scrollTo`（减少动态效果时 `behavior:'auto'`）；
  加 `is-setting-target` 类 1600ms；`tabindex=-1` + `focus({preventScroll:true})` 供键盘/读屏接续。
- CSS：`.is-setting-target` 用 `--bg-3`，退出过渡用 `--motion-slow`（减少动态效果下 token 为 0ms → 无淡出）。

### ⌘K

- `PaletteGroup` 加 `'settings'`，顺序 needsYou → actions → sessions → terminals → **settings** → create。
- 查询有自由文本且无 `#tag` 时，`searchSettings(...).slice(0, 6)` 生成行，标题=设置项、副标题=分类，run = `navigate(settingHref)`。

### 侧栏折叠（`screens/sessions/sidebarCollapsedGroups.ts`，纯模块 + 小 store）

- 存储：`Record<groupId, boolean>`（只存用户显式选择），默认 `defaultCollapsed(id)`（仅 `completed` 为 true）；
  上限 200 条，超出丢最早；`localStorage` 读写全部 try/catch。`useSyncExternalStore` 订阅，多个侧栏实例一致。
- `summarizeGroup(rows, statusOf)` → `{input, running, unread}`；`statusOf` 复用 `agentStatusSignal` 与行渲染同一输入。
- `findRevealTarget(sections, isCurrent)` → `{sectionId, key}`；`revealScrollTop({…})` nearest 语义纯函数。
- Sidebar：`SidebarSection` 增 `allRows`；折叠组 `rows=[]`；`orderedRows`（状态视图）与 `plainDisplayRows`（工作区/标签）同样剔除折叠组，
  保证 `displayRows` = 渲染序。组头改为 `button.sb-section-toggle`（工作区的「在此目录新建」按钮保持兄弟节点，不嵌套按钮）。
- 定位：路由（pathname+search）变化时置 `pendingReveal`；渲染后若能找到当前行 → 展开其组（写偏好）→ 下一帧算 `scrollTop` 写 `.sb-list`；
  找到即清除。菜单「定位当前会话」同样置位，必要时先切回列表视图。

## 兼容矩阵与发布顺序

纯 Web 改动：无 wire / server / CLI / Prisma 变更，不读新协议字段。

| 组合 | 行为 |
|---|---|
| 新 Web × 旧/新 server × 旧/新 CLI | 正常；设置索引与侧栏折叠全在前端，数据来源不变 |
| 旧 Web（回滚） | `?setting=` 参数被忽略，落到分类页顶部；`localStorage` 里的折叠键无人读取，无副作用 |
| 旧 Web 与新 Web 在不同设备 | 折叠是设备本地偏好，互不影响；不写 synced settings（不触碰铁律 1） |

发布：随常规 server/Web 镜像发布即可，无顺序要求；回滚点 = 上一个 Web release。

## 风险

1. **SettingsRoutes 冲突**：r3-push 同时改通知分区。缓解：只追加单个属性、通知分区只锚 `ItemGroup`，冲突由主 agent 合并时按「保留对方结构 + 补回 settingId」解决；一致性测试会指出漏锚。
2. **条件渲染的锚点**：Web Push 不可用时浏览器通知/类型/免打扰三组不渲染。缓解：索引项标 `requires:'webPush'`，不支持时不出现在搜索结果；测试在两种分支下都渲染校验。
3. **折叠 + ⌘1–9 错位**：缓解：所有剔除逻辑集中在 `displayRows` 上游，测试覆盖「折叠组不占编号」的纯函数。
4. **自动展开与用户意图冲突**：只在路由变化时触发一次；接受「直链进入时会展开用户折叠的组」——这是需求本身。
5. **localStorage 不可用**（隐私模式/配额）：try/catch，退化为本次会话内存状态。

## 验收标准

- [ ] 设置页输入「提示音」「sound」「免打扰」「quiet」「换行」「wrap」都能列出对应项，显示「分类 › 设置项」，点击后跳转、滚动、`--bg-3` 高亮约 1.6s。
- [ ] 减少动态效果：无平滑滚动、高亮无过渡。
- [ ] 390px coarse：搜索展开、结果可点、输入 16px、无横向滚动。
- [ ] ⌘K 输入「quiet」出现「设置」组，Enter 直达并高亮。
- [ ] 一致性测试：所有索引 id 唯一、翻译 key 中英存在、每个分类页渲染出全部锚点（含 Web Push 支持分支）。
- [ ] 侧栏工作区/标签/状态分组可折叠、刷新后保持；折叠头显示数量与等待/运行/未读汇总。
- [ ] 折叠组不占 ⌘1–9；从 ⌘K 打开折叠组里的会话 → 组展开、行在 `.sb-list` 内可见，页面/祖先不滚动。
- [ ] 分组菜单「定位当前会话」可用；组头 Tab 可达、Enter/Space 切换、`aria-expanded` 正确。
- [ ] 1280 / 390 × 亮 / 暗 真浏览器验收，css-probe 取证。
- [ ] web tsc / 相关 vitest / vite build 通过。

## 留真机验证项

- 触屏真机上组头 44px 命中与长列表滚动定位的手感（浏览器 coarse 模拟已验布局）。
