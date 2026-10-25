/**
 * dsh-session-recycle-bin —— DSH 会话回收站插件
 *
 * 在 DSH（DeepSeek Harness）Host 进程内运行，注册全局斜杠命令 `/recycle`：
 *
 *   /recycle                       概览：可删除会话 + 回收站内容 + 用法
 *   /recycle list                  同上
 *   /recycle del <编号|id前缀>      把会话移入回收站（拒绝仍在使用的会话）
 *   /recycle restore <编号|id前缀>  从回收站恢复
 *   /recycle wipe <编号|id前缀|all> [confirm]
 *                                  彻底删除（不带 confirm 时只预览）
 *
 * 浏览器半侧（lib/client.js）经 webServer 路由访问（全部 JSON POST，
 * connection 鉴权围栏与产品路由一致），供 GUI 使用：
 *   POST <挂载点>/dsh-session-recycle-bin.delete          把会话移入回收站
 *   POST <挂载点>/dsh-session-recycle-bin.trash           回收站列表（GUI 面板与徽标数据源）
 *   POST <挂载点>/dsh-session-recycle-bin.restore         把条目恢复到原位
 *   POST <挂载点>/dsh-session-recycle-bin.wipe            彻底删除单条/清空（confirm 闸门与命令一致）
 *   POST <挂载点>/dsh-session-recycle-bin.schedules       定时任务列表（v1.4.0）
 *   POST <挂载点>/dsh-session-recycle-bin.schedule-delete 把定时任务移入回收站（v1.4.0）
 *
 * 定时任务（v1.4.0）：宿主启用自动化任务时（@deepseek-ai/dsh-schedule，
 * 服务名 `schedule`，经 ctx.schedule 可达），本插件把「删除定时任务」
 * 也纳入回收站语义——原生删除是硬删除（任务行连同运行记录一起消失，
 * 不可恢复），这里改为：先把整行任务（record + 会话绑定 + 状态）存档
 * 进回收站条目，再调 ctx.schedule.delete()；恢复时按原 record 映射回
 * create 请求重建（宿主会生成新 id，恢复结果返回新 id）。
 * schedule 服务不可用时相关路由/子命令如实降级报告，不影响会话回收站。
 *
 * “删除”是移动而非改写（优先 rename，跨盘回退复制+删除）：
 *   会话日志目录   <sessionsRoot>/--<workspace>--/<id>/
 *   投影缓存文件   <projcacheRoot>/sessions/<id>.json
 * 移入：
 *   <trashRoot>/<时间戳>-<id>/
 *     session/         原会话日志目录
 *     projcache.json   原投影缓存（若有）
 *     meta.json        { id, trashedAt, original: {...}, title, cwd }
 * 定时任务条目（v1.4.0）：
 *   <trashRoot>/<时间戳>-sched-<uuid>/
 *     meta.json        { version, type: 'schedule', id, trashedAt, sessionId,
 *                      status, record: {原任务记录}, lastDelivery, title }
 * 删除确认后向所有客户端广播 `api-session/removed`，侧边栏行即时消失
 * （非活动会话没有 session/disposed 可借，必须显式广播）。
 *
 * 回收站根默认 `~/.dsh/trash`，保留天数默认 30（0 = 永不自动清理）。
 *
 * 配置（cordis.patch.yml 条目的 config，均可选，路径必须绝对）：
 *   sessionsRoot    会话日志根目录          默认 <DSH_HOME>/sessions
 *   projcacheRoot   会话投影缓存根目录      默认 <DSH_HOME>/storages/session_projcache
 *   trashRoot       回收站根目录            默认 <DSH_HOME>/trash
 *   retentionDays   回收站保留天数          默认 30，0 表示永不自动清理
 *
 * DSH_HOME 解析顺序与 @deepseek-ai/dsh-home-paths 一致：$DSH_HOME → ~/.dsh。
 * 本插件刻意只依赖 node 内置模块：服务（commands/sessions）经 cordis 注入。
 * workspaceRegistry 负责三件账：删除时归档闸门 + 从工作区成员账本 detach、
 * 还原时无条件取消归档 + 按 cwd 挂回原工作区（侧边栏分组纯看成员关系，
 * 不挂回就落「未分组」桶，宿主重启才按路径自动归组）。
 *
 * @module dsh-session-recycle-bin
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** cordis 插件名（日志命名空间）。 */
export const name = 'session-recycle-bin';
/** 硬依赖服务：命令注册表与会话存储。 */
export const inject = ['commands', 'sessions', 'workspaceRegistry', 'webServer', 'connection', 'sessionPersistence'];

//#region 常量

/** 会话目录名/回收站 id 的合法字符（与 encodeSegment 输出一致的超集）。 */
const ID_SAFE = /^[A-Za-z0-9_-]+$/u;
/** 回收站条目目录名：<毫秒时间戳>-<会话id> 或 <毫秒时间戳>-sched-<uuid>（v1.4.0 定时任务）。 */
const ENTRY_NAME_RE = /^(\d{13,})-(session-[A-Za-z0-9_-]+|sched-[A-Za-z0-9_-]+)$/u;
/** 定时任务 id 的合法形状（schedule-<uuid>）。 */
const SCHED_ID_RE = /^schedule-[A-Za-z0-9_-]+$/u;
/** 计算目录体积时的文件数上限，超过后只提示“≥”。 */
const SIZE_WALK_FILE_CAP = 4000;
/** 一天毫秒数。 */
const DAY_MS = 86400000;
/** id 前缀匹配所需的最短长度，防止过短前缀命中过多候选。 */
const MIN_PREFIX_LEN = 4;
/** 浏览器半侧调用的路由（相对路径，适配任意挂载点），全部 JSON POST。 */
const ROUTE_DELETE = '/dsh-session-recycle-bin.delete';
const ROUTE_TRASH = '/dsh-session-recycle-bin.trash';
const ROUTE_RESTORE = '/dsh-session-recycle-bin.restore';
const ROUTE_WIPE = '/dsh-session-recycle-bin.wipe';
const ROUTE_SCHEDULES = '/dsh-session-recycle-bin.schedules';
const ROUTE_SCHEDULE_DELETE = '/dsh-session-recycle-bin.schedule-delete';

/** 任意抛出值的可读消息（对不信任的字符串化保持防御）。 */
function messageOf(error) {
  if (error instanceof Error && error.message.length > 0) return error.message;
  try {
    return String(error);
  } catch {
    return '<unrenderable thrown value>';
  }
}

const HELP_TEXT = [
  '用法：',
  '  /recycle                        查看会话、定时任务与回收站列表',
  '  /recycle del <编号|id前缀>       把会话移入回收站（使用中的会话也会先从内存释放）',
  '  /recycle restore <编号|id前缀>   从回收站恢复会话',
  '  /recycle wipe <编号|id前缀|all> [confirm]',
  '                                  彻底删除（加 confirm 才执行）',
  '  /recycle sched list             列出定时任务',
  '  /recycle sched del <编号|id前缀> 把定时任务移入回收站（可恢复）',
  '  /recycle sched restore <编号|id前缀>',
  '                                  从回收站恢复定时任务（重建后 id 会变）',
  '  /recycle sched wipe <编号|id前缀|all> [confirm]',
  '                                  彻底删除回收站里的定时任务条目',
  '说明：编号按每次列表即时计算；● = 本进程内在使用中（删除时会先释放）；',
  '      id 前缀取 “session-” 后的 UUID 片段（至少 4 位，须唯一）；',
  '      定时任务需要宿主启用自动化任务（schedule 服务）。',
].join('\n');

//#endregion
//#region 配置

/** 解析 DSH 主目录（与 @deepseek-ai/dsh-home-paths 的优先级一致）。 */
function resolveDshHome() {
  const explicit = process.env.DSH_HOME;
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim();
  return join(homedir(), '.dsh');
}

/** 校验并补全插件配置；任何非法配置都直接抛错，让加载期显式失败。 */
function normalizeConfig(raw) {
  const c = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const home = resolveDshHome();
  const absPath = (value, fallback, label) => {
    if (value === undefined || value === null || String(value).trim().length === 0) return fallback;
    const rawPath = String(value).trim();
    if (!isAbsolute(rawPath)) throw new Error(`session-recycle-bin: config.${label} 必须是绝对路径，收到 "${rawPath}"`);
    return resolve(rawPath);
  };
  const retentionRaw = c.retentionDays ?? 30;
  const retention = typeof retentionRaw === 'number' ? retentionRaw : Number.parseInt(String(retentionRaw), 10);
  if (!Number.isFinite(retention) || retention < 0) {
    throw new Error(`session-recycle-bin: config.retentionDays 必须是不小于 0 的数字，收到 ${String(retentionRaw)}`);
  }
  return {
    sessionsRoot: absPath(c.sessionsRoot, join(home, 'sessions'), 'sessionsRoot'),
    projcacheRoot: absPath(c.projcacheRoot, join(home, 'storages', 'session_projcache'), 'projcacheRoot'),
    trashRoot: absPath(c.trashRoot, join(home, 'trash'), 'trashRoot'),
    retentionDays: retention,
  };
}

//#endregion
//#region 磁盘模型（读）

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** workspace 会话目录名：--<可读路径>-- 或 _no-cwd。 */
function isProjectSlugDir(name) {
  return name === '_no-cwd' || (name.startsWith('--') && name.endsWith('--'));
}

/** 读取会话投影缓存（title/cwd/createdAt），缓存缺失时字段为 undefined。 */
async function readProjMeta(projcacheRoot, id) {
  const file = join(projcacheRoot, 'sessions', `${id}.json`);
  const doc = await readJson(file);
  if (doc === undefined || doc === null || typeof doc !== 'object') {
    return { file, exists: false, createdAt: undefined, cwd: undefined, title: undefined };
  }
  const record = doc.record ?? {};
  const identity = record.identity ?? {};
  const rows = record.rows ?? {};
  const titleVal = rows.title?.val;
  return {
    file,
    exists: true,
    createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : undefined,
    cwd: typeof identity.cwd === 'string' ? identity.cwd : undefined,
    title: typeof titleVal === 'string' && titleVal.trim().length > 0 ? titleVal.trim() : undefined,
  };
}

/** 枚举磁盘上的全部会话目录（含活动会话，过滤由调用方负责），新→旧排序。 */
async function listAllSessions(cfg) {
  const out = [];
  let projects;
  try {
    projects = await readdir(cfg.sessionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory() || !isProjectSlugDir(project.name)) continue;
    const projectDir = join(cfg.sessionsRoot, project.name);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('session-') || !ID_SAFE.test(entry.name)) continue;
      const dir = join(projectDir, entry.name);
      let info;
      try {
        info = await stat(dir);
      } catch {
        continue;
      }
      const meta = await readProjMeta(cfg.projcacheRoot, entry.name);
      out.push({
        id: entry.name,
        dir,
        projectDirName: project.name,
        createdAt: meta.createdAt ?? info.birthtimeMs ?? info.mtimeMs,
        cwd: meta.cwd,
        title: meta.title,
        hasProjcache: meta.exists,
        projFile: meta.file,
      });
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** 统计目录体积；文件数超过上限后停止累计并标记 truncated。 */
async function dirSizeCapped(dir) {
  let total = 0;
  let files = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      files += 1;
      if (files > SIZE_WALK_FILE_CAP) {
        truncated = true;
        continue;
      }
      try {
        total += (await stat(path)).size;
      } catch {
        /* 文件在统计瞬间消失是良性的 */
      }
    }
  }
  return { total, truncated };
}

/** 列出回收站条目（解析 meta.json，坏条目降级为仅目录名信息），新→旧排序。 */
async function listTrashEntries(cfg) {
  let dirents;
  try {
    dirents = await readdir(cfg.trashRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const matched = ENTRY_NAME_RE.exec(dirent.name);
    if (matched === null) continue;
    const entryDir = join(cfg.trashRoot, dirent.name);
    const meta = await readJson(join(entryDir, 'meta.json'));
    // 条目类型：meta.type 权威；目录名的 sched- 段兜底（meta 损坏时仍可识别）
    const type = meta?.type === 'schedule' || dirent.name.includes('-sched-') ? 'schedule' : 'session';
    const id = typeof meta?.id === 'string' && ID_SAFE.test(meta.id) ? meta.id : matched[2];
    let trashedAt = Number(meta?.trashedAt);
    if (!Number.isFinite(trashedAt) || trashedAt <= 0) {
      try {
        trashedAt = (await stat(entryDir)).mtimeMs;
      } catch {
        continue;
      }
    }
    const original = (meta?.original !== null && typeof meta?.original === 'object') ? meta.original : undefined;
    const record = (type === 'schedule' && meta?.record !== null && typeof meta?.record === 'object') ? meta.record : undefined;
    out.push({
      entryName: dirent.name,
      entryDir,
      type,
      id,
      trashedAt,
      title: typeof meta?.title === 'string' && meta.title.length > 0 ? meta.title : undefined,
      cwd: typeof meta?.cwd === 'string' && meta.cwd.length > 0 ? meta.cwd : undefined,
      // 会话条目专用
      sessionDirInEntry: join(entryDir, 'session'),
      projcacheFileInEntry: join(entryDir, 'projcache.json'),
      originalSessionDir: typeof original?.sessionDir === 'string' ? original.sessionDir : undefined,
      originalProjcacheFile: typeof original?.projcacheFile === 'string' ? original.projcacheFile : undefined,
      // 定时任务条目专用（v1.4.0）
      sessionId: typeof meta?.sessionId === 'string' && meta.sessionId.length > 0 ? meta.sessionId : undefined,
      taskStatus: typeof meta?.status === 'string' ? meta.status : undefined,
      taskRecord: record,
      lastDelivery: (meta?.lastDelivery !== null && typeof meta?.lastDelivery === 'object') ? meta.lastDelivery : undefined,
    });
  }
  out.sort((a, b) => b.trashedAt - a.trashedAt);
  return out;
}

/** 拒绝一切越出回收站根的路径（防目录名注入）。 */
function assertInsideTrash(cfg, entryDir) {
  const resolved = resolve(entryDir);
  const root = resolve(cfg.trashRoot);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`回收站条目路径越界，已拒绝操作：${entryDir}`);
  }
}

//#endregion
//#region 磁盘模型（写）

/**
 * 移动文件/目录：优先同盘 rename（瞬时完成），跨盘 EXDEV 回退为
 * 复制 + 删除源（copy 目标已存在时直接失败，避免覆盖）。
 */
async function movePath(src, dest) {
  try {
    await rename(src, dest);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }
  await cp(src, dest, { recursive: true, force: false, errorOnExist: true });
  await rm(src, { recursive: true, force: true });
}

/**
 * 还原后把会话挂回原工作区：按会话 cwd 解析工作区记录并 attachSession；
 * 没有匹配记录时按路径 create（与宿主启动时的路径对齐同语义、按路径幂等）。
 * cwd 优先取还原后的投影缓存 identity.cwd（权威），回退删除时记账的 meta.cwd。
 * 删除侧曾把会话从所有工作区的持久成员账本 detach，侧边栏分组纯看成员关系，
 * 不挂回就会落进「未分组」桶且要等宿主重启才按路径自动归组。
 * @param ctx - 插件上下文（workspaceRegistry）。
 * @param cfg - 归一化配置（projcacheRoot）。
 * @param sessionId - 已还原回盘的会话 id。
 * @param cwdHint - meta.json 记账的 cwd（兜底）。
 * @returns {Promise<{attached: boolean, workspaceId?: string, reason?: string}>}
 */
async function reattachWorkspace(ctx, cfg, sessionId, cwdHint) {
  const registry = ctx.workspaceRegistry;
  if (typeof registry?.resolveByPath !== 'function') {
    return { attached: false, reason: 'workspaceRegistry.resolveByPath 不可用，跳过归组' };
  }
  let cwd = typeof cwdHint === 'string' && cwdHint.length > 0 ? cwdHint : undefined;
  if (cwd === undefined) {
    const meta = await readProjMeta(cfg.projcacheRoot, sessionId);
    cwd = meta.cwd;
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { attached: false, reason: '会话没有可用 cwd，无法归组（宿主重启时可按路径自动对齐）' };
  }
  let workspace;
  try {
    workspace = await registry.resolveByPath(cwd);
    if (workspace === undefined && typeof registry.create === 'function') {
      workspace = await registry.create(cwd);
    }
  } catch (error) {
    return { attached: false, reason: `解析/新建工作区失败：${messageOf(error)}` };
  }
  if (workspace === undefined || typeof workspace.attachSession !== 'function') {
    return { attached: false, reason: '找不到匹配工作区且无法新建，会话保持未分组' };
  }
  try {
    await workspace.attachSession(sessionId);
    return { attached: true, workspaceId: String(workspace.id ?? '') || undefined };
  } catch (error) {
    return {
      attached: false,
      workspaceId: String(workspace.id ?? '') || undefined,
      reason: `attachSession 失败：${messageOf(error)}`,
    };
  }
}

/**
 * 从回收站恢复一个条目到原位。
 * @returns {Promise<{ok: true, originalSessionDir: string, projRestored: boolean, unarchived: boolean,
 *   unarchiveNote?: string, attached: boolean, workspaceId?: string, attachNote?: string}
 *   | {ok: false, reason: 'live'|'exists'|'broken'|'meta'}>}
 */
async function restoreSession(ctx, cfg, entry) {
  assertInsideTrash(cfg, entry.entryDir);
  if (ctx.sessions?.get?.(entry.id) !== undefined) return { ok: false, reason: 'live' };
  if (entry.originalSessionDir === undefined) return { ok: false, reason: 'meta' };
  if (!(await pathExists(entry.sessionDirInEntry))) return { ok: false, reason: 'broken' };
  if (await pathExists(entry.originalSessionDir)) return { ok: false, reason: 'exists' };
  await mkdir(dirname(entry.originalSessionDir), { recursive: true });
  await movePath(entry.sessionDirInEntry, entry.originalSessionDir);
  let projRestored = false;
  if (typeof entry.originalProjcacheFile === 'string'
    && (await pathExists(entry.projcacheFileInEntry))
    && !(await pathExists(entry.originalProjcacheFile))) {
    try {
      await mkdir(dirname(entry.originalProjcacheFile), { recursive: true });
      await rename(entry.projcacheFileInEntry, entry.originalProjcacheFile);
      projRestored = true;
    } catch {
      projRestored = false;
    }
  }
  try {
    await rm(entry.entryDir, { recursive: true, force: true });
  } catch {
    /* 残留空条目目录无害 */
  }
  // 无条件撤归档标记：未归档时 registry 内部是 no-op。防止删除第 5 步的
  // unarchive 失败留下标记——ArchivedSessionGate 会静默拦截该会话（含
  // 子代理谱系）的每个模型步，表现为"能打开、能打字、永远收不到回复"。
  let unarchived = false;
  let unarchiveNote;
  try {
    const registry = ctx.workspaceRegistry;
    if (typeof registry?.unarchiveSession === 'function') {
      await registry.unarchiveSession(entry.id);
      unarchived = true;
    } else {
      unarchiveNote = 'workspaceRegistry.unarchiveSession 不可用';
    }
  } catch (error) {
    unarchiveNote = messageOf(error);
  }
  // 挂回原工作区：删除时已从所有工作区的持久成员账本 detach，侧边栏分组
  // 纯看成员关系，不挂回就落「未分组」。attach 失败不阻塞文件还原：
  // 宿主重启时的路径对齐仍可归组，如实报告即可。
  const attach = await reattachWorkspace(ctx, cfg, entry.id, entry.cwd);
  // 让所有客户端立即把会话行加回列表：恢复只是把文件放回磁盘，宿主没有
  // 任何事件驱动客户端列表，不广播则要等整页刷新/重启才可见。摘要按
  // ApiSessionList.summarizeCold 的冷会话形状构造，标题走缓存投影块。
  try {
    ctx.emit?.('api-session/added', {
      sessionId: entry.id,
      updatedAt: Date.now(),
      agentAvailable: false,
      running: false,
      blank: false,
      ...(typeof entry.cwd === 'string' && entry.cwd.length > 0 ? { cwd: entry.cwd } : {}),
      ...(typeof entry.title === 'string' && entry.title.length > 0
        ? { projections: { kind: 'cached', values: { title: entry.title } } }
        : {}),
    });
  } catch { /* 通知失败不影响恢复 */ }
  return {
    ok: true,
    originalSessionDir: entry.originalSessionDir,
    projRestored,
    unarchived,
    ...(unarchiveNote === undefined ? {} : { unarchiveNote }),
    attached: attach.attached,
    ...(attach.workspaceId === undefined ? {} : { workspaceId: attach.workspaceId }),
    ...(attach.reason === undefined ? {} : { attachNote: attach.reason }),
  };
}

/** 彻底删除一个回收站条目。 */
async function purgeEntry(cfg, entry) {
  assertInsideTrash(cfg, entry.entryDir);
  await rm(entry.entryDir, { recursive: true, force: true });
}

/** 保留期清理：启动时把超过 retentionDays 的条目永久删除。 */
async function sweepExpired(cfg) {
  if (!(cfg.retentionDays > 0)) return 0;
  const cutoff = Date.now() - cfg.retentionDays * DAY_MS;
  const entries = await listTrashEntries(cfg);
  let swept = 0;
  for (const entry of entries) {
    if (entry.trashedAt >= cutoff) continue;
    try {
      await purgeEntry(cfg, entry);
      swept += 1;
    } catch {
      /* 单条失败不阻塞其余清理 */
    }
  }
  return swept;
}

//#endregion

//#region 定时任务（schedule 服务，v1.4.0）

/**
 * 取宿主 schedule 服务（@deepseek-ai/dsh-schedule，服务名 `schedule`）。
 * 自动化任务未启用时为 undefined；形状不符（未来版本变更）也按不可用
 * 处理——绝不猜测，如实降级。刻意不进 inject：硬注入会让整个回收站
 * 插件在 schedule 关闭的 profile 上加载失败。
 */
function scheduleServiceOf(ctx) {
  let svc;
  try {
    svc = ctx.schedule;
  } catch {
    return undefined;
  }
  if (svc === undefined || svc === null) return undefined;
  if (typeof svc.catalog !== 'function' || typeof svc.delete !== 'function' || typeof svc.create !== 'function') {
    return undefined;
  }
  return svc;
}

/** 任务 kind → 中文频率标签。 */
function schedKindLabel(kind) {
  switch (kind) {
    case 'at': return '一次性（定时）';
    case 'after': return '一次性（延迟）';
    case 'every': return '固定间隔';
    case 'daily': return '每天';
    case 'weekly': return '每周';
    case 'cron': return 'Cron';
    default: return kind ?? '未知';
  }
}

/**
 * 列出全部定时任务（catalog：活动 + 已结束，带会话绑定）。
 * @returns {{ available: boolean, tasks: Array, error?: string }}
 */
async function listScheduleTasks(ctx) {
  const svc = scheduleServiceOf(ctx);
  if (svc === undefined) return { available: false, tasks: [] };
  try {
    const raw = await svc.catalog();
    const tasks = (Array.isArray(raw) ? raw : []).map((task) => {
      const record = (task !== null && typeof task === 'object') ? task : {};
      const scheduledMs = Date.parse(record.scheduledAt);
      return {
        id: typeof record.id === 'string' ? record.id : '',
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
        title: typeof record.title === 'string' && record.title.length > 0 ? record.title : undefined,
        prompt: typeof record.prompt === 'string' ? record.prompt : undefined,
        kind: record.kind,
        kindLabel: schedKindLabel(record.kind),
        status: typeof record.status === 'string' ? record.status : undefined,
        scheduledAt: Number.isFinite(scheduledMs) ? scheduledMs : undefined,
        scheduledAtText: typeof record.scheduledAt === 'string' ? record.scheduledAt : undefined,
        lastDeliveryAt: Number.isFinite(Date.parse(record.lastDelivery?.deliveredAt))
          ? Date.parse(record.lastDelivery.deliveredAt)
          : undefined,
      };
    }).filter((task) => task.id.length > 0 && SCHED_ID_RE.test(task.id));
    return { available: true, tasks };
  } catch (error) {
    return { available: true, tasks: [], error: messageOf(error) };
  }
}

/**
 * 把存档的原任务 record 映射回 schedule.create 请求。
 * 一次性任务尽量保时刻：目标仍在未来 → at 原时刻（kind 变 at，投递效果一致）；
 * 「延迟」任务目标已过 → 按原 after_seconds 重新武装（延迟语义本就是相对的）；
 * 「定时」任务目标已过 → 返回 undefined（原时刻无法重建，如实拒绝）。
 * @returns {object|undefined} create 请求；undefined = 无法映射。
 */
function createRequestFromRecord(record, now = Date.now()) {
  if (record === undefined || record === null || typeof record !== 'object') return undefined;
  const base = {
    title: typeof record.title === 'string' ? record.title : undefined,
    prompt: typeof record.prompt === 'string' ? record.prompt : undefined,
  };
  const targetMs = Number.isFinite(Date.parse(record.scheduledAt)) ? Date.parse(record.scheduledAt) : undefined;
  switch (record.kind) {
    case 'at':
      if (targetMs !== undefined && targetMs > now) return { ...base, at: record.scheduledAt };
      return undefined;
    case 'after':
      if (targetMs !== undefined && targetMs > now) return { ...base, at: record.scheduledAt };
      return Number.isSafeInteger(record.afterSeconds) && record.afterSeconds > 0
        ? { ...base, after_seconds: record.afterSeconds }
        : undefined;
    case 'every':
      return Number.isSafeInteger(record.everySeconds) && record.everySeconds >= 60
        ? { ...base, every_seconds: record.everySeconds }
        : undefined;
    case 'daily':
      return (typeof record.time === 'string' && typeof record.timeZone === 'string')
        ? { ...base, daily: { time: record.time, time_zone: record.timeZone } }
        : undefined;
    case 'weekly':
      return (typeof record.time === 'string' && typeof record.timeZone === 'string' && Array.isArray(record.weekdays))
        ? { ...base, weekly: { time: record.time, time_zone: record.timeZone, weekdays: record.weekdays } }
        : undefined;
    case 'cron':
      return (typeof record.expression === 'string' && typeof record.timeZone === 'string')
        ? { ...base, cron: { expression: record.expression, time_zone: record.timeZone } }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * 把一个定时任务移入回收站：先存档整行，再调服务删除；服务拒绝时回滚存档。
 * @returns {{ ok: true, entryName: string, title?: string }
 *   | { ok: false, reason: 'unavailable'|'not-found', message: string }}
 */
async function deleteScheduleToTrash(ctx, cfg, taskId) {
  const svc = scheduleServiceOf(ctx);
  if (svc === undefined) {
    return { ok: false, reason: 'unavailable', message: '宿主未启用自动化任务（schedule 服务不可用），无法操作定时任务。' };
  }
  let catalog;
  try {
    catalog = await svc.catalog();
  } catch (error) {
    return { ok: false, reason: 'unavailable', message: `读取定时任务目录失败：${messageOf(error)}` };
  }
  const task = (Array.isArray(catalog) ? catalog : []).find((item) => item?.id === taskId);
  if (task === undefined) {
    return { ok: false, reason: 'not-found', message: `找不到该定时任务：${taskId}` };
  }
  const suffix = taskId.startsWith('schedule-') ? taskId.slice('schedule-'.length) : taskId;
  const entryName = `${Date.now()}-sched-${suffix}`;
  const entryDir = join(cfg.trashRoot, entryName);
  await mkdir(cfg.trashRoot, { recursive: true });
  await mkdir(entryDir, { recursive: true });
  const record = { ...(task.record ?? task) };
  const meta = {
    version: 1,
    type: 'schedule',
    id: taskId,
    trashedAt: Date.now(),
    sessionId: task.sessionId ?? null,
    status: task.status ?? null,
    record,
    lastDelivery: task.lastDelivery ?? null,
    title: typeof record.title === 'string' ? record.title : null,
  };
  await writeFile(join(entryDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  let result;
  try {
    result = await svc.delete({ sessionId: meta.sessionId, id: taskId });
  } catch (error) {
    await rm(entryDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: 'unavailable', message: `删除定时任务失败：${messageOf(error)}` };
  }
  if (result?.deleted !== true) {
    await rm(entryDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: 'not-found', message: `宿主拒绝删除该定时任务（${result?.code ?? '未知原因'}）：${taskId}` };
  }
  return { ok: true, entryName, title: meta.title ?? undefined };
}

/**
 * 从回收站恢复一个定时任务条目：按存档 record 映射回 create 请求重建。
 * 宿主 create 会生成新 id；恢复结果返回新 id。原会话不存在时照常恢复
 * （投递语义归宿主；会话回收站里随时可先恢复会话）。
 * @returns {{ ok: true, newId: string, title?: string }
 *   | { ok: false, reason: 'unavailable'|'broken'|'meta'|'expired', message?: string }}
 */
async function restoreScheduleEntry(ctx, cfg, entry) {
  assertInsideTrash(cfg, entry.entryDir);
  const svc = scheduleServiceOf(ctx);
  if (svc === undefined) {
    return { ok: false, reason: 'unavailable', message: '宿主未启用自动化任务（schedule 服务不可用），无法恢复定时任务。' };
  }
  if (entry.type !== 'schedule' || entry.taskRecord === undefined) {
    return { ok: false, reason: 'meta', message: '该条目缺少任务存档（record），无法恢复。' };
  }
  const request = createRequestFromRecord(entry.taskRecord);
  if (request === undefined) {
    const targetMs = Date.parse(entry.taskRecord.scheduledAt);
    if ((entry.taskRecord.kind === 'at' || entry.taskRecord.kind === 'after')
      && Number.isFinite(targetMs) && targetMs <= Date.now()) {
      return { ok: false, reason: 'expired', message: '该一次性任务的目标时间已过，无法按原时间恢复。' };
    }
    return { ok: false, reason: 'broken', message: `任务存档无法映射回创建请求（kind=${entry.taskRecord.kind ?? '未知'}）。` };
  }
  let created;
  try {
    created = await svc.create(entry.sessionId, request);
  } catch (error) {
    return { ok: false, reason: 'unavailable', message: `恢复定时任务失败：${messageOf(error)}` };
  }
  try {
    await rm(entry.entryDir, { recursive: true, force: true });
  } catch {
    /* 残留空条目目录无害 */
  }
  return { ok: true, newId: created?.id ?? '', title: created?.title ?? entry.title };
}

//#endregion

//#region 删除管线（detach 立即删除 + 移入回收站）

/**
 * 删除管线（借鉴并适配社区插件 @szhl/dsh-session-delete 的成熟做法）：
 *
 *   1. 归档闸门：先把 id 写进持久归档集（第一方准入闸门，拦住 stop 引发的
 *      wake 与进行中回合的第一步），必要时 stopActivity；
 *   2. detach：透过 ctx.sessions.store 的每条目 detach 能力把 live 会话
 *      从内存摘除（与属主 fiber 卸载时完全同一机制，正常发出
 *      session/disposed）——这是让删除“变成真的”的一步；
 *   3. 移动：把日志目录与投影缓存移入回收站条目（本插件的差异点：不 rm）；
 *   4. 清扫：detach 不可等待——持久化的 writer.close() 与投影缓存的
 *      checkpoint 都会在 disposal 边上重建文件，所以多轮把重建物也移走，
 *      直到连续两轮安静；
 *   5. 记账：unarchive（撤掉第 1 步的闸门标记）、unpin、并对每个
 *      Workspace 实体调用 detachSession 清掉成员关系（非成员是 no-op）；
 *   6. 确认：原路径不复存在才算删除成功，残存物如实报告；对每个确认
 *      删除的 id 广播 api-session/removed——非活动会话没有 session/disposed
 *      可借，必须显式通知，客户端的 sessions.list 快照才会立即摘行。
 */

const DESCENDANT_SETTLE_MS = 400;
const DETACH_SWEEP_ROUNDS = 8;
const DETACH_SWEEP_INTERVAL_MS = 250;

/**
 * 透过会话存储的每条目 detach 能力摘除一个 live 会话。
 * `SessionStore.enter()` 为每个条目记录了 detach 闭包（发布钩子 + 移除 +
 * session/disposed），走条目即复现属主闭包的全部行为，包括在创建/追加
 * 派发进行中时的延迟语义。存储没有公开的按 id 释放接口，因此这里做
 * 能力探测：形状变化时如实报告，绝不猜测。
 * @returns {'detached'|'absent'|'deferred'|'unavailable'|`failed: ${string}`}
 */
function detachLive(ctx, sessionId) {
  try {
    const store = ctx.sessions?.store;
    if (!(store instanceof Map)) return 'unavailable';
    const entry = store.get(sessionId);
    if (entry === undefined) return 'absent';
    // 派发进行中绝不硬撕：存储自己的闭包会延迟到派发落定
    if (entry.announcing === true || entry.appending === true) {
      entry.detachRequested = true;
      return 'deferred';
    }
    if (typeof entry.detach === 'function') entry.detach();
    // 未来存储形状只答 store 不答 detach 时，也要让它停止出现在列表里
    if (store.get(sessionId) === entry) store.delete(sessionId);
    return 'detached';
  } catch (error) {
    return `failed: ${messageOf(error)}`;
  }
}

/** 等待一轮清扫间隔。 */
const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** 把一个目标（主会话或后代）移入它的回收站条目，并写入 meta。 */
async function moveTargetToEntry(target, entryDir, suffix = '') {
  const sessionDest = join(entryDir, suffix === '' ? 'session' : `session-${suffix}`);
  await movePath(target.dir, sessionDest);
  let projMoved = false;
  if (target.hasProjcache && await pathExists(target.projFile)) {
    const projDest = join(entryDir, suffix === '' ? 'projcache.json' : `projcache-${suffix}.json`);
    try {
      await rename(target.projFile, projDest);
      projMoved = true;
    } catch {
      projMoved = false; // 投影缓存只是加速器，移动失败不阻塞删除
    }
  }
  await writeFile(join(entryDir, 'meta.json'), JSON.stringify({
    version: 1,
    id: target.id,
    trashedAt: Date.now(),
    original: {
      sessionDir: target.dir,
      projcacheFile: target.hasProjcache ? target.projFile : null,
    },
    title: target.title ?? null,
    cwd: target.cwd ?? null,
  }, null, 2) + '\n', 'utf8');
  return projMoved;
}

/**
 * 删除一个会话（含子代理后代）：detach → 移入回收站 → 清扫 → 清记账。
 * @param ctx - 插件上下文
 * @param cfg - 归一化配置
 * @param sessionId - 要删除的会话 id
 * @param opts - { stopActivity?: boolean } 归档闸门是否附带停止运行中的工作
 * @returns {{ ok: true, deleted: string[], detached: Record<string, string>, trashEntries: string[], warnings: string[] }
 *   | { ok: false, reason: 'not-found'|'active', message: string }}
 */
async function deleteSessionToTrash(ctx, cfg, sessionId, opts = {}) {
  // 目标必须在磁盘上，否则没有可删除的实体
  const diskSessions = await listAllSessions(cfg);
  const primary = diskSessions.find((item) => item.id === sessionId);
  if (primary === undefined) {
    return { ok: false, reason: 'not-found', message: `磁盘上找不到该会话：${sessionId}` };
  }
  // 子代理后代：parentSession 谱系（持久化头部可用时），任意深度
  const targets = [primary];
  try {
    if (typeof ctx.sessionPersistence?.list === 'function') {
      const headers = (await ctx.sessionPersistence.list()).map((snapshot) => snapshot.header);
      const byParent = new Map();
      for (const header of headers) {
        if (typeof header?.parentSession !== 'string') continue;
        const list = byParent.get(header.parentSession) ?? [];
        list.push(header.id);
        byParent.set(header.parentSession, list);
      }
      const queue = [sessionId];
      const seen = new Set([sessionId]);
      while (queue.length > 0) {
        const parent = queue.shift();
        for (const child of byParent.get(parent) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
          const onDisk = diskSessions.find((item) => item.id === child);
          if (onDisk !== undefined) targets.push(onDisk);
        }
      }
    }
  } catch {
    /* 持久化清单不可用时退化为只删目标本身 */
  }

  const warnings = [];
  // 1. 归档闸门：持久归档集是第一方准入闸门，写它才能拦住运行中的工作
  const registry = ctx.workspaceRegistry;
  if (typeof registry?.archiveSession === 'function') {
    try {
      await registry.archiveSession(sessionId, opts.stopActivity ? { stopActivity: true } : {});
    } catch (error) {
      if (error?.name === 'WorkspaceActiveSessionError') {
        return { ok: false, reason: 'active', message: `会话仍有运行中的工作，已拒绝删除：${messageOf(error)}` };
      }
      warnings.push(`归档闸门：${messageOf(error)}`);
    }
  }

  // 2. detach 全部目标（有后代时先给一拍落定时间）
  if (targets.length > 1) await delay(DESCENDANT_SETTLE_MS);
  const detached = new Map();
  for (const target of targets) {
    const outcome = detachLive(ctx, target.id);
    detached.set(target.id, outcome);
    if (String(outcome).startsWith('failed')) warnings.push(`${target.id}：${outcome}`);
  }

  // 3+4. 移动 + 清扫：disposal 边（持久化 drain / 投影缓存 checkpoint）可能
  // 重建文件，多轮把重建物也移进同一个回收站条目，直到连续两轮安静。
  const trashEntries = new Map();
  for (const target of targets) {
    const entryDir = join(cfg.trashRoot, `${Date.now()}-${target.id}`);
    await mkdir(entryDir, { recursive: true });
    trashEntries.set(target.id, entryDir);
  }
  try {
    let quietRounds = 0;
    for (let round = 0; round < DETACH_SWEEP_ROUNDS && quietRounds < 2; round += 1) {
      await delay(DETACH_SWEEP_INTERVAL_MS);
      let movedAnything = false;
      for (const target of targets) {
        const entryDir = trashEntries.get(target.id);
        // 原路径仍在（首轮未移或被 disposal 边重建）：移进回收站
        if (await pathExists(target.dir)) {
          if (!(await pathExists(join(entryDir, 'session')))) {
            await moveTargetToEntry(target, entryDir);
          } else {
            // 首轮已移入，这是 disposal 边重建出来的残余
            await moveTargetToEntry(target, entryDir, `recreated-${round}`);
          }
          movedAnything = true;
        } else if (round === 0) {
          movedAnything = true; // 目标在闸门与 detach 之间消失了，视为已处理
        }
        if (target.hasProjcache && await pathExists(target.projFile)) {
          const dest = join(entryDir, 'projcache.json');
          if (!(await pathExists(dest))) {
            await rename(target.projFile, dest).catch(() => {});
          } else {
            await rename(target.projFile, join(entryDir, `projcache-recreated-${round}`)).catch(() => {});
          }
          movedAnything = true;
        }
      }
      quietRounds = movedAnything ? 0 : quietRounds + 1;
    }
  } catch (error) {
    warnings.push(`移入回收站：${messageOf(error)}`);
  }

  // 5. 清记账：撤掉闸门标记（第 1 步写的）、置顶标记与工作区成员关系
  if (typeof registry?.unarchiveSession === 'function') {
    for (const target of targets) {
      try { await registry.unarchiveSession(target.id); } catch (error) {
        warnings.push(`${target.id} 归档标记：${messageOf(error)}`);
      }
    }
  }
  if (typeof registry?.unpinSession === 'function') {
    for (const target of targets) {
      try { await registry.unpinSession(target.id); } catch (error) {
        warnings.push(`${target.id} 置顶：${messageOf(error)}`);
      }
    }
  }
  if (typeof registry?.list === 'function') {
    let workspaces = [];
    try {
      const listed = registry.list();
      workspaces = Array.isArray(listed) ? listed : (await listed) ?? [];
    } catch (error) {
      warnings.push(`工作区清单：${messageOf(error)}`);
    }
    for (const target of targets) {
      for (const workspace of workspaces) {
        if (typeof workspace?.detachSession !== 'function') continue;
        // Workspace.sessionIds 读取时按头部索引过滤，成员关系以实体 detach 探测：非成员是 no-op
        try { await workspace.detachSession(target.id); } catch { /* no-op */ }
      }
    }
  }

  // 6. 确认：原路径必须消失；对确认删除的 id 广播列表移除事件。
  //    只有 live 会话的 detach 会派发 session/disposed（session-controller
  //    由此发 api-session/removed）；非活动会话文件被移走后无人广播，
  //    客户端 sessions.list 快照里的行会一直挂着——这里显式补发，
  //    让所有已连接客户端立即摘除侧边栏行。live 会话重复广播是幂等的。
  const deleted = [];
  for (const target of targets) {
    const gone = !(await pathExists(target.dir))
      && !(target.hasProjcache && await pathExists(target.projFile));
    if (gone) {
      deleted.push(target.id);
      try { ctx.emit?.('api-session/removed', target.id); } catch { /* 通知失败不影响删除 */ }
    } else {
      warnings.push(`${target.id}：删除后仍有文件残留在原位`);
    }
  }
  return {
    ok: true,
    deleted,
    detached: Object.fromEntries(detached),
    trashEntries: [...trashEntries.values()],
    warnings,
  };
}

//#endregion
//#region 展示与解析

function fmtBytes(bytes, truncated = false) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 || unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${truncated ? '≥' : ''}${text} ${units[unit]}`;
}

function fmtTime(ts) {
  if (!Number.isFinite(ts)) return '未知时间';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 1 → a，2 → b … 26 → z，27 → aa（回收站条目编号）。 */
function indexLabel(n) {
  let rest = n;
  let text = '';
  while (rest > 0) {
    rest -= 1;
    text = String.fromCharCode(97 + (rest % 26)) + text;
    rest = Math.floor(rest / 26);
  }
  return text;
}

/** indexLabel 的逆运算；非合法字母编号返回 undefined。 */
function parseIndexLabel(text) {
  if (!/^[a-z]+$/u.test(text)) return undefined;
  let n = 0;
  for (const ch of text) n = n * 26 + (ch.charCodeAt(0) - 96);
  return n;
}

function shortId(id) {
  return id.length <= 21 ? id : `${id.slice(0, 18)}…${id.slice(-3)}`;
}

function titleOf(item) {
  return item.title ?? '（无标题）';
}

function cwdOf(item) {
  return item.cwd ?? '未知工作区';
}

function ok(text) {
  return { kind: 'success', text };
}

function err(text) {
  return { kind: 'error', text };
}

/**
 * 按 id 前缀在列表中唯一匹配；返回 {hit} / {ambiguous, candidates} / {miss}。
 * 接受带或不带 “session-”/“schedule-” 前缀的写法（回收站里两类条目共存）。
 */
function matchByIdPrefix(items, token) {
  const t = token.toLowerCase();
  const candidates = [t, `session-${t}`, `schedule-${t}`];
  const hits = [...new Map(
    items
      .filter((item) => candidates.some((c) => item.id === c || item.id.startsWith(c)))
      .map((item) => [item.id, item]),
  ).values()];
  if (hits.length === 1) return { hit: hits[0] };
  if (hits.length > 1) {
    return { ambiguous: true, candidates: hits.slice(0, 8).map((h) => h.id) };
  }
  return { miss: true };
}

/** 解析 /recycle del 的目标：纯数字优先当编号；超出范围且长度足够的数字串回退为 id 前缀。 */
function resolveSessionTarget(sessions, token) {
  if (/^\d+$/u.test(token)) {
    const n = Number.parseInt(token, 10);
    if (n >= 1 && n <= sessions.length) return { session: sessions[n - 1], label: `#${n}` };
    if (token.length < MIN_PREFIX_LEN) return { error: `编号 ${n} 超出范围（当前列表 1–${sessions.length}）。` };
    // 长数字串更像 uuid 前缀，落到前缀匹配
  }
  if (token.length < MIN_PREFIX_LEN) {
    return { error: `id 前缀太短（至少 ${MIN_PREFIX_LEN} 位）：${token}` };
  }
  const matched = matchByIdPrefix(sessions, token);
  if (matched.hit !== undefined) return { session: matched.hit, label: shortId(matched.hit.id) };
  if (matched.ambiguous) {
    return { error: `id 前缀 “${token}” 命中多个会话，请写更长前缀：\n${matched.candidates.map((c) => `  ${c}`).join('\n')}` };
  }
  return { error: /^\d+$/u.test(token) && Number.parseInt(token, 10) <= sessions.length * 100
    ? `编号或前缀都无法定位会话：${token}`
    : `找不到会话：${token}` };
}

/** 解析 restore/wipe 的目标：字母编号（a、b…）优先；未命中且长度足够时回退为 id 前缀。 */
async function resolveTrashTarget(cfg, token) {
  const entries = await listTrashEntries(cfg);
  if (entries.length === 0) return { error: '回收站是空的。' };
  const letterIndex = parseIndexLabel(token.toLowerCase());
  if (letterIndex !== undefined && letterIndex >= 1 && letterIndex <= entries.length) {
    return { entry: entries[letterIndex - 1], label: token.toLowerCase() };
  }
  if (token.length >= MIN_PREFIX_LEN) {
    const matched = matchByIdPrefix(entries, token);
    if (matched.hit !== undefined) return { entry: matched.hit, label: shortId(matched.hit.id) };
    if (matched.ambiguous) {
      return { error: `id 前缀 “${token}” 命中多个回收站条目，请写更长前缀：\n${matched.candidates.map((c) => `  ${c}`).join('\n')}` };
    }
  }
  if (letterIndex !== undefined) {
    return { error: `回收站编号 ${token.toLowerCase()} 超出范围（当前 a–${indexLabel(entries.length)}）。` };
  }
  return { error: `回收站里没有这个条目：${token}` };
}

/** 概览文本：会话列表（标出活动）+ 定时任务列表 + 回收站列表 + 用法。 */
async function renderOverview(ctx, cfg) {
  const [sessions, entries, schedules] = await Promise.all([
    listAllSessions(cfg), listTrashEntries(cfg), listScheduleTasks(ctx),
  ]);
  const liveIds = new Set((ctx.sessions?.list?.() ?? []).map((s) => s.id));
  const lines = [];
  lines.push('🗑 会话回收站');
  lines.push('');
  lines.push(`会话（新→旧，共 ${sessions.length} 个，● = 使用中）：`);
  if (sessions.length === 0) {
    lines.push('  （磁盘上没有会话）');
  } else {
    for (let i = 0; i < sessions.length; i += 1) {
      const s = sessions[i];
      const flag = liveIds.has(s.id) ? '●' : ' ';
      lines.push(`  ${i + 1}. ${flag}[${fmtTime(s.createdAt)}] ${titleOf(s)}`);
      lines.push(`       ${cwdOf(s)} · ${shortId(s.id)}`);
    }
  }
  lines.push('');
  if (!schedules.available) {
    lines.push('定时任务：宿主未启用自动化任务（schedule 服务不可用）。');
  } else if (schedules.error !== undefined) {
    lines.push(`定时任务：读取失败（${schedules.error}）。`);
  } else {
    lines.push(`定时任务（按下次运行排序，共 ${schedules.tasks.length} 个）：`);
    if (schedules.tasks.length === 0) {
      lines.push('  （没有定时任务）');
    } else {
      for (let i = 0; i < schedules.tasks.length; i += 1) {
        const task = schedules.tasks[i];
        const when = task.scheduledAt !== undefined ? fmtTime(task.scheduledAt) : '未知时间';
        lines.push(`  ${i + 1}. [${when}] ${titleOf(task)}（${task.kindLabel}）`);
        lines.push(`       会话 ${shortId(task.sessionId ?? '')} · ${shortId(task.id)}`);
      }
    }
    lines.push('  可用 /recycle sched del <编号|id前缀> 把任务移入回收站（可恢复）。');
  }
  lines.push('');
  lines.push(`回收站（新→旧，共 ${entries.length} 个，保留 ${cfg.retentionDays > 0 ? `${cfg.retentionDays} 天` : '永不自动清理'}）：`);
  if (entries.length === 0) {
    lines.push('  （回收站为空）');
  } else {
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const kindMark = e.type === 'schedule' ? '⏰[定时任务] ' : '';
      let sizeText = '';
      if (e.type !== 'schedule' && await pathExists(e.sessionDirInEntry)) {
        const size = await dirSizeCapped(e.sessionDirInEntry);
        sizeText = ` · ${fmtBytes(size.total, size.truncated)}`;
      }
      lines.push(`  ${indexLabel(i + 1)}. [${fmtTime(e.trashedAt)}] ${kindMark}${titleOf(e)}${sizeText}`);
      lines.push(`       ${e.type === 'schedule' ? `原会话 ${shortId(e.sessionId ?? '')}` : cwdOf(e)} · ${shortId(e.id)}`);
    }
  }
  lines.push('');
  lines.push(HELP_TEXT);
  return ok(lines.join('\n'));
}

//#endregion
//#region 命令处理

/** 解析 /recycle sched 的目标：纯数字优先当编号；否则按 schedule id 前缀唯一匹配。 */
function resolveSchedTarget(tasks, token) {
  if (/^\d+$/u.test(token)) {
    const n = Number.parseInt(token, 10);
    if (n >= 1 && n <= tasks.length) return { task: tasks[n - 1], label: `#${n}` };
    if (token.length < MIN_PREFIX_LEN) return { error: `编号 ${n} 超出范围（当前列表 1–${tasks.length}）。` };
    // 长数字串更像 uuid 前缀，落到前缀匹配
  }
  if (token.length < MIN_PREFIX_LEN) {
    return { error: `id 前缀太短（至少 ${MIN_PREFIX_LEN} 位）：${token}` };
  }
  const t = token.toLowerCase();
  const normalized = t.startsWith('schedule-') ? t : `schedule-${t}`;
  const hits = [...new Map(
    tasks
      .filter((item) => item.id === t || item.id.startsWith(normalized))
      .map((item) => [item.id, item]),
  ).values()];
  if (hits.length === 1) return { task: hits[0], label: shortId(hits[0].id) };
  if (hits.length > 1) {
    return { error: `id 前缀 “${token}” 命中多个定时任务，请写更长前缀：\n${hits.slice(0, 8).map((h) => `  ${h.id}`).join('\n')}` };
  }
  return { error: `找不到定时任务：${token}` };
}
/** 执行一条 /recycle 子命令；任何异常都折叠为 error 结果。 */
async function runCommand(ctx, cfg, invocation) {
  const argv = invocation.rawInput.trim().split(/\s+/u).filter((part) => part.length > 0);
  if (argv.length === 0 || (argv.length === 1 && argv[0].toLowerCase() === 'list')) {
    return renderOverview(ctx, cfg);
  }
  const op = argv[0].toLowerCase();
  const rest = argv.slice(1);
  if (op === 'help') return ok(HELP_TEXT);

  if (op === 'sched') {
    const sub = (rest[0] ?? 'list').toLowerCase();
    const schedRest = rest.slice(1);
    if (sub === 'list') {
      const schedules = await listScheduleTasks(ctx);
      if (!schedules.available) return err('宿主未启用自动化任务（schedule 服务不可用），无法操作定时任务。');
      if (schedules.error !== undefined) return err(`定时任务目录读取失败：${schedules.error}`);
      const lines = [`定时任务（按下次运行排序，共 ${schedules.tasks.length} 个）：`];
      if (schedules.tasks.length === 0) {
        lines.push('  （没有定时任务）');
      } else {
        for (let i = 0; i < schedules.tasks.length; i += 1) {
          const task = schedules.tasks[i];
          const when = task.scheduledAt !== undefined ? fmtTime(task.scheduledAt) : '未知时间';
          lines.push(`  ${i + 1}. [${when}] ${titleOf(task)}（${task.kindLabel}）`);
          lines.push(`       会话 ${shortId(task.sessionId ?? '')} · ${shortId(task.id)}`);
        }
      }
      return ok(lines.join('\n'));
    }
    if (sub === 'del') {
      if (schedRest.length !== 1) return err('用法：/recycle sched del <编号|id前缀>');
      const schedules = await listScheduleTasks(ctx);
      if (!schedules.available) return err('宿主未启用自动化任务（schedule 服务不可用），无法操作定时任务。');
      if (schedules.error !== undefined) return err(`定时任务目录读取失败：${schedules.error}`);
      const resolved = resolveSchedTarget(schedules.tasks, schedRest[0]);
      if (resolved.error !== undefined) return err(resolved.error);
      const result = await deleteScheduleToTrash(ctx, cfg, resolved.task.id);
      if (!result.ok) return err(result.message);
      const lines = [
        `定时任务已移入回收站：${titleOf({ title: result.title })}`,
        `  任务 id：${resolved.task.id}`,
        `  恢复：/recycle sched restore <回收站编号|id前缀>（重建后 id 会变）`,
      ];
      if (cfg.retentionDays > 0) lines.push(`  ${cfg.retentionDays} 天后自动彻底清除。`);
      return ok(lines.join('\n'));
    }
    if (sub === 'restore') {
      if (schedRest.length !== 1) return err('用法：/recycle sched restore <编号|id前缀>');
      const resolved = await resolveTrashTarget(cfg, schedRest[0]);
      if (resolved.error !== undefined) return err(resolved.error);
      const entry = resolved.entry;
      if (entry.type !== 'schedule') return err(`条目 ${resolved.label} 不是定时任务（是会话），请用 /recycle restore。`);
      const result = await restoreScheduleEntry(ctx, cfg, entry);
      if (!result.ok) {
        switch (result.reason) {
          case 'unavailable': return err(result.message);
          case 'expired': return err(result.message ?? '该一次性任务的目标时间已过，无法按原时间恢复。');
          case 'meta': return err('该条目缺少任务存档（record），无法恢复。');
          case 'broken': return err(result.message ?? '任务存档无法映射回创建请求。');
          default: return err(`恢复失败：${String(result.reason)}`);
        }
      }
      return ok([
        `已恢复定时任务：${titleOf({ title: result.title })}`,
        `  新任务 id：${result.newId}（原 id 作废）`,
        `  原会话：${shortId(entry.sessionId ?? '')}`,
      ].join('\n'));
    }
    if (sub === 'wipe') {
      if (schedRest.length < 1) return err('用法：/recycle sched wipe <编号|id前缀|all> [confirm]');
      const confirm = schedRest[schedRest.length - 1].toLowerCase() === 'confirm';
      const targetToken = schedRest[0];
      const schedEntries = async () => (await listTrashEntries(cfg)).filter((entry) => entry.type === 'schedule');
      if (targetToken.toLowerCase() === 'all') {
        const entries = await schedEntries();
        if (entries.length === 0) return ok('回收站里没有定时任务条目。');
        if (!confirm) {
          return ok(`将彻底删除全部 ${entries.length} 个定时任务条目（不可恢复）。确认请执行：\n  /recycle sched wipe all confirm`);
        }
        let purged = 0;
        let failed = 0;
        for (const entry of entries) {
          try {
            await purgeEntry(cfg, entry);
            purged += 1;
          } catch {
            failed += 1;
          }
        }
        return ok(`已彻底删除 ${purged} 个定时任务条目${failed > 0 ? `，${failed} 个失败（可能被占用）` : ''}。`);
      }
      const resolved = await resolveTrashTarget(cfg, targetToken);
      if (resolved.error !== undefined) return err(resolved.error);
      const entry = resolved.entry;
      if (entry.type !== 'schedule') return err(`条目 ${resolved.label} 不是定时任务（是会话），请用 /recycle wipe。`);
      if (!confirm) {
        return ok(`将彻底删除定时任务条目 ${resolved.label}（${titleOf(entry)}，不可恢复）。确认请执行：\n  /recycle sched wipe ${targetToken} confirm`);
      }
      await purgeEntry(cfg, entry);
      return ok(`已彻底删除定时任务条目：${titleOf(entry)}（${entry.id}）。`);
    }
    return err(`未知 sched 子命令 “${sub}”。\n${HELP_TEXT}`);
  }

  if (op === 'del') {
    if (rest.length !== 1) return err('用法：/recycle del <编号|id前缀>');
    const resolved = resolveSessionTarget(await listAllSessions(cfg), rest[0]);
    if (resolved.error !== undefined) return err(resolved.error);
    const session = resolved.session;
    if (invocation.agent?.session?.id === session.id) {
      return err('这是当前正在对话的会话，不能删除自己。');
    }
    const result = await deleteSessionToTrash(ctx, cfg, session.id, { stopActivity: true });
    if (!result.ok) {
      return err(result.message);
    }
    const size = await dirSizeCapped(result.trashEntries[0]);
    const lines = [
      `已移入回收站：${titleOf(session)}${result.deleted.length > 1 ? `（含 ${result.deleted.length - 1} 个子代理会话）` : ''}`,
      `  会话 id：${session.id}`,
      `  大小：${fmtBytes(size.total, size.truncated)} · 工作区：${cwdOf(session)}`,
    ];
    const detachSummary = result.detached[session.id];
    if (detachSummary === 'detached') lines.push('  会话已从本进程释放（session/disposed 已派发）。');
    else if (detachSummary === 'deferred') lines.push('  会话有派发进行中，释放将延迟完成；列表随刷新消失。');
    else if (detachSummary === 'unavailable') lines.push('  注意：未能释放本进程内的会话对象（存储结构变化），列表刷新后该行可能回来，重启后彻底消失。');
    for (const warning of result.warnings) lines.push(`  警告：${warning}`);
    if (cfg.retentionDays > 0) lines.push(`  ${cfg.retentionDays} 天后自动彻底清除；随时可用 /recycle restore 恢复。`);
    else lines.push('  已关闭自动清理；可用 /recycle restore 恢复，或 /recycle wipe 彻底删除。');
    return ok(lines.join('\n'));
  }

  if (op === 'restore') {
    if (rest.length !== 1) return err('用法：/recycle restore <编号|id前缀>');
    const resolved = await resolveTrashTarget(cfg, rest[0]);
    if (resolved.error !== undefined) return err(resolved.error);
    const entry = resolved.entry;
    if (entry.type === 'schedule') {
      // 定时任务条目：restore 也支持（GUI 恢复按钮对两类条目同位），但
      // 提示里引导 sched 子命令；行为与 sched restore 完全一致。
      const result = await restoreScheduleEntry(ctx, cfg, entry);
      if (!result.ok) {
        return err(result.message ?? `恢复失败：${String(result.reason)}`);
      }
      return ok([
        `已恢复定时任务：${titleOf({ title: result.title })}`,
        `  新任务 id：${result.newId}（原 id 作废）`,
        `  原会话：${shortId(entry.sessionId ?? '')}`,
      ].join('\n'));
    }
    const result = await restoreSession(ctx, cfg, entry);
    if (!result.ok) {
      switch (result.reason) {
        case 'live': return err('该会话 id 已在本进程内使用，不能恢复同名会话。');
        case 'exists': return err(`原位置已存在同名会话目录，恢复取消：\n  ${entry.originalSessionDir}`);
        case 'meta': return err('该条目缺少 meta.json 的原始路径信息，无法自动恢复。');
        case 'broken': return err('该条目的会话数据不完整（缺少 session/ 目录）。');
        default: return err(`恢复失败：${String(result.reason)}`);
      }
    }
    const lines = [
      `已恢复：${titleOf(entry)}`,
      `  会话 id：${entry.id}`,
      `  位置：${result.originalSessionDir}`,
    ];
    if (result.projRestored) lines.push('  投影缓存已一并恢复。');
    if (result.unarchived) lines.push('  已从归档集中移出，侧边栏会重新显示。');
    else if (result.unarchiveNote !== undefined) lines.push(`  归档标记清理失败：${result.unarchiveNote}`);
    if (result.attached) lines.push('  已挂回原工作区，侧边栏立即归组显示。');
    else if (result.attachNote !== undefined) lines.push(`  未能挂回工作区：${result.attachNote}`);
    return ok(lines.join('\n'));
  }

  if (op === 'wipe') {
    if (rest.length < 1) return err('用法：/recycle wipe <编号|id前缀|all> [confirm]');
    const confirm = rest[rest.length - 1].toLowerCase() === 'confirm';
    const targetToken = rest[0];
    if (targetToken.toLowerCase() === 'all') {
      const entries = await listTrashEntries(cfg);
      if (entries.length === 0) return ok('回收站已经是空的。');
      if (!confirm) {
        return ok(`将彻底删除回收站全部 ${entries.length} 个条目（不可恢复）。确认请执行：\n  /recycle wipe all confirm`);
      }
      let purged = 0;
      let failed = 0;
      for (const entry of entries) {
        try {
          await purgeEntry(cfg, entry);
          purged += 1;
        } catch {
          failed += 1;
        }
      }
      return ok(`已彻底删除 ${purged} 个条目${failed > 0 ? `，${failed} 个失败（可能被占用）` : ''}。`);
    }
    const resolved = await resolveTrashTarget(cfg, targetToken);
    if (resolved.error !== undefined) return err(resolved.error);
    const entry = resolved.entry;
    if (!confirm) {
      let sizeText = '';
      if (await pathExists(entry.sessionDirInEntry)) {
        const size = await dirSizeCapped(entry.sessionDirInEntry);
        sizeText = `，${fmtBytes(size.total, size.truncated)}`;
      }
      return ok(`将彻底删除回收站条目 ${resolved.label}（${titleOf(entry)}${sizeText}，不可恢复）。确认请执行：\n  /recycle wipe ${targetToken} confirm`);
    }
    await purgeEntry(cfg, entry);
    return ok(`已彻底删除：${titleOf(entry)}（${entry.id}）。`);
  }

  return err(`未知子命令 “${op}”。\n${HELP_TEXT}`);
}

//#endregion
//#region 插件入口

/**
 * cordis 插件入口：注册全局 /recycle 命令与 GUI 用的 6 条 webServer 路由
 * （delete/trash/restore/wipe + schedules/schedule-delete），并在启动时按
 * 保留天数清理过期条目。schedule 服务经 ctx.schedule 现取（可选依赖）。
 * @param ctx - 插件上下文（commands / sessions 已注入，workspaceRegistry 可选）
 * @param config - cordis.patch.yml 条目的 config（可省略）
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const inflight = new Set();

  // 启动清理：尽力而为，失败只记日志
  const janitor = sweepExpired(cfg).catch((error) => {
    ctx.logger?.warn?.(`session-recycle-bin: 保留期清理失败：${error?.message ?? String(error)}`);
    return undefined;
  });

  // 浏览器半侧的路由（webServer 可用时）：GUI 的删除、回收站列表、恢复、
  // 彻底清除都走这里，不依赖“当前会话”的 agent，也不污染任何会话的命令日志。
  const webServer = ctx.webServer;
  if (typeof webServer?.register === 'function') {
    const rejected = (req, res) => {
      const rejection = ctx.connection?.requestRejection?.(req);
      if (rejection === undefined || rejection === false) return false;
      res.statusCode = typeof rejection === 'number' ? rejection : 401;
      res.end();
      return true;
    };
    const sendJson = (res, status, payload) => {
      const body = JSON.stringify(payload);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(body);
    };
    /** 统一的 JSON POST 路由脚手架：鉴权围栏 + 方法校验 + 请求体解析 + 异常兜底。 */
    const postJsonRoute = (path, label, handle) => ctx.effect(() => webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'POST');
          res.end();
          return;
        }
        let request;
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch (error) {
          sendJson(res, 400, { ok: false, error: messageOf(error) });
          return;
        }
        try {
          await handle(request, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: messageOf(error) });
        }
      },
    }), label);

    // 删除（移入回收站）
    postJsonRoute(ROUTE_DELETE, 'session-recycle-bin: delete route', async (request, res) => {
      const sessionId = request?.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '' || !ID_SAFE.test(sessionId)) {
        sendJson(res, 400, { ok: false, error: 'missing or invalid sessionId' });
        return;
      }
      // CLI 经命令通道执行时宿主会注入自己的会话 id；桌面端通常无此变量
      const ownSessionId = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID : undefined;
      if (ownSessionId !== undefined && sessionId === ownSessionId) {
        sendJson(res, 409, { ok: false, error: 'refused', code: 'own-session' });
        return;
      }
      const result = await deleteSessionToTrash(ctx, cfg, sessionId, { stopActivity: true });
      if (!result.ok) {
        sendJson(res, result.reason === 'active' ? 409 : 404, { ok: false, error: result.message, code: result.reason });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        deleted: result.deleted,
        detached: result.detached,
        trashEntries: result.trashEntries,
        warnings: result.warnings,
      });
    });

    // 回收站列表路由：GUI 弹层与徽标计数的数据源（含定时任务条目）
    postJsonRoute(ROUTE_TRASH, 'session-recycle-bin: trash list route', async (_request, res) => {
      const entries = await listTrashEntries(cfg);
      sendJson(res, 200, {
        ok: true,
        retentionDays: cfg.retentionDays,
        entries: entries.map((entry) => ({
          entryName: entry.entryName,
          type: entry.type,
          id: entry.id,
          trashedAt: entry.trashedAt,
          title: entry.title ?? null,
          cwd: entry.type === 'schedule' ? null : entry.cwd ?? null,
          ...(entry.type === 'schedule' ? { sessionId: entry.sessionId ?? null } : {}),
        })),
      });
    });

    // 恢复路由：按条目类型分派（会话→restoreSession；定时任务→restoreScheduleEntry）
    postJsonRoute(ROUTE_RESTORE, 'session-recycle-bin: restore route', async (request, res) => {
      const entryName = request?.entryName;
      if (typeof entryName !== 'string' || !ENTRY_NAME_RE.test(entryName)) {
        sendJson(res, 400, { ok: false, error: 'missing or invalid entryName' });
        return;
      }
      const entries = await listTrashEntries(cfg);
      const entry = entries.find((item) => item.entryName === entryName);
      if (entry === undefined) {
        sendJson(res, 404, { ok: false, error: `回收站里没有这个条目：${entryName}`, code: 'not-found' });
        return;
      }
      if (entry.type === 'schedule') {
        const result = await restoreScheduleEntry(ctx, cfg, entry);
        if (!result.ok) {
          sendJson(res, 409, { ok: false, error: result.message ?? `恢复失败：${String(result.reason)}`, code: result.reason });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          type: 'schedule',
          id: entry.id,
          newId: result.newId,
          title: result.title ?? entry.title ?? null,
        });
        return;
      }
      const result = await restoreSession(ctx, cfg, entry);
      if (!result.ok) {
        const reasons = {
          live: '该会话 id 已在本进程内使用，不能恢复同名会话。',
          exists: '原位置已存在同名会话目录，恢复取消。',
          meta: '该条目缺少 meta.json 的原始路径信息，无法自动恢复。',
          broken: '该条目的会话数据不完整（缺少 session/ 目录）。',
        };
        sendJson(res, 409, { ok: false, error: reasons[result.reason] ?? `恢复失败：${String(result.reason)}`, code: result.reason });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        type: 'session',
        id: entry.id,
        title: entry.title ?? null,
        originalSessionDir: result.originalSessionDir,
        projRestored: result.projRestored,
        unarchived: result.unarchived,
        ...(result.unarchiveNote === undefined ? {} : { unarchiveNote: result.unarchiveNote }),
        attached: result.attached,
        ...(result.workspaceId === undefined ? {} : { workspaceId: result.workspaceId }),
        ...(result.attachNote === undefined ? {} : { attachNote: result.attachNote }),
      });
    });

    // 彻底清除路由：不带 confirm 只回预览，带 confirm 才执行（与 /recycle wipe 同语义）
    postJsonRoute(ROUTE_WIPE, 'session-recycle-bin: wipe route', async (request, res) => {
      const target = request?.target;
      const confirm = request?.confirm === true;
      if (target === 'all') {
        const entries = await listTrashEntries(cfg);
        if (entries.length === 0) {
          sendJson(res, 200, { ok: true, purged: 0, failed: 0 });
          return;
        }
        if (!confirm) {
          sendJson(res, 200, { ok: true, preview: true, target: 'all', count: entries.length });
          return;
        }
        let purged = 0;
        let failed = 0;
        for (const entry of entries) {
          try {
            await purgeEntry(cfg, entry);
            purged += 1;
          } catch {
            failed += 1;
          }
        }
        sendJson(res, 200, { ok: true, purged, failed });
        return;
      }
      if (typeof target !== 'string' || !ENTRY_NAME_RE.test(target)) {
        sendJson(res, 400, { ok: false, error: 'missing or invalid target' });
        return;
      }
      const entries = await listTrashEntries(cfg);
      const entry = entries.find((item) => item.entryName === target);
      if (entry === undefined) {
        sendJson(res, 404, { ok: false, error: `回收站里没有这个条目：${target}`, code: 'not-found' });
        return;
      }
      if (!confirm) {
        let size;
        if (await pathExists(entry.sessionDirInEntry)) size = await dirSizeCapped(entry.sessionDirInEntry);
        sendJson(res, 200, {
          ok: true,
          preview: true,
          target,
          count: 1,
          entry: {
            entryName: entry.entryName,
            id: entry.id,
            title: entry.title ?? null,
            trashedAt: entry.trashedAt,
            cwd: entry.cwd ?? null,
            sizeBytes: size?.total,
            sizeTruncated: size?.truncated,
          },
        });
        return;
      }
      await purgeEntry(cfg, entry);
      sendJson(res, 200, { ok: true, purged: 1, failed: 0, id: entry.id, title: entry.title ?? null });
    });

    // 定时任务列表路由（v1.4.0）：GUI「定时任务」页签数据源
    postJsonRoute(ROUTE_SCHEDULES, 'session-recycle-bin: schedules list route', async (_request, res) => {
      const schedules = await listScheduleTasks(ctx);
      sendJson(res, 200, {
        ok: true,
        available: schedules.available,
        ...(schedules.error === undefined ? {} : { error: schedules.error }),
        tasks: schedules.tasks,
      });
    });

    // 定时任务删除路由（v1.4.0）：存档进回收站后调服务删除（服务拒绝即回滚）
    postJsonRoute(ROUTE_SCHEDULE_DELETE, 'session-recycle-bin: schedule delete route', async (request, res) => {
      const taskId = request?.id;
      if (typeof taskId !== 'string' || taskId === '' || !SCHED_ID_RE.test(taskId)) {
        sendJson(res, 400, { ok: false, error: 'missing or invalid schedule id' });
        return;
      }
      const result = await deleteScheduleToTrash(ctx, cfg, taskId);
      if (!result.ok) {
        sendJson(res, result.reason === 'not-found' ? 404 : 409, { ok: false, error: result.message, code: result.reason });
        return;
      }
      sendJson(res, 200, { ok: true, id: taskId, entryName: result.entryName, title: result.title ?? null });
    });
  }

  const handler = (invocation) => {
    const op = runCommand(ctx, cfg, invocation).catch((error) => err(
      `回收站操作失败：${error?.message ?? String(error)}`,
    ));
    inflight.add(op);
    const settle = () => {
      inflight.delete(op);
    };
    op.then(settle, settle);
    return op;
  };

  ctx.effect(function* () {
    // 卸载时等待启动清理与进行中的命令收敛
    yield async () => {
      await janitor;
      await Promise.allSettled(inflight);
    };
    yield ctx.commands.register({
      name: 'recycle',
      description: '会话回收站：del 删除 / restore 恢复 / wipe 彻底清除 / sched 定时任务',
      input: { hint: '[list] | del <编号|id前缀> | restore <编号|id前缀> | wipe <编号|id前缀|all> [confirm] | sched [list|del|restore|wipe] …' },
      handler,
    });
  }, 'session-recycle-bin lifecycle');
}

//#endregion