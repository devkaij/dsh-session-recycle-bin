/**
 * dsh-session-recycle-bin 宿主半侧离线行为测试（不需要 DSH 运行）。
 *
 * 用桩 ctx 驱动插件的 apply()，在临时目录里模拟真实的
 * sessions / storages / trash 布局与 live 会话存储，验证：
 *   - /recycle 各子命令
 *   - detach 删除管线（live 会话立即删除、后代连带、记账清理）
 *   - webServer 删除路由（鉴权围栏、方法校验、JSON 结算）
 *   - 还原归组（v1.3.5，T15）：attachSession 挂回原工作区、无记录时
 *     create 兜底、无条件撤归档、attach 失败不阻塞文件还原
 *
 * 运行：node test/harness.mjs
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const DAY_MS = 86400000;
let passed = 0;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

function createSnapshotStore(init) {
  let state = init;
  const listeners = new Set();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * 构造桩 ctx。
 * - sessions.list/get 供概览与恢复用；sessions.store 供 detach 管线用
 * - workspaceRegistry 提供归档/置顶/成员关系全套记账桩（list 同步返回，与真实一致），
 *   含 resolveByPath/create/attachSession（还原归组用，v1.3.5）
 * - sessionPersistence 提供头部清单（parentSession 谱系）
 * - webServer 捕获路由注册，connection 默认放行
 * - schedules 非空时挂一个 @deepseek-ai/dsh-schedule 形状的桩服务（v1.4.0）
 */
function makeCtx({ liveIds = [], storeEntries = new Map(), persistenceHeaders = [], schedules = null } = {}) {
  const registered = [];
  const registeredRoutes = [];
  const archiveCalls = [];
  const unarchiveCalls = [];
  const unpinCalls = [];
  const workspaceDetachCalls = [];
  const workspaceAttachCalls = [];
  const workspaceCreateCalls = [];
  const emitCalls = [];
  const archivedSessionIds = [];
  // 归组失败场景开关：setAttachError(new Error(...)) 后 attachSession 抛错
  let attachError = null;
  const makeWorkspace = (id, path) => ({
    id,
    path,
    detachSession: async (sessionId) => {
      workspaceDetachCalls.push(sessionId);
    },
    async attachSession(sessionId) {
      if (attachError !== null) throw attachError;
      workspaceAttachCalls.push({ workspaceId: id, id: sessionId });
    },
  });
  const workspaces = [makeWorkspace('ws-1', 'C:\\demo')];
  const registry = {
    archivedSessionIds,
    list: () => workspaces, // 与真实注册表一致：同步返回实体清单
    async archiveSession(id, options) {
      archiveCalls.push({ id, options });
      if (!archivedSessionIds.includes(id)) archivedSessionIds.push(id);
    },
    async unarchiveSession(id) {
      unarchiveCalls.push(id);
      const index = archivedSessionIds.indexOf(id);
      if (index >= 0) archivedSessionIds.splice(index, 1);
    },
    async unpinSession(id) {
      unpinCalls.push(id);
    },
    // 还原归组（v1.3.5）：按路径解析已注册工作区；create 与真实注册表同为按路径幂等
    async resolveByPath(path) {
      return workspaces.find((workspace) => workspace.path === path);
    },
    async create(path) {
      workspaceCreateCalls.push(path);
      const existing = workspaces.find((workspace) => workspace.path === path);
      if (existing !== undefined) return existing;
      const entity = makeWorkspace(`ws-created-${workspaceCreateCalls.length}`, path);
      workspaces.push(entity);
      return entity;
    },
  };
  const ctx = {
    commands: {
      async register(def) {
        registered.push(def);
        return async () => {};
      },
    },
    sessions: {
      list: () => liveIds.map((id) => ({ id })),
      get: (id) => (liveIds.includes(id) ? { id } : undefined),
      store: storeEntries,
    },
    ...(schedules === null ? {} : { schedule: schedules }),
    workspaceRegistry: registry,
    emit(event, ...args) {
      emitCalls.push([event, ...args]);
    },
    sessionPersistence: {
      list: async () => persistenceHeaders.map((header) => ({ header })),
    },
    webServer: {
      register(route) {
        registeredRoutes.push(route);
        return () => {};
      },
    },
    connection: {
      requestRejection: () => undefined,
    },
    logger: { warn() {}, error() {}, info() {} },
    effect(body, label) {
      void label;
      void (async () => {
        if (typeof body === 'function') {
          const result = body();
          if (result !== null && typeof result === 'object' && typeof result[Symbol.iterator] === 'function') {
            for (const step of result) {
              if (step) await step;
            }
          }
          return;
        }
        if (body !== null && typeof body === 'object' && typeof body[Symbol.iterator] === 'function') {
          for (const step of body) {
            if (step) await step;
          }
        }
      })();
    },
  };
  return {
    ctx, registered, registeredRoutes, archiveCalls, unarchiveCalls, unpinCalls,
    workspaceDetachCalls, archivedSessionIds, emitCalls,
    workspaceAttachCalls, workspaceCreateCalls,
    setAttachError: (error) => { attachError = error; },
  };
}

function invocation(rawInput, currentSessionId) {
  return {
    rawInput,
    agent: { session: { id: currentSessionId } },
    signal: new AbortController().signal,
    commandId: 'test',
    attachments: [],
  };
}

/**
 * 构造 @deepseek-ai/dsh-schedule 形状的桩服务（v1.4.0 测试用）。
 * - catalog()：全量任务（record 展平 + sessionId/status/lastDelivery），按 scheduledAt 排序
 * - delete({sessionId,id})：sessionId 不匹配时返回 deleted:false + schedule_not_found（与真实一致）
 * - create(sessionId, request)：selector 六选一，'at' 过去时刻抛 not_future（与真实一致），生成新 id
 */
function makeScheduleService(seedTasks = []) {
  let counter = 0;
  const store = new Map();
  for (const task of seedTasks) {
    store.set(task.record.id, {
      sessionId: task.sessionId,
      record: { ...task.record },
      status: task.status ?? 'active',
      deliveryHistory: { records: [], earlierRecordsUnavailable: false },
      ...(task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery }),
    });
  }
  const inputError = (message) => Object.assign(new Error(message), { name: 'ScheduleInputError' });
  return {
    async catalog() {
      return [...store.values()].map((task) => ({
        ...task.record,
        sessionId: task.sessionId,
        status: task.status,
        ...(task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery }),
      })).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)) || a.id.localeCompare(b.id));
    },
    async list(request) {
      return [...store.values()]
        .filter((task) => task.sessionId === request.sessionId && task.status === 'active')
        .map((task) => task.record);
    },
    async delete(request) {
      const task = store.get(request.id);
      if (task === undefined || task.sessionId !== request.sessionId) {
        return { id: request.id, deleted: false, code: 'schedule_not_found' };
      }
      store.delete(request.id);
      return { id: request.id, deleted: true };
    },
    async create(sessionId, request) {
      const selectors = ['at', 'after_seconds', 'every_seconds', 'daily', 'weekly', 'cron']
        .filter((key) => request[key] !== undefined);
      if (selectors.length !== 1) throw inputError('Exactly one reminder selector is required.');
      const now = Date.now();
      const id = `schedule-fake${String(++counter).padStart(4, '0')}-1111-4aaa-8bbb-00000000000${counter}`;
      const base = { id, title: request.title, prompt: request.prompt };
      let record;
      if (request.at !== undefined) {
        const target = Date.parse(request.at);
        if (!Number.isFinite(target) || target <= now) throw inputError('The scheduled time must be strictly in the future.');
        record = { ...base, kind: 'at', scheduledAt: new Date(target).toISOString() };
      } else if (request.after_seconds !== undefined) {
        record = { ...base, kind: 'after', afterSeconds: request.after_seconds, scheduledAt: new Date(now + request.after_seconds * 1000).toISOString() };
      } else if (request.every_seconds !== undefined) {
        record = { ...base, kind: 'every', everySeconds: request.every_seconds, scheduledAt: new Date(now + request.every_seconds * 1000).toISOString() };
      } else if (request.daily !== undefined) {
        record = { ...base, kind: 'daily', time: request.daily.time, timeZone: request.daily.time_zone, scheduledAt: new Date(now + 3600000).toISOString() };
      } else if (request.weekly !== undefined) {
        record = { ...base, kind: 'weekly', time: request.weekly.time, timeZone: request.weekly.time_zone, weekdays: request.weekly.weekdays, scheduledAt: new Date(now + 3600000).toISOString() };
      } else {
        record = { ...base, kind: 'cron', expression: request.cron.expression, timeZone: request.cron.time_zone, scheduledAt: new Date(now + 3600000).toISOString() };
      }
      store.set(id, { sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false } });
      return record;
    },
    /** 测试断言用：内部存储快照。 */
    _store: store,
  };
}

async function writeSessionFixture(sessionsRoot, projcacheRoot, { id, cwd, createdAt, title }) {
  const dir = join(sessionsRoot, '--C--demo--', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), `fake-log:${id}\n`, 'utf8');
  if (createdAt !== undefined) {
    const doc = {
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt, cwd, isSeeded: false, inheritedEventCount: 0 },
        rows: { title: { ver: 1, seq: 2, val: title ?? null } },
      },
    };
    await mkdir(join(projcacheRoot, 'sessions'), { recursive: true });
    await writeFile(join(projcacheRoot, 'sessions', `${id}.json`), JSON.stringify(doc), 'utf8');
  }
  return dir;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function trashEntryDirs(trashRoot) {
  const { readdir } = await import('node:fs/promises');
  try {
    return (await readdir(trashRoot)).filter((n) => /^\d{13,}-(session|sched)-/.test(n));
  } catch {
    return [];
  }
}

function fakeReq(method, url, body) {
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body, 'utf8');
    },
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.body = payload;
    },
  };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recycle-test-'));
  const config = {
    sessionsRoot: join(root, 'sessions'),
    projcacheRoot: join(root, 'storages', 'session_projcache'),
    trashRoot: join(root, 'trash'),
    retentionDays: 30,
  };
  await mkdir(config.sessionsRoot, { recursive: true });

  // 前缀约定（全部含字母，避免被解析成编号）：
  //   ID_OLD → 'aaaa'  ID_LIVE → 'bbbb'  ID_CHILD → 'cccc'  ID_DEF → 'eeee'
  const ID_OLD = 'session-aaaa1111-1111-4bbb-8ccc-000000000001';
  const ID_LIVE = 'session-bbbb2222-2222-4ccc-8ddd-000000000002';
  const ID_CHILD = 'session-cccc3333-3333-4ddd-8eee-000000000003';
  const ID_DEF = 'session-eeee5555-5555-4fff-8aaa-000000000005';
  const ID_PARENT = 'session-dddd4444-4444-4eee-8fff-000000000004';
  const NOW = Date.now();

  await writeSessionFixture(config.sessionsRoot, config.projcacheRoot, {
    id: ID_OLD, cwd: 'C:\\demo', createdAt: NOW - 2000, title: '帮我把日志接上回收站',
  });
  await writeSessionFixture(config.sessionsRoot, config.projcacheRoot, {
    id: ID_LIVE, cwd: 'C:\\demo', createdAt: NOW - 1000, title: null,
  });
  await writeSessionFixture(config.sessionsRoot, config.projcacheRoot, {
    id: ID_CHILD, cwd: 'C:\\demo', createdAt: NOW - 500, title: '子代理会话',
  });
  await writeSessionFixture(config.sessionsRoot, config.projcacheRoot, {
    id: ID_PARENT, cwd: 'C:\\demo', createdAt: NOW - 750, title: '带后代的父会话',
  });

  // live 存储：ID_LIVE / ID_CHILD 在本进程内“使用中”（带 detach 探针）
  const detachCalls = [];
  const storeEntries = new Map();
  for (const id of [ID_PARENT, ID_CHILD]) {
    storeEntries.set(id, {
      id,
      detach() {
        detachCalls.push(id);
        storeEntries.delete(id);
      },
      announcing: false,
      appending: false,
    });
  }

  const { ctx, registered, registeredRoutes, archiveCalls, unarchiveCalls, unpinCalls, workspaceDetachCalls, archivedSessionIds, emitCalls, workspaceAttachCalls, workspaceCreateCalls, setAttachError } = makeCtx({
    liveIds: [ID_LIVE, ID_PARENT, ID_CHILD],
    storeEntries,
    persistenceHeaders: [
      { id: ID_OLD },
      { id: ID_LIVE },
      { id: ID_CHILD, parentSession: ID_PARENT },
    ],
  });

  console.log('T0 插件加载：命令与路由注册');
  apply(ctx, config);
  await new Promise((r) => setTimeout(r, 20));
  check('注册了一个名为 recycle 的命令', registered.length === 1 && registered[0].name === 'recycle');
  const routePaths = registeredRoutes.map((route) => route.path);
  check('注册了 6 条路由（delete/trash/restore/wipe/schedules/schedule-delete）', routePaths.length === 6
    && ['/dsh-session-recycle-bin.delete', '/dsh-session-recycle-bin.trash', '/dsh-session-recycle-bin.restore', '/dsh-session-recycle-bin.wipe', '/dsh-session-recycle-bin.schedules', '/dsh-session-recycle-bin.schedule-delete']
      .every((p) => routePaths.includes(p)), JSON.stringify(routePaths));
  const pickRoute = (suffix) => registeredRoutes.find((route) => route.path.endsWith(suffix));
  const deleteRoute = pickRoute('.delete');
  const trashRoute = pickRoute('.trash');
  const restoreRoute = pickRoute('.restore');
  const wipeRoute = pickRoute('.wipe');
  const schedulesRoute = registeredRoutes.find((route) => route.path === '/dsh-session-recycle-bin.schedules');
  const scheduleDeleteRoute = registeredRoutes.find((route) => route.path === '/dsh-session-recycle-bin.schedule-delete');
  const handler = registered[0].handler;

  console.log('T1 概览');
  const overview = await handler(invocation('', ID_LIVE));
  check('概览成功', overview.kind === 'success');
  check('列出三个磁盘会话', overview.text.includes('3.'));
  check('活动会话被标 ●', overview.text.includes('●'));
  check('标题来自投影缓存', overview.text.includes('帮我把日志接上回收站'));

  console.log('T2 删除非活动会话：直接移入回收站');
  const delOld = await handler(invocation('del aaaa', ID_LIVE));
  check('非活动会话可删', delOld.kind === 'success' && delOld.text.includes('已移入回收站'), delOld.text?.slice(0, 140));
  const entries = await trashEntryDirs(config.trashRoot);
  check('回收站出现一个条目', entries.length === 1, JSON.stringify(entries));
  const entryDir = join(config.trashRoot, entries[0]);
  check('会话日志目录已移入', await exists(join(entryDir, 'session', 'session.v4.jsonl.zstd')));
  check('meta 记录原始路径', JSON.parse(await readFile(join(entryDir, 'meta.json'), 'utf8')).original.sessionDir.includes(ID_OLD));
  check('原会话目录已消失', !(await exists(join(config.sessionsRoot, '--C--demo--', ID_OLD))));
  check('归档闸门写入过（stopActivity）', archiveCalls.some((c) => c.id === ID_OLD && c.options?.stopActivity === true));
  check('记账清理：归档标记已撤', unarchiveCalls.includes(ID_OLD) && !archivedSessionIds.includes(ID_OLD));
  check('记账清理：置顶已清', unpinCalls.includes(ID_OLD));
  check('记账清理：工作区成员已摘除', workspaceDetachCalls.includes(ID_OLD));
  check('广播 api-session/removed（非活动会话即时摘行）', emitCalls.some(([event, id]) => event === 'api-session/removed' && id === ID_OLD), JSON.stringify(emitCalls));

  console.log('T3 删除 live 会话：detach 后移入回收站，子代理后代连带');
  const delLive = await handler(invocation('del dddd', ID_LIVE));
  check('live 会话按 id 前缀删除成功', delLive.kind === 'success' && delLive.text.includes('已移入回收站'), delLive.text?.slice(0, 160));
  check('提示包含连带删除的子代理会话数', delLive.text.includes('子代理会话'));
  check('store 的 detach 被调用（主会话与后代）', detachCalls.includes(ID_PARENT) && detachCalls.includes(ID_CHILD));
  check('live 会话已从 store 摘除', !storeEntries.has(ID_PARENT) && !storeEntries.has(ID_CHILD));
  check('live 会话目录已移入回收站', (await trashEntryDirs(config.trashRoot)).some((n) => n.endsWith(ID_PARENT)));
  check('子代理会话目录也移入回收站', (await trashEntryDirs(config.trashRoot)).some((n) => n.endsWith(ID_CHILD)));
  check('原 live 目录已消失', !(await exists(join(config.sessionsRoot, '--C--demo--', ID_PARENT))));
  check('广播 api-session/removed（主会话与后代）', emitCalls.some(([e, id]) => e === 'api-session/removed' && id === ID_PARENT)
    && emitCalls.some(([e, id]) => e === 'api-session/removed' && id === ID_CHILD));

  console.log('T4 派发进行中（announcing）→ 延迟 detach，文件照常移入');
  await writeSessionFixture(config.sessionsRoot, config.projcacheRoot, {
    id: ID_DEF, cwd: 'C:\\demo', createdAt: NOW + 500, title: '派发中的会话',
  });
  storeEntries.set(ID_DEF, {
    id: ID_DEF,
    detach() {
      detachCalls.push(ID_DEF);
      storeEntries.delete(ID_DEF);
    },
    announcing: true,
    appending: false,
  });
  const delDeferred = await handler(invocation('del eeee', ID_LIVE));
  check('deferred 会话仍删除成功', delDeferred.kind === 'success' && delDeferred.text.includes('已移入回收站'), delDeferred.text?.slice(0, 160));
  check('回收站里出现该条目', (await trashEntryDirs(config.trashRoot)).some((n) => n.endsWith(ID_DEF)));
  check('deferred 删除同样广播移除', emitCalls.some(([e, id]) => e === 'api-session/removed' && id === ID_DEF));

  console.log('T5 restore（id 前缀，撤销到会话 aaaa）');
  const restored = await handler(invocation('restore aaaa', ID_LIVE));
  check('恢复成功', restored.kind === 'success' && restored.text.includes('已恢复'), restored.text?.slice(0, 160));
  check('会话目录回到原位', await exists(join(config.sessionsRoot, '--C--demo--', ID_OLD, 'session.v4.jsonl.zstd')));
  check('条目目录已清理', !(await trashEntryDirs(config.trashRoot)).some((n) => n.endsWith(ID_OLD)));

  console.log('T6 wipe 二次确认');
  const delAgain = await handler(invocation('del aaaa', ID_LIVE));
  check('再次移入回收站', delAgain.kind === 'success' && (await trashEntryDirs(config.trashRoot)).some((n) => n.endsWith(ID_OLD)));
  const wipePreview = await handler(invocation('wipe aaaa', ID_LIVE));
  check('不带 confirm 只预览', wipePreview.kind === 'success' && wipePreview.text.includes('确认请执行'));
  const wipeDo = await handler(invocation('wipe aaaa confirm', ID_LIVE));
  check('confirm 后彻底删除', wipeDo.kind === 'success' && wipeDo.text.includes('已彻底删除'));
  check('条目目录消失', !(await trashEntryDirs(config.trashRoot)).some((n) => n.endsWith(ID_OLD)));

  console.log('T7 当前会话拒绝');
  storeEntries.set(ID_LIVE, { id: ID_LIVE, detach() {}, announcing: false, appending: false });
  const delCurrent = await handler(invocation('del bbbb', ID_LIVE));
  check('删除当前会话被拒绝', delCurrent.kind === 'error' && delCurrent.text.includes('不能删除自己'));
  check('拒绝删除不广播移除', !emitCalls.some(([e, id]) => e === 'api-session/removed' && id === ID_LIVE));

  console.log('T8 webServer 删除路由');
  const res405 = fakeRes();
  await deleteRoute.handler(fakeReq('GET', '/dsh-session-recycle-bin.delete'), res405);
  check('GET 被拒 405', res405.statusCode === 405);
  await writeSessionFixture(config.sessionsRoot, config.projcacheRoot, {
    id: ID_OLD, cwd: 'C:\\demo', createdAt: NOW - 2000, title: '帮我把日志接上回收站',
  });
  const resOk = fakeRes();
  await deleteRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.delete', JSON.stringify({ sessionId: ID_OLD })), resOk);
  const payload = JSON.parse(resOk.body ?? '{}');
  check('POST 删除成功并回显 deleted', resOk.statusCode === 200 && payload.ok === true && payload.deleted.includes(ID_OLD), resOk.body);
  check('路由删除同样落进回收站', (await trashEntryDirs(config.trashRoot)).some((n) => n.endsWith(ID_OLD)));
  check('路由删除同样广播 api-session/removed', emitCalls.some(([e, id]) => e === 'api-session/removed' && id === ID_OLD));
  const resBad = fakeRes();
  await deleteRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.delete', JSON.stringify({})), resBad);
  check('缺 sessionId 返回 400', resBad.statusCode === 400);

  console.log('T9 保留期自动清理');
  const oldTrashId = 'session-44444444-dddd-4eee-8fff-000000000004';
  const oldEntry = join(config.trashRoot, `1000000000000-${oldTrashId}`);
  await mkdir(join(oldEntry, 'session'), { recursive: true });
  await writeFile(join(oldEntry, 'session', 'dummy.log'), 'x', 'utf8');
  await writeFile(join(oldEntry, 'meta.json'), JSON.stringify({
    version: 1, id: oldTrashId, trashedAt: Date.now() - 40 * DAY_MS,
    original: { sessionDir: join(config.sessionsRoot, '--C--demo--', oldTrashId), projcacheFile: null },
    title: '老会话', cwd: 'C:\\demo',
  }));
  apply(ctx, config); // 重新 apply 触发启动清理
  await new Promise((r) => setTimeout(r, 50));
  check('超过保留期的条目被清理', !(await exists(oldEntry)));

  console.log('T10 非法配置');
  let threw = false;
  try {
    apply(ctx, { ...config, trashRoot: 'relative/path' });
  } catch {
    threw = true;
  }
  check('相对路径配置在加载期报错', threw);

  console.log('T11 回收站列表路由（trash）');
  const trashRes405 = fakeRes();
  await trashRoute.handler(fakeReq('GET', '/dsh-session-recycle-bin.trash'), trashRes405);
  check('GET 被拒 405', trashRes405.statusCode === 405);
  // 此时回收站里有 T3/T4/T8 留下的条目（ID_PARENT / ID_CHILD / ID_DEF / ID_OLD）
  const trashRes = fakeRes();
  await trashRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.trash', '{}'), trashRes);
  const trashPayload = JSON.parse(trashRes.body ?? '{}');
  check('POST 列出条目并带保留期', trashRes.statusCode === 200 && trashPayload.ok === true && trashPayload.retentionDays === 30, trashRes.body);
  check('条目字段齐全（entryName/id/trashedAt）', Array.isArray(trashPayload.entries) && trashPayload.entries.length >= 3
    && trashPayload.entries.every((e) => typeof e.entryName === 'string' && typeof e.id === 'string' && typeof e.trashedAt === 'number'), trashRes.body);
  const entryNames = trashPayload.entries.map((e) => e.entryName);
  check('条目新→旧排序（ID_OLD 最新在前）', entryNames[0].endsWith(ID_OLD), JSON.stringify(entryNames));

  console.log('T12 恢复路由（restore）');
  const resBadEntry = fakeRes();
  await restoreRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.restore', JSON.stringify({ entryName: '../escape' })), resBadEntry);
  check('非法 entryName 返回 400', resBadEntry.statusCode === 400);
  const resMissEntry = fakeRes();
  await restoreRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.restore', JSON.stringify({ entryName: '1000000000000-session-absent' })), resMissEntry);
  check('不存在的条目返回 404', resMissEntry.statusCode === 404);
  const oldEntryName = entryNames[0];
  const resRestore = fakeRes();
  await restoreRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.restore', JSON.stringify({ entryName: oldEntryName })), resRestore);
  const restorePayload = JSON.parse(resRestore.body ?? '{}');
  check('POST 恢复成功并回显原始路径', resRestore.statusCode === 200 && restorePayload.ok === true && restorePayload.originalSessionDir.includes(ID_OLD), resRestore.body);
  check('恢复后条目消失', !(await trashEntryDirs(config.trashRoot)).some((n) => n.endsWith(ID_OLD)));
  check('恢复成功广播 api-session/added（冷摘要带 cwd 与标题投影）', emitCalls.some(([event, summary]) => event === 'api-session/added'
    && summary?.sessionId === ID_OLD
    && summary.cwd === 'C:\\demo'
    && summary.agentAvailable === false
    && summary.projections?.kind === 'cached'
    && summary.projections.values?.title === '帮我把日志接上回收站'), JSON.stringify(emitCalls.filter(([event]) => event === 'api-session/added')));
  const resRestoreAgain = fakeRes();
  await restoreRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.restore', JSON.stringify({ entryName: oldEntryName })), resRestoreAgain);
  check('重复恢复同一 entryName 返回 404', resRestoreAgain.statusCode === 404);

  console.log('T13 彻底清除路由（wipe）');
  const defEntryName = entryNames.find((n) => n.endsWith(ID_DEF));
  const wipeResBad = fakeRes();
  await wipeRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.wipe', JSON.stringify({ target: 'not an entry!' })), wipeResBad);
  check('非法 target 返回 400', wipeResBad.statusCode === 400);
  const wipeResPreview = fakeRes();
  await wipeRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.wipe', JSON.stringify({ target: defEntryName })), wipeResPreview);
  const wipePreviewPayload = JSON.parse(wipeResPreview.body ?? '{}');
  check('不带 confirm 只回预览（含条目摘要）', wipeResPreview.statusCode === 200 && wipePreviewPayload.preview === true
    && wipePreviewPayload.entry?.id === ID_DEF, wipeResPreview.body);
  const wipeResDo = fakeRes();
  await wipeRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.wipe', JSON.stringify({ target: defEntryName, confirm: true })), wipeResDo);
  const wipeDoPayload = JSON.parse(wipeResDo.body ?? '{}');
  check('confirm 后彻底删除单条', wipeResDo.statusCode === 200 && wipeDoPayload.ok === true && wipeDoPayload.purged === 1, wipeResDo.body);
  check('条目目录消失', !(await trashEntryDirs(config.trashRoot)).some((n) => n.endsWith(ID_DEF)));
  const wipeAllPreview = fakeRes();
  await wipeRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.wipe', JSON.stringify({ target: 'all' })), wipeAllPreview);
  const wipeAllPreviewPayload = JSON.parse(wipeAllPreview.body ?? '{}');
  check('wipe all 预览回条目数', wipeAllPreviewPayload.preview === true && wipeAllPreviewPayload.target === 'all' && wipeAllPreviewPayload.count >= 1, wipeAllPreview.body);
  const wipeAllRes = fakeRes();
  await wipeRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.wipe', JSON.stringify({ target: 'all', confirm: true })), wipeAllRes);
  const wipeAllPayload = JSON.parse(wipeAllRes.body ?? '{}');
  check('wipe all confirm 清空回收站', wipeAllPayload.ok === true && wipeAllPayload.purged >= 1 && wipeAllPayload.failed === 0, wipeAllRes.body);
  check('回收站已空', (await trashEntryDirs(config.trashRoot)).length === 0);
  const wipeAllEmpty = fakeRes();
  await wipeRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.wipe', JSON.stringify({ target: 'all', confirm: true })), wipeAllEmpty);
  check('空回收站 wipe all 返回 purged 0', JSON.parse(wipeAllEmpty.body ?? '{}').purged === 0);

  console.log('T14 鉴权围栏（connection.requestRejection，六条路由共用）');
  ctx.connection.requestRejection = () => 401;
  for (const route of [deleteRoute, trashRoute, restoreRoute, wipeRoute, schedulesRoute, scheduleDeleteRoute]) {
    const resAuth = fakeRes();
    await route.handler(fakeReq('POST', route.path, '{}'), resAuth);
    check(`鉴权拒绝：${route.path} 返回 401 且不落盘`, resAuth.statusCode === 401);
  }
  ctx.connection.requestRejection = () => undefined;
  const resAuthRecover = fakeRes();
  await trashRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.trash', '{}'), resAuthRecover);
  check('撤销拒绝后路由恢复可用', resAuthRecover.statusCode === 200);

  console.log('T15 还原归组（v1.3.5：attachSession 挂回原工作区 + 无条件撤归档）');
  const ID_ATTACH = 'session-hhhh7777-7777-4aaa-8bbb-000000000007';
  const ID_UNOWNED = 'session-iiii8888-8888-4bbb-8ccc-000000000008';
  const ID_ATTACHFAIL = 'session-jjjj9999-9999-4ccc-8ddd-000000000009';

  /** 写一个冷会话 fixture 并经删除路由移入回收站，返回其 entryName。 */
  async function trashFresh(id, cwd, title) {
    await writeSessionFixture(config.sessionsRoot, config.projcacheRoot, { id, cwd, createdAt: NOW, title });
    const res = fakeRes();
    await deleteRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.delete', JSON.stringify({ sessionId: id })), res);
    const payload = JSON.parse(res.body ?? '{}');
    if (payload.ok !== true) throw new Error(`T15 删除 ${id} 失败：${res.body}`);
    const names = await trashEntryDirs(config.trashRoot);
    const entryName = names.find((n) => n.endsWith(id));
    if (entryName === undefined) throw new Error(`T15 回收站找不到 ${id} 的条目`);
    return entryName;
  }

  // 场景 A：cwd 命中已注册工作区（C:\demo = ws-1）→ 直接 attach
  const entryA = await trashFresh(ID_ATTACH, 'C:\\demo', '归组目标会话');
  check('T15-A 删除后 id 不在归档集（删除管线已清理）', !archivedSessionIds.includes(ID_ATTACH));
  const unarchiveBefore = unarchiveCalls.length;
  const resA = fakeRes();
  await restoreRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.restore', JSON.stringify({ entryName: entryA })), resA);
  const payloadA = JSON.parse(resA.body ?? '{}');
  check('T15-A 还原成功且 attached:true', resA.statusCode === 200 && payloadA.ok === true && payloadA.attached === true, resA.body);
  check('T15-A attachSession 挂到原工作区 ws-1', workspaceAttachCalls.some((c) => c.id === ID_ATTACH && c.workspaceId === 'ws-1'), JSON.stringify(workspaceAttachCalls));
  check('T15-A 无条件调用 unarchiveSession（即使 id 不在归档集）', unarchiveCalls.length > unarchiveBefore && unarchiveCalls.includes(ID_ATTACH));
  check('T15-A 会话目录回到原位', await exists(join(config.sessionsRoot, '--C--demo--', ID_ATTACH, 'session.v4.jsonl.zstd')));

  // 场景 B：cwd 没有对应工作区记录 → create 兜底后 attach
  const entryB = await trashFresh(ID_UNOWNED, 'C:\\unowned-project', '无主工作区会话');
  const resB = fakeRes();
  await restoreRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.restore', JSON.stringify({ entryName: entryB })), resB);
  const payloadB = JSON.parse(resB.body ?? '{}');
  check('T15-B 无匹配记录时 create(path) 被调用', workspaceCreateCalls.includes('C:\\unowned-project'), JSON.stringify(workspaceCreateCalls));
  check('T15-B 新建工作区后 attach 成功', payloadB.ok === true && payloadB.attached === true
    && workspaceAttachCalls.some((c) => c.id === ID_UNOWNED && c.workspaceId.startsWith('ws-created-')), resB.body);

  // 场景 C：attachSession 抛错（如 cwd 目录已不存在）→ 不算还原失败
  const entryC = await trashFresh(ID_ATTACHFAIL, 'C:\\demo', '归组失败会话');
  setAttachError(new Error('its cwd is not a directory'));
  const resC = fakeRes();
  await restoreRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.restore', JSON.stringify({ entryName: entryC })), resC);
  const payloadC = JSON.parse(resC.body ?? '{}');
  setAttachError(null);
  check('T15-C attach 失败不阻塞还原：ok 且 attached:false 带原因', resC.statusCode === 200 && payloadC.ok === true
    && payloadC.attached === false && typeof payloadC.attachNote === 'string' && payloadC.attachNote.includes('not a directory'), resC.body);
  check('T15-C attach 失败时文件仍还原回原位', await exists(join(config.sessionsRoot, '--C--demo--', ID_ATTACHFAIL, 'session.v4.jsonl.zstd')));

  // 场景 D：/recycle restore 命令路径同样归组并如实报告
  const entryD = await trashFresh('session-kkkk6666-6666-4ddd-8eee-000000000006', 'C:\\demo', '命令归组会话');
  const cmdD = await handler(invocation('restore kkkk', ID_LIVE));
  check('T15-D 命令还原成功', cmdD.kind === 'success' && cmdD.text.includes('已恢复'), cmdD.text?.slice(0, 160));
  check('T15-D 命令输出报告挂回原工作区', cmdD.text.includes('挂回原工作区'), cmdD.text);
  check('T15-D 命令路径也 attach 到 ws-1', workspaceAttachCalls.some((c) => c.id === 'session-kkkk6666-6666-4ddd-8eee-000000000006' && c.workspaceId === 'ws-1'));
  check('T15-D 命令路径条目已清理', !(await trashEntryDirs(config.trashRoot)).some((n) => n.endsWith('kkkk')));

  console.log('T16 定时任务：schedules 路由与 sched list（v1.4.0）');
  const SCHED_SESSION = ID_OLD; // 原 aaaa 会话已在 T12 恢复回盘，用它绑任务
  const SCHED_AT = 'schedule-11112222-3333-4ccc-8ddd-000000000001';
  const SCHED_DAILY = 'schedule-22223333-4444-4ddd-8eee-000000000002';
  const FUTURE_MS = Date.now() + 3_600_000;
  const sched = makeScheduleService([
    {
      sessionId: SCHED_SESSION,
      record: { id: SCHED_AT, kind: 'at', title: '一次性提醒', prompt: '交物理报告', scheduledAt: new Date(FUTURE_MS).toISOString() },
      status: 'active',
    },
    {
      sessionId: SCHED_SESSION,
      record: { id: SCHED_DAILY, kind: 'daily', title: '每日站会', prompt: 'standup', time: '09:00:00.000', timeZone: 'Asia/Shanghai', scheduledAt: new Date(FUTURE_MS).toISOString() },
      status: 'active',
    },
  ]);
  ctx.schedule = sched; // 插件在调用时现取 ctx.schedule，事后挂载同样生效

  const schedRes405 = fakeRes();
  await schedulesRoute.handler(fakeReq('GET', '/dsh-session-recycle-bin.schedules'), schedRes405);
  check('schedules 路由 GET 被拒 405', schedRes405.statusCode === 405);
  const schedRes = fakeRes();
  await schedulesRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.schedules', '{}'), schedRes);
  const schedPayload = JSON.parse(schedRes.body ?? '{}');
  check('schedules 路由列出两个任务且 available:true', schedRes.statusCode === 200 && schedPayload.ok === true
    && schedPayload.available === true && Array.isArray(schedPayload.tasks) && schedPayload.tasks.length === 2, schedRes.body);
  check('任务字段齐全（id/sessionId/title/kind/status）', schedPayload.tasks.every((task) => task.id.startsWith('schedule-')
    && task.sessionId === SCHED_SESSION && typeof task.title === 'string' && typeof task.kind === 'string' && task.status === 'active'), schedRes.body);
  const schedList = await handler(invocation('sched list', ID_LIVE));
  check('sched list 列出任务', schedList.kind === 'success' && schedList.text.includes('一次性提醒') && schedList.text.includes('每日站会'), schedList.text?.slice(0, 200));
  const overviewSched = await handler(invocation('', ID_LIVE));
  check('概览包含定时任务区', overviewSched.kind === 'success' && overviewSched.text.includes('定时任务'), overviewSched.text?.slice(0, 80));

  console.log('T17 sched del：任务入回收站（meta 存档 + 服务删除）');
  const schedDel = await handler(invocation('sched del 1111', ID_LIVE));
  check('sched del 按 id 前缀成功', schedDel.kind === 'success' && schedDel.text.includes('定时任务已移入回收站'), schedDel.text?.slice(0, 160));
  check('schedule 服务里任务已删除', !sched._store.has(SCHED_AT));
  const allEntries = await import('node:fs/promises').then((fs) => fs.readdir(config.trashRoot));
  const schedEntryName = allEntries.find((n) => n.includes('-sched-'));
  check('回收站出现 sched 条目', typeof schedEntryName === 'string' && /^\d{13,}-sched-11112222/.test(schedEntryName), JSON.stringify(allEntries));
  const schedMeta = JSON.parse(await readFile(join(config.trashRoot, schedEntryName, 'meta.json'), 'utf8'));
  check('meta 存档类型/任务行/原会话', schedMeta.type === 'schedule' && schedMeta.id === SCHED_AT
    && schedMeta.sessionId === SCHED_SESSION && schedMeta.record.kind === 'at' && schedMeta.record.prompt === '交物理报告', JSON.stringify(schedMeta).slice(0, 200));
  const trashAfterSched = fakeRes();
  await trashRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.trash', '{}'), trashAfterSched);
  const trashAfterSchedPayload = JSON.parse(trashAfterSched.body ?? '{}');
  const schedTrashEntry = trashAfterSchedPayload.entries.find((e) => e.type === 'schedule');
  check('trash 路由条目带 type:schedule 与 sessionId', schedTrashEntry !== undefined && schedTrashEntry.id === SCHED_AT
    && schedTrashEntry.sessionId === SCHED_SESSION, trashAfterSched.body);

  console.log('T18 sched restore：按原规则重建（at 保留原时刻，id 更新）');
  const schedRestore = await handler(invocation('sched restore 1111', ID_LIVE));
  check('sched restore 成功并报告新 id', schedRestore.kind === 'success' && schedRestore.text.includes('已恢复定时任务') && schedRestore.text.includes('新任务 id'), schedRestore.text?.slice(0, 200));
  const rebuilt = [...sched._store.values()].find((task) => task.record.kind === 'at' && task.record.prompt === '交物理报告');
  check('任务按原时刻重建（scheduledAt 原样保留）', rebuilt !== undefined
    && rebuilt.record.scheduledAt === new Date(FUTURE_MS).toISOString() && rebuilt.record.id !== SCHED_AT, JSON.stringify(rebuilt));
  check('恢复后条目已清理', !((await import('node:fs/promises').then((fs) => fs.readdir(config.trashRoot)))).includes(schedEntryName));

  console.log('T19 过期一次性任务的恢复映射');
  const SCHED_AFTER_PAST = 'schedule-33334444-5555-4eee-8fff-000000000003';
  const SCHED_AT_PAST = 'schedule-44445555-6666-4fff-8aaa-000000000004';
  sched._store.set(SCHED_AFTER_PAST, {
    sessionId: SCHED_SESSION,
    record: { id: SCHED_AFTER_PAST, kind: 'after', title: '过期的延迟任务', prompt: 'retry-me', afterSeconds: 120, scheduledAt: new Date(Date.now() - 60_000).toISOString() },
    status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
  });
  sched._store.set(SCHED_AT_PAST, {
    sessionId: SCHED_SESSION,
    record: { id: SCHED_AT_PAST, kind: 'at', title: '过期的定时任务', prompt: 'gone', scheduledAt: new Date(Date.now() - 60_000).toISOString() },
    status: 'inactive', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
  });
  const delAfterPast = await handler(invocation('sched del 3333', ID_LIVE));
  check('过期的 after 任务可删除入站', delAfterPast.kind === 'success' && delAfterPast.text.includes('定时任务已移入回收站'), delAfterPast.text?.slice(0, 140));
  const restoreAfterPast = await handler(invocation('sched restore 3333', ID_LIVE));
  check('过期的 after 按原 after_seconds 重新武装', restoreAfterPast.kind === 'success'
    && [...sched._store.values()].some((task) => task.record.kind === 'after' && task.record.afterSeconds === 120 && task.record.prompt === 'retry-me'), restoreAfterPast.text?.slice(0, 160));
  const delAtPast = await handler(invocation('sched del 4444', ID_LIVE));
  const restoreAtPast = await handler(invocation('sched restore 4444', ID_LIVE));
  check('过期的 at 恢复被拒绝且条目保留', restoreAtPast.kind === 'error' && restoreAtPast.text.includes('目标时间已过')
    && (await trashEntryDirs(config.trashRoot)).some((n) => /-sched-44445555/.test(n)), restoreAtPast.text?.slice(0, 160));
  const schedWipePast = await handler(invocation(`sched wipe 4444 confirm`, ID_LIVE));
  check('sched wipe 彻底清除过期条目', schedWipePast.kind === 'success' && schedWipePast.text.includes('已彻底删除'), schedWipePast.text?.slice(0, 140));

  console.log('T20 schedule-delete 路由（参数校验/未找到/成功）');
  const sdBad = fakeRes();
  await scheduleDeleteRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.schedule-delete', JSON.stringify({})), sdBad);
  check('缺 id 返回 400', sdBad.statusCode === 400);
  const sdMiss = fakeRes();
  await scheduleDeleteRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.schedule-delete', JSON.stringify({ id: 'schedule-absent' })), sdMiss);
  check('不存在的任务返回 404', sdMiss.statusCode === 404, sdMiss.body);
  const sdDaily = fakeRes();
  await scheduleDeleteRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.schedule-delete', JSON.stringify({ id: SCHED_DAILY })), sdDaily);
  const sdDailyPayload = JSON.parse(sdDaily.body ?? '{}');
  check('POST 删除成功并回显 entryName', sdDaily.statusCode === 200 && sdDailyPayload.ok === true && /-sched-22223333/.test(sdDailyPayload.entryName ?? ''), sdDaily.body);
  check('daily 任务入回收站且服务已删', !sched._store.has(SCHED_DAILY));
  const sdDailyEntry = sdDailyPayload.entryName;
  const restoreDaily = fakeRes();
  await restoreRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.restore', JSON.stringify({ entryName: sdDailyEntry })), restoreDaily);
  const restoreDailyPayload = JSON.parse(restoreDaily.body ?? '{}');
  check('restore 路由按类型分派恢复 daily（返回 type/newId）', restoreDaily.statusCode === 200 && restoreDailyPayload.ok === true
    && restoreDailyPayload.type === 'schedule' && typeof restoreDailyPayload.newId === 'string' && restoreDailyPayload.newId !== SCHED_DAILY, restoreDaily.body);
  check('daily 任务按原规则重建（time/timeZone 保留）', [...sched._store.values()].some((task) => task.record.kind === 'daily'
    && task.record.time === '09:00:00.000' && task.record.timeZone === 'Asia/Shanghai'), JSON.stringify([...sched._store.values()]));

  console.log('T21 schedule 服务不可用时的降级');
  ctx.schedule = undefined;
  const unavailRes = fakeRes();
  await schedulesRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.schedules', '{}'), unavailRes);
  const unavailPayload = JSON.parse(unavailRes.body ?? '{}');
  check('schedules 路由如实报告 available:false', unavailRes.statusCode === 200 && unavailPayload.ok === true && unavailPayload.available === false, unavailRes.body);
  const unavailDel = fakeRes();
  await scheduleDeleteRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.schedule-delete', JSON.stringify({ id: SCHED_AT })), unavailDel);
  check('删除路由在服务不可用时返回 409', unavailDel.statusCode === 409, unavailDel.body);
  const unavailCmd = await handler(invocation('sched list', ID_LIVE));
  check('sched 命令在服务不可用时给出可读错误', unavailCmd.kind === 'error' && unavailCmd.text.includes('未启用自动化任务'), unavailCmd.text?.slice(0, 140));
  const sessDelOk = fakeRes();
  await deleteRoute.handler(fakeReq('POST', '/dsh-session-recycle-bin.delete', JSON.stringify({ sessionId: ID_OLD })), sessDelOk);
  const sessDelOkPayload = JSON.parse(sessDelOk.body ?? '{}');
  check('schedule 服务不可用不影响会话删除管线', sessDelOk.statusCode === 200 && sessDelOkPayload.ok === true
    && Array.isArray(sessDelOkPayload.deleted) && sessDelOkPayload.deleted.includes(ID_OLD), sessDelOk.body);

  // 清理
  await rm(root, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
