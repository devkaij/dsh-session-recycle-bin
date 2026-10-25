# dsh-session-recycle-bin

> DSH 会话回收站：真正删除会话与定时任务——删除即入回收站、可恢复回原工作区、确认后才彻底清除。
> A recycle bin for DeepSeek Harness sessions and scheduled tasks — delete for real, restore to the original workspace, wipe only after an explicit confirmation.

[DeepSeek Harness（DSH）](https://harness.deepseek.com) 的会话回收站插件，**命令 + GUI 全套双入口**：

- **GUI（桌面端）**
  - **删除**：侧边栏会话行的悬停按钮区（归档旁）和「...」菜单里多一个**删除（进回收站）**，点击弹确认框后移入回收站
  - **回收站面板**：侧边栏底部出现**回收站座位按钮**（带条目数徽标），点击弹出列表——每行可**恢复**或**彻底清除**，头部可**清空回收站**
  - **定时任务页签**（v1.4.0）：面板内切换到「定时任务」可列出宿主自动化任务并**行内删除**——删除 = 移入回收站（**可恢复**，与原生硬删除不同）
  - **弹层挂载点**（v1.4.1）：面板经 `react-dom` 的 `createPortal` 挂到 `document.body`，不再留在侧边栏列里。侧边栏 `position:relative + z-index:0` 自成层叠上下文，面板留在其中时整块侧边栏都画在**会话正文列下面**——面板右侧那半（恢复/彻底清除按钮所在处）会被正文层截走点击：**按钮看得见、点不动，界面毫无异常**（2026-10-22 实测命中栈顶为 `wSkVaW_scrollBody/_body/_root`）。portal 之后 `z-index: 900` 才在根层叠上下文生效（高于应用 chrome、低于第一方模态 1000 与其它插件浮窗）。拿不到 `react-dom` 时降级为就地渲染。
- **命令**：`/recycle` 斜杠命令安全删除会话与定时任务 —— 先移入回收站，随时恢复，确认后才彻底清除

DSH 自带"归档"只是把会话从侧边栏藏起来，**不释放磁盘**；本插件做真正的删除：

- **删除** = 把会话从 `$DSH_HOME` 移进回收站（优先同盘瞬时 `rename`，跨盘自动回退复制+删除）
  - 会话日志目录 `~/.dsh/sessions/--<工作区>--/<会话id>/`
  - 会话投影缓存 `~/.dsh/storages/session_projcache/sessions/<会话id>.json`
- **恢复** = 原样放回（含投影缓存）并**挂回原工作区**：按会话 cwd 解析/新建工作区记录后重建成员关系，侧边栏立即在原来的分组里出现，可继续对话（v1.3.5 修复：此前还原后落「未分组」桶，要等 DSH 重启才按路径归组）
- **彻底清除** = 从回收站永久删除（需要显式二次确认）
- **定时任务**（v1.4.0）：宿主启用自动化任务时（`@deepseek-ai/dsh-schedule`），删除定时任务也走回收站——先把整行任务（记录 + 会话绑定 + 状态 + 最近投递）存档进回收站条目，再调宿主 `schedule.delete()`；原生页面监听任务变更事件即时摘行。**恢复**按存档记录映射回创建请求重建（宿主生成新 id，恢复结果返回新 id）；「延迟」类一次性任务已过期时按原延迟时长重新武装，「定时」类一次性任务已过期时如实拒绝。schedule 服务未启用时相关功能如实降级，不影响会话回收站
- **保留期自动清理**：回收站条目默认 30 天后启动时自动彻底清除（可配置，0 = 关闭）
- **安全护栏**：使用中的会话会先从内存释放再移动文件；删「当前正在看的会话」时**先把主视图切到别的会话再删**，拿不到导航服务就取消删除（绝不整页刷新——刷新会重跑 web boot，桌面壳把「客户端条目激活失败」判为致命错误）；所有路径限制在回收站根内

## GUI（桌面端）

安装后重启 DSH：

- **删除**：会话行悬停时在**归档按钮和置顶按钮之间**出现垃圾桶按钮；「...」菜单里在归档下方多一项「删除会话（进回收站）」
- **回收站面板**：侧边栏底部出现回收站按钮（与插件面板同款座位），条目数 >0 时显示**徽标**
  - 点击弹出锚定面板：条目列表（新→旧：标题、扔进时间、工作区、id 前缀）+ 每行**恢复 / 彻底清除** + 头部**清空**
  - 恢复直接执行；彻底清除与清空需要确认框二次确认（与 `wipe confirm` 同级强度）
  - 恢复 = 放回原位 + **挂回原工作区**（按会话 cwd 解析/新建工作区记录后重建成员关系，侧边栏立即在原分组出现）；挂不回（如原目录已不存在）时提示"暂留未分组，重启后按路径归组"，文件还原不受影响
  - 恢复失败（如原位置已存在同名会话）在面板内以错误行提示
  - 徽标计数在启动、打开面板、每次操作后刷新；其他窗口的改动要等下次刷新才可见

- 删除入口点击后弹确认框，确认即把该会话移入回收站，侧边栏即时消失
- **使用中的会话也能删**：删除先透过会话存储自身的 detach 机制把会话从内存释放（与属主卸载同一机制，正常派发 `session/disposed`），再移动文件；运行中的工作会先被归档闸门拦停
- 删除当前正在对话的会话：**先切走，再删**。确认框会多一条警示；确认后本窗口用公开的 `uiWorkspace` 服务切到另一个会话（同工作区优先；列表里没有别的会话就走官方「新建会话」流程新建一个并导航过去），然后才把它移入回收站——列表摘行时本窗口已经不在那个会话上。
  - **不再刷新窗口**（v1.3.3 起）：整页刷新会重跑 web boot，而桌面壳把「有客户端条目激活失败」判为致命错误（写 `crash-*-web-boot.log` 并进 recovery 屏）——别的插件一个条目抖一下，一次「删当前会话」就变成整个应用崩（2026-10-17 02:59 实测过一次）。
  - 拿不到 `uiWorkspace`、或切换在 3 秒内没生效时：**取消删除**并在确认框里提示「请先手动切到其它会话」——宁可不删，也不刷新、不把窗口留在已删除的会话上。
  - CLI 的 `/recycle del` 仍拒绝删除命令所在的会话本身。
- 通道：浏览器 fetch → 宿主 `webServer` 路由（`connection` 鉴权围栏与产品路由一致），不依赖“当前会话”，也不写任何命令日志

## 命令用法

在 DSH 对话输入框里输入：

```text
/recycle                        概览：会话列表（●=使用中）+ 定时任务列表 + 回收站列表 + 用法
/recycle list                   同上
/recycle del 2                  把列表里的 2 号会话移入回收站
/recycle del 5c1b               按 id 前缀删（uuid 片段，≥4 位，须唯一）
/recycle restore a              恢复回收站条目 a（编号 a、b、c… 按时间新→旧；定时任务条目也可恢复）
/recycle restore 5c1b           按 id 前缀恢复
/recycle wipe a                 预览将要彻底删除的内容（不执行）
/recycle wipe a confirm         彻底删除条目 a（不可恢复）
/recycle wipe all confirm       清空回收站
/recycle sched list             列出定时任务（按下次运行排序）
/recycle sched del 2            把 2 号定时任务移入回收站（可恢复）
/recycle sched del 1a2b         按 id 前缀删（schedule- 后的 uuid 片段）
/recycle sched restore a        从回收站恢复定时任务（重建后任务 id 会变）
/recycle sched wipe all confirm 彻底删除回收站里的全部定时任务条目
```

编号规则：会话/定时任务用数字（每次列表即时计算），回收站用字母；纯数字/字母 token 超出编号范围且长度 ≥4 时，自动回退为 id 前缀匹配。

## 安装

前提：本机装有 pnpm（与 DSH 插件管理器一致）。

```powershell
git clone https://github.com/devkaij/dsh-session-recycle-bin.git D:\plugins\dsh-session-recycle-bin
pnpm --dir "<profile 目录>" add "D:\plugins\dsh-session-recycle-bin"
# 然后重启 DSH
```

- 本包是**标准 bundle**：`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`（向 profile 插入插件行，全部走插件内默认值），装进 profile 后**无需手改任何 patch 文件**。
- **profile 目录跟随 `DSH_HOME`**，**profile 名取决于 DSH 怎么启动**：设置了 `DSH_HOME` 时在 `$DSH_HOME\profiles\<profile 名>`，未设置才是 `~/.dsh\profiles\<profile 名>`；桌面端实测用 `tauri`（`--profile tauri`），CLI 与插件管理器默认 `desktop`。装错 profile（DSH 根本不读）是"插件不加载"的常见原因——看启动参数用的是哪个 profile、会话/回收站数据落在哪个 home，就能判断哪个在用。
- 装完后确认 profile `package.json` 的 `dsh.profile.bundles` 里有 `"dsh-session-recycle-bin"`：在列表里才能出现在插件管理器的"已安装"分组、可从 UI 启停。经插件管理器安装会自动登记；直接 pnpm 安装时需自己补这一行。
- 想覆盖默认配置时，在 profile 的 `cordis.patch.yml` 里用**按 id 覆盖**条目（bundle 层已经插入过插件行，profile 层不要再写 `- insert:`）：

```yaml
- id: session-recycle-bin
  name: dsh-session-recycle-bin
  config:
    retentionDays: 30        # 0 = 永不自动清理
    # trashRoot: D:\somewhere\trash     # 可省略；默认 <DSH_HOME>/trash
    # sessionsRoot: ...                 # 可省略；默认 <DSH_HOME>/sessions
    # projcacheRoot: ...                # 可省略；默认 <DSH_HOME>/storages/session_projcache
```

`$DSH_HOME` 解析顺序与官方一致：`$DSH_HOME` 环境变量 → `~/.dsh`。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `retentionDays` | `30` | 回收站保留天数，超期条目在插件启动时被彻底清除；`0` 关闭自动清理 |
| `sessionsRoot` | `<DSH_HOME>/sessions` | 会话日志根目录（与 `dsh-session-persistence-jsonl` 的 `root` 一致） |
| `projcacheRoot` | `<DSH_HOME>/storages/session_projcache` | 会话投影缓存根目录 |
| `trashRoot` | `<DSH_HOME>/trash` | 回收站根目录 |

所有路径必须是绝对路径，加载期校验，非法配置会让插件显式加载失败（不会静默错删）。

## 工作原理

- **Host 半侧**（`lib/index.js`）：cordis 插件，注册全局 `/recycle` 命令 + 6 条 `webServer` JSON POST 路由（`connection` 鉴权围栏）：`delete`（移入回收站）、`trash`（列表，GUI 数据源）、`restore`（恢复，按条目类型分派）、`wipe`（彻底清除，不带 `confirm` 只回预览）、`schedules`（定时任务列表）与 `schedule-delete`（定时任务移入回收站）；启动时按保留天数清理过期条目
- **schedule 服务接入**（v1.4.0）：宿主 `@deepseek-ai/dsh-schedule` 经 `ctx.schedule` 现取（**刻意不进 inject**——硬注入会让整个插件在自动化任务关闭的 profile 上加载失败），按形状探测（catalog/delete/create 缺一即视为不可用）如实降级。删除 = `catalog()` 找到任务 → 整行写进 `<trashRoot>/<时间戳>-sched-<uuid>/meta.json` → `schedule.delete({ sessionId, id })`（sessionId 必须带任务自己的，错配会被服务拒绝）→ 服务拒绝时回滚存档。服务内部会广播任务变更事件，原生自动化任务页即时摘行
- **浏览器半侧**（`lib/client.js`）：`dsh.client`（platform web）客户端模块，注册进四个 slot——`sidebar.workspaces.session.menu.item`（行菜单）、`sidebar.workspaces.session.row.action`（悬停按钮）、`shell.overlay`（确认框）与 `sidebar.footer.action`（回收站座位 + 锚定面板，布局照抄第一方 CordisPanel 的座位/弹层做法，样式只引用 `--dsw-alias-*` 主题 token）；bundle 为 `window.__ModuleLoader__.load({ id, factory })` 工厂形态，只 require 平台 seed（react / ui-primitives / client-store），无需构建链
- **删「当前会话」的导航策略**（v1.3.3）：导航服务按需取（`ctx.get('uiWorkspace')` / `ctx.get('workspaces')`，缺了只降级这一步——客户端条目激活失败在桌面壳里是致命错误，不能让插件失活）；切走目标按「同工作区 → 列表最靠前」挑，挑不到就走官方 `startSession()` 新建；再用列表快照的 `retainedBy.mainView` 轮询确认真离开了，才发删除请求。全程不碰 `window.location.reload()`
- **删除管线**（借鉴社区插件 @szhl/dsh-session-delete 的成熟做法）：
  1. 归档闸门（持久归档集 = 第一方准入闸门，必要时 `stopActivity`）
  2. 透过 `ctx.sessions.store` 的每条目 detach 能力把 live 会话从内存摘除（与属主 fiber 卸载同一机制，正常派发 `session/disposed`；派发进行中则延迟）
  3. 移动日志目录与投影缓存进回收站条目（本插件的差异点：**移动**而非 rm）
  4. 多轮清扫 disposal 边重建出来的文件（持久化 writer.close / 投影缓存 checkpoint）
  5. 清记账：unarchive（撤闸门标记）、unpin、对每个 Workspace 实体 `detachSession`
  6. 确认原路径已清空（残存物如实报告），并对每个确认删除的 id 广播 `api-session/removed`——非活动会话没有 `session/disposed` 可借，必须显式通知，所有窗口的侧边栏才会即时摘行
- 子代理后代按 `parentSession` 谱系连带删除；列表元数据读自会话投影缓存 JSON，缺失时回退目录 mtime
- 回收站条目是自包含目录：

```text
<trashRoot>/<毫秒时间戳>-<会话id>/          （会话条目）
  session/         原会话日志目录（原样）
  projcache.json   原投影缓存（若有）
  meta.json        { id, trashedAt, original: { sessionDir, projcacheFile }, title, cwd }

<trashRoot>/<毫秒时间戳>-sched-<uuid>/      （定时任务条目，v1.4.0）
  meta.json        { version, type: 'schedule', id, trashedAt, sessionId, status,
                    record: {原任务记录}, lastDelivery, title }
```

- 恢复按 `meta.json.original` 回到原位；原位置已有同名目录时拒绝（防覆盖）。定时任务条目按 `meta.record` 映射回创建请求重建。

## 已知边界

- 在别的窗口删除本窗口正开着的会话：本窗口侧边栏行会即时消失（api-session/removed 推送），但主视图仍绑在那个会话上——官方客户端对「当前会话被移除」没有处理分支（resident 实例只打 `removed` 标记、`retainedBy.mainView` 不扣减），要手动切到别的会话才离开；本插件的「先切走再删」只作用于**自己发起的删除**（发起窗口）。
- 子代理后代按谱系连带删除；恢复只针对单条（后代需单独恢复）。
- 附件存储（图片等 content-addressed 字节）与会话日志分离，删除会话不回收附件空间。
- 恢复的会话立即回到侧边栏（广播回列表）；工作区归组索引要等重启 DSH 重建，期间可能显示在 Ungrouped。
- 回收站徽标/面板数据在启动、打开面板、操作后刷新；另一窗口的删除不会实时推送过来。
- 回收站面板不显示条目体积（可随时用 `/recycle wipe <编号>` 预览体积）。
- **定时任务**（v1.4.0）：恢复重建后任务 **id 会变**（宿主重新生成）；一次性任务已过目标时间时无法按原时刻恢复（「延迟」类按原延迟时长重新武装，「定时」类如实拒绝）；恢复挂回的是**原会话 id**——原会话已被删除时任务照常恢复，投递语义归宿主（可先从会话回收站恢复会话）；已入队未投递的消息不随删除撤回（与原生删除一致）。

## 卸载

```powershell
pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" remove dsh-session-recycle-bin
# 再从 cordis.patch.yml 删掉 session-recycle-bin 那一段，重启 DSH
```

回收站数据（`~/.dsh/trash`）不会被卸载删除，可手动清空。

## 开发

```powershell
node test/harness.mjs         # Host 半侧离线行为测试（不需要 DSH 运行）
node test/client-harness.mjs  # 浏览器半侧离线行为测试（stub 平台 seed）
```

版本兼容：`peerDependencies` 声明 `@deepseek-ai/dsh: ^0.2.0-rc.2`（0.2.1-rc.2 起兼容门用 semver satisfies 校验，精确钉死 `0.2.0-rc.2` 会被静默跳载；caret 范围在 0.2.0-rc.2 与 0.2.1-rc.2 运行时均合规）。宿主演面（commands/sessions/sessionPersistence/workspaceRegistry/webServer/connection）经 0.2.0→0.2.1 diff 核对为一致或纯增量子段。

版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE) © 2026 devkaij

仓库：<https://github.com/devkaij/dsh-session-recycle-bin> · 问题与建议请开 issue。
