/**
 * dsh-session-recycle-bin 浏览器半侧的离线行为测试（不需要 DSH / 浏览器）。
 *
 * 用桩替换平台 seed（react / primitives / client-store）与 `window.__ModuleLoader__`，
 * 执行 lib/client.js 的 bundle，抓取插件 exports，再用桩 ctx 驱动 apply()，
 * 验证 slot 注册与删除 / 回收站面板（列表、恢复、彻底清除、清空）的完整调用链。
 *
 * 运行：node test/client-harness.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

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

/** 极简快照 store（对齐 @deepseek-ai/dsh-client-store 的用到的面）。 */
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

/** 平台 seed 桩：只提供 bundle require 到的键。 */
function makeSeed() {
  const jsx = (type, props) => ({ $$stub: 'jsx', type, props });
  return new Map(Object.entries({
    'react': {
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useMemo: (fn) => fn(),
      useRef: (init) => ({ current: init }),
      useEffect: () => {},
      useLayoutEffect: () => {},
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: '$Fragment' },
    '@deepseek-ai/dsh-client-ui-primitives': {
      MenuItemButton: '$MenuItemButton',
      Tooltip: '$Tooltip',
      Modal: '$Modal',
      Button: '$Button',
      IconTrashOutlineRegular: '$IconTrash',
      useDismissOnOutsidePointer: () => {},
    },
    '@deepseek-ai/dsh-client-store': { createSnapshotStore },
  }));
}

/** 加载 bundle 并物化 exports（模拟 shell 的 factory 注册 + materialize）。 */
const reloadCalls = [];
function loadClientBundle() {
  const file = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'lib', 'client.js');
  const code = readFileSync(file, 'utf8');
  const captured = [];
  const windowStub = {
    __ModuleLoader__: { load: (def) => captured.push(def) },
    location: { reload: () => reloadCalls.push(1) },
  };
  new Function('window', code)(windowStub);
  if (captured.length !== 1) throw new Error(`bundle 应只 load 一次，实际 ${captured.length}`);
  const def = captured[0];
  const seed = makeSeed();
  const cache = new Map();
  const requireStub = (spec) => {
    if (seed.has(spec)) return seed.get(spec);
    if (cache.has(spec)) return cache.get(spec);
    throw new Error(`bundle require 了不在平台 seed 的模块：${spec}（需要加入 dsh.client.external 或改用平台件）`);
  };
  const exports = def.factory(requireStub);
  return { id: def.id, exports };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 构造一条合法形状的回收站条目（entryName = <毫秒时间戳>-<会话id>）。 */
function makeTrashEntry(n) {
  const id = `session-xxxx${n}-1111-4bbb-8ccc-00000000000${n}`;
  return {
    entryName: `1700000000000-${id}`,
    id,
    trashedAt: 1700000000000 + n,
    title: `旧会话${n}`,
    cwd: 'C:\\demo',
  };
}

function main() {
  console.log('C0 bundle 契约');
  const { id, exports } = loadClientBundle();
  check('bundle id 等于包名（插件 bundle 即其客户端半侧）', id === 'dsh-session-recycle-bin');
  check('导出 apply 与 inject', typeof exports.apply === 'function' && Array.isArray(exports.inject));
  check('context 服务注入：slots/sessions/locale', ['slots', 'sessions', 'locale'].every((name) => exports.inject.includes(name)));
  check('不再注入 remote（删除走 webServer 路由，避免 without inject 一类运行时错误）', !exports.inject.some((name) => name.startsWith('remote')));
  check('不注入多余的服务（保持最小依赖）', exports.inject.length === 3);

  console.log('C1 apply 注册');
  const registeredLocales = [];
  const slotInjects = [];
  const registeredSlots = [];

  const sessionsList = createSnapshotStore({
    ids: ['session-A', 'session-B'],
    byId: {
      'session-A': { id: 'session-A', displayTitle: '当前会话', retainedBy: { mainView: 1 } },
      'session-B': { id: 'session-B', displayTitle: '要删的会话', retainedBy: {} },
    },
  });
  const sessions = { list: sessionsList };
  const localeDicts = {};

  /** 操作时序：删当前会话必须「先导航、后删除」——用同一个钟给两种调用打点。 */
  let opClock = 0;
  const navCalls = { openSession: [], startSession: [] };

  /** 把主视图保留计数整体搬到 targetId（模拟 replaceMain 的 release + retain）。 */
  const moveMainView = (targetId) => {
    const snapshot = sessionsList.getSnapshot();
    const byId = {};
    for (const [key, row] of Object.entries(snapshot.byId)) {
      const { mainView: _drop, ...rest } = row.retainedBy ?? {};
      byId[key] = { ...row, retainedBy: key === targetId ? { ...rest, mainView: 1 } : rest };
    }
    sessionsList.set({ ...snapshot, byId });
  };

  /** uiWorkspace 服务桩；可用例里替换/置空，验证服务缺失时的降级。 */
  let navService = {
    openSession(id) {
      navCalls.openSession.push({ id, at: ++opClock });
      moveMainView(id);
    },
    startSession() {
      navCalls.startSession.push({ at: ++opClock });
      const snapshot = sessionsList.getSnapshot();
      const byId = {};
      for (const [key, row] of Object.entries(snapshot.byId)) {
        const { mainView: _drop, ...rest } = row.retainedBy ?? {};
        byId[key] = { ...row, retainedBy: rest };
      }
      byId['session-NEW'] = { id: 'session-NEW', displayTitle: '新会话', retainedBy: { mainView: 1 } };
      sessionsList.set({ ids: ['session-NEW', ...(snapshot.ids ?? [])], byId });
    },
  };
  /** workspaces 服务桩：只用于判定“同工作区”。 */
  let workspacesService = {
    list: {
      getSnapshot: () => ({
        items: [{ workspaceId: 'ws-1', sessionIds: ['session-A', 'session-B'] }],
        archivedSessionIds: [],
      }),
    },
  };

  const ctx = {
    get(name) {
      if (name === 'sessions') return sessions;
      if (name === 'locale') return ctx.locale;
      if (name === 'uiWorkspace') return navService;
      if (name === 'workspaces') return workspacesService;
      throw new Error(`未预期的服务注入：${name}`);
    },
    locale: {
      bind: (ns) => (key, params) => {
        const dict = localeDicts[ns]?.zh ?? {};
        let text = dict[key] ?? key;
        for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v));
        return text;
      },
      register: (ns, dict) => {
        localeDicts[ns] = dict;
        registeredLocales.push(ns);
        return () => {};
      },
    },
    slots: {
      inject: (name, factory) => slotInjects.push({ name, factory }),
      register: (entry, component) => {
        registeredSlots.push({ entry, component });
        return Promise.resolve(() => {});
      },
    },
    effect(body, label) {
      void label;
      const iterable = typeof body === 'function' ? body() : body;
      if (iterable && typeof iterable[Symbol.iterator] === 'function') {
        for (const step of iterable) { /* 同步注册，无需等待 */ }
      }
    },
  };

  // fetch 桩：按路由分派，模拟宿主 webServer 的 6 条 JSON POST 路由
  const fetchCalls = [];
  let trashEntries = [makeTrashEntry(1), makeTrashEntry(2)];
  let scheduleTasks = [
    {
      id: 'schedule-aaaa1111-2222-4bbb-8ccc-000000000001',
      sessionId: 'session-B',
      title: '每日站会',
      prompt: 'standup',
      kind: 'daily',
      status: 'active',
      scheduledAt: Date.now() + 3_600_000,
    },
  ];
  let restorePayload = () => ({ ok: true, id: 'session-xxxx1-1111-4bbb-8ccc-000000000001' });
  let wipePayload = () => ({ ok: true, purged: 1, failed: 0 });
  const okJson = (payload) => ({ status: 200, ok: true, json: async () => payload });

  /** 安装「一切正常」的路由感知桩（各用例段会反复重装以覆盖失败桩）。 */
  const installGoodFetch = () => {
    globalThis.fetch = async (url, init) => {
      const route = String(url);
      fetchCalls.push({ url: route, init: init ?? {}, at: ++opClock });
      // 注意顺序：.schedule-delete / .schedules 必须先于 .delete 判定（前两者包含 .delete 子串）
      if (route.includes('.schedule-delete')) return okJson({ ok: true, id: JSON.parse(init.body).id, entryName: '1700000000000-sched-fake' });
      if (route.includes('.schedules')) return okJson({ ok: true, available: true, tasks: scheduleTasks });
      if (route.includes('.trash')) return okJson({ ok: true, retentionDays: 30, entries: trashEntries });
      if (route.includes('.delete')) return okJson({ ok: true, deleted: [JSON.parse(init.body).sessionId], warnings: [] });
      if (route.includes('.restore')) {
        const payload = restorePayload();
        if (payload.ok !== true) return { status: 409, ok: false, json: async () => payload };
        return okJson(payload);
      }
      if (route.includes('.wipe')) {
        const payload = wipePayload();
        if (payload.ok !== true) return { status: 409, ok: false, json: async () => payload };
        return okJson(payload);
      }
      return { status: 404, ok: false, json: async () => ({ ok: false, error: 'no route' }) };
    };
  };
  installGoodFetch();

  exports.apply(ctx);
  check('注册了一个 locale 词典', registeredLocales.length === 1 && registeredLocales[0] === 'session-recycle-bin');
  check('注入了 4 个 slot 贡献', slotInjects.length === 4, JSON.stringify(slotInjects.map((s) => s.name)));
  const names = slotInjects.map((s) => s.name).sort().join('|');
  check('slot 名正确（菜单/行按钮/overlay/底部座位）', names === 'shell.overlay|sidebar.footer.action|sidebar.workspaces.session.menu.item|sidebar.workspaces.session.row.action', names);

  (async () => {
    // 驱动每个贡献工厂（生成器 yield 注册 promise）
    for (const { factory } of slotInjects) {
      const iterable = factory();
      for (const step of iterable) {
        if (step) await step;
      }
    }

    console.log('C2 slot 注册明细');
    check('注册了 4 个条目', registeredSlots.length === 4, String(registeredSlots.length));
    const menuItem = registeredSlots.find((r) => r.entry.name === 'sidebar.workspaces.session.menu.item');
    const rowAction = registeredSlots.find((r) => r.entry.name === 'sidebar.workspaces.session.row.action');
    const overlay = registeredSlots.find((r) => r.entry.name === 'shell.overlay');
    const footerSeat = registeredSlots.find((r) => r.entry.name === 'sidebar.footer.action');
    check('菜单项 id=recycle-bin-delete order=455（归档 400 之下，且避开第一方 session-id 的 450）', menuItem && menuItem.entry.id === 'recycle-bin-delete' && menuItem.entry.order === 455);
    check('行按钮 id=recycle-bin-delete order=150（紧挨归档 100）', rowAction && rowAction.entry.id === 'recycle-bin-delete' && rowAction.entry.order === 150);
    check('overlay 确认框 id=session-recycle-bin.confirm', overlay && overlay.entry.id === 'session-recycle-bin.confirm');
    check('底部座位 id=recycle-bin-panel', footerSeat && footerSeat.entry.id === 'recycle-bin-panel');
    check('菜单/行按钮/座位 locale 绑定插件词典', [menuItem, rowAction, footerSeat].every((slot) => slot?.entry.locale === 'session-recycle-bin'));

    console.log('C3 注入面');
    const menuInjects = menuItem.entry.inject();
    check('菜单条目注入 requestDelete 回调', typeof menuInjects.requestDelete === 'function');
    const overlayInjects = overlay.entry.inject();
    check('overlay 注入 hooks.request / settle / runConfirm', typeof overlayInjects.settle === 'function' && typeof overlayInjects.runConfirm === 'function' && typeof overlayInjects.hooks?.request?.getSnapshot === 'function');
    check('overlay 不再提供刷新提示通道（删当前会话改为先切走，不刷新）', overlayInjects.hooks?.reload === undefined);
    const footerInjects = footerSeat.entry.inject();
    check('座位注入 hooks.trash/schedules / refresh/refreshSchedules / requestWipe / requestWipeAll / doRestore / requestSchedDelete',
      typeof footerInjects.hooks?.trash?.getSnapshot === 'function'
      && typeof footerInjects.hooks?.schedules?.getSnapshot === 'function'
      && typeof footerInjects.refresh === 'function'
      && typeof footerInjects.refreshSchedules === 'function'
      && typeof footerInjects.requestWipe === 'function'
      && typeof footerInjects.requestWipeAll === 'function'
      && typeof footerInjects.doRestore === 'function'
      && typeof footerInjects.requestSchedDelete === 'function');

    console.log('C4 启动读取 + 删除调用链');
    await tick();
    await tick();
    const trashCalls = fetchCalls.filter((call) => call.url.includes('.trash'));
    check('apply 启动时拉取一次回收站列表（徽标数据源）', trashCalls.length === 1 && trashCalls[0].init.method === 'POST', JSON.stringify(fetchCalls.map((c) => c.url)));
    const initialTrash = footerInjects.hooks.trash.getSnapshot();
    check('启动读取结果就绪（read / entries / retentionDays）', initialTrash.read === true && initialTrash.error === null && initialTrash.entries.length === 2 && initialTrash.retentionDays === 30, JSON.stringify(initialTrash));

    check('确认请求初始为空', overlayInjects.hooks.request.getSnapshot() === null);
    menuInjects.requestDelete('session-B');
    const request = overlayInjects.hooks.request.getSnapshot();
    check('requestDelete 记录会话与标题', request && request.sessionId === 'session-B' && request.title === '要删的会话');

    await overlayInjects.runConfirm(request);
    const deleteCalls = fetchCalls.filter((call) => call.url.includes('.delete'));
    check('runConfirm POST 宿主删除路由（origin 绝对路径）', deleteCalls.length === 1 && deleteCalls[0].url === '/dsh-session-recycle-bin.delete');
    check('请求体携带目标会话 id', deleteCalls[0].init.method === 'POST' && JSON.parse(deleteCalls[0].init.body).sessionId === 'session-B');
    await tick();
    await tick();
    check('删除成功后回收站计数自动刷新', fetchCalls.filter((call) => call.url.includes('.trash')).length === 2);
    check('删除非当前会话不触发本窗口刷新', reloadCalls.length === 0, JSON.stringify(reloadCalls));

    // 路由返回 ok:false（宿主拒绝）
    globalThis.fetch = async () => ({ status: 409, ok: false, json: async () => ({ ok: false, error: '会话仍有运行中的工作' }) });
    let threw = null;
    try { await overlayInjects.runConfirm({ sessionId: 'session-B' }); } catch (error) { threw = error; }
    check('宿主拒绝翻成本地化错误', threw !== null && threw.message.includes('会话仍有运行中的工作'));

    // HTTP 失败且无 JSON
    globalThis.fetch = async () => ({ status: 500, ok: false, json: async () => { throw new Error('not json'); } });
    threw = null;
    try { await overlayInjects.runConfirm({ sessionId: 'session-B' }); } catch (error) { threw = error; }
    check('HTTP 500 给出可读错误', threw !== null && threw.message.includes('HTTP 500'));

    // 网络异常
    globalThis.fetch = async () => { throw new Error('连接中断'); };
    threw = null;
    try { await overlayInjects.runConfirm({ sessionId: 'session-B' }); } catch (error) { threw = error; }
    check('网络异常翻成本地化错误', threw !== null && threw.message.includes('连接中断'));

    // 删除当前会话：先把主视图切到别的会话，再删；全程不刷新窗口
    installGoodFetch();
    navCalls.openSession.length = 0;
    navCalls.startSession.length = 0;
    menuInjects.requestDelete('session-A');
    const currentRequest = overlayInjects.hooks.request.getSnapshot();
    check('当前会话的确认请求携带 isCurrent 标记', currentRequest && currentRequest.sessionId === 'session-A' && currentRequest.isCurrent === true, JSON.stringify(currentRequest));
    const reloadsBefore = reloadCalls.length;
    await overlayInjects.runConfirm(currentRequest);
    const currentDeleteCalls = fetchCalls.filter((call) => call.url.includes('.delete') && JSON.parse(call.init.body).sessionId === 'session-A');
    check('当前会话删除放行并 POST 删除路由', currentDeleteCalls.length === 1, JSON.stringify(fetchCalls.map((c) => c.url)));
    check('删当前会话先 openSession 切到另一个会话（同工作区优先）', navCalls.openSession.length === 1 && navCalls.openSession[0].id === 'session-B', JSON.stringify(navCalls.openSession));
    check('导航先于删除 POST（先切走，再摘行）', navCalls.openSession[0].at < currentDeleteCalls[0].at, `${navCalls.openSession[0].at} vs ${currentDeleteCalls[0].at}`);
    check('切走后主视图不再停留在待删会话上', sessionsList.getSnapshot().byId['session-A'].retainedBy.mainView === undefined, JSON.stringify(sessionsList.getSnapshot().byId['session-A'].retainedBy));
    check('删当前会话不再刷新窗口（reload 调用数不变）', reloadCalls.length === reloadsBefore, JSON.stringify(reloadCalls));
    check('列表里还有别的会话时不新建会话', navCalls.startSession.length === 0);

    // 删当前会话：列表里没有别的会话 → 走官方 startSession 新建一个并导航，然后才删
    installGoodFetch();
    sessionsList.set({
      ids: ['session-A'],
      byId: { 'session-A': { id: 'session-A', displayTitle: '唯一会话', retainedBy: { mainView: 1 } } },
    });
    navCalls.openSession.length = 0;
    navCalls.startSession.length = 0;
    const startCursor = fetchCalls.length;
    await overlayInjects.runConfirm({ seq: 90, sessionId: 'session-A', title: '唯一会话', isCurrent: true });
    const startDeleteCalls = fetchCalls.slice(startCursor).filter((call) => call.url.includes('.delete') && JSON.parse(call.init.body).sessionId === 'session-A');
    check('没有别的会话时走官方 startSession 新建并导航', navCalls.startSession.length === 1 && navCalls.openSession.length === 0, JSON.stringify(navCalls));
    check('新建导航同样先于删除 POST', startDeleteCalls.length === 1 && navCalls.startSession[0].at < startDeleteCalls[0].at);
    const mainRow = Object.values(sessionsList.getSnapshot().byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0);
    check('新建后主视图落在新会话上（不再是待删会话）', mainRow?.id === 'session-NEW', JSON.stringify(mainRow));
    check('这条路径也不刷新窗口', reloadCalls.length === reloadsBefore);

    // 拿不到会话导航服务 → 取消删除（宁可不删，也不刷新、不把窗口留在死会话）
    installGoodFetch();
    sessionsList.set({
      ids: ['session-A', 'session-B'],
      byId: {
        'session-A': { id: 'session-A', displayTitle: '当前会话', retainedBy: { mainView: 1 } },
        'session-B': { id: 'session-B', displayTitle: '别的会话', retainedBy: {} },
      },
    });
    const navBackup = navService;
    navService = undefined;
    let navThrew = null;
    const navCursor = fetchCalls.length;
    try { await overlayInjects.runConfirm({ seq: 91, sessionId: 'session-A', title: '当前会话', isCurrent: true }); } catch (error) { navThrew = error; }
    navService = navBackup;
    check('拿不到导航服务时取消删除并给出可读提示', navThrew !== null && navThrew.message.includes('删除已取消'), navThrew?.message ?? '');
    check('取消删除后没有发出任何删除请求', fetchCalls.slice(navCursor).every((call) => !call.url.includes('.delete')), JSON.stringify(fetchCalls.slice(navCursor).map((c) => c.url)));
    check('取消删除也不刷新窗口', reloadCalls.length === reloadsBefore);

    // workspaces 服务缺失 → 退回 cwd / 列表顺序兜底，仍然能切走
    const workspacesBackup = workspacesService;
    workspacesService = undefined;
    navCalls.openSession.length = 0;
    await overlayInjects.runConfirm({ seq: 92, sessionId: 'session-A', title: '当前会话', isCurrent: true });
    check('缺少工作区服务时仍按列表顺序切走', navCalls.openSession.length === 1 && navCalls.openSession[0].id === 'session-B', JSON.stringify(navCalls.openSession));
    workspacesService = workspacesBackup;

    // 归档会话优先跳过：候选里 B 已归档、C 可用 → 切 C（归档行在侧边栏本来就藏着）
    installGoodFetch();
    sessionsList.set({
      ids: ['session-A', 'session-B', 'session-C'],
      byId: {
        'session-A': { id: 'session-A', displayTitle: '当前会话', retainedBy: { mainView: 1 } },
        'session-B': { id: 'session-B', displayTitle: '已归档', retainedBy: {} },
        'session-C': { id: 'session-C', displayTitle: '可用会话', retainedBy: {} },
      },
    });
    workspacesService = {
      list: {
        getSnapshot: () => ({
          items: [{ workspaceId: 'ws-1', sessionIds: ['session-A', 'session-B', 'session-C'] }],
          archivedSessionIds: ['session-B'],
        }),
      },
    };
    navCalls.openSession.length = 0;
    await overlayInjects.runConfirm({ seq: 93, sessionId: 'session-A', title: '当前会话', isCurrent: true });
    check('候选里的已归档会话被跳过', navCalls.openSession.length === 1 && navCalls.openSession[0].id === 'session-C', JSON.stringify(navCalls.openSession));
    workspacesService = workspacesBackup;

    console.log('C5 彻底清除单条（确认流）');
    installGoodFetch();
    const entry = trashEntries[0];
    footerInjects.requestWipe(entry);
    const wipeRequest = overlayInjects.hooks.request.getSnapshot();
    check('requestWipe 记录 kind/entryName/标题', wipeRequest && wipeRequest.kind === 'wipe' && wipeRequest.entryName === entry.entryName && wipeRequest.title === entry.title);
    await overlayInjects.runConfirm(wipeRequest);
    const wipeCalls = fetchCalls.filter((call) => call.url.includes('.wipe'));
    check('runConfirm POST wipe 路由且显式 confirm', wipeCalls.length === 1 && JSON.parse(wipeCalls[0].init.body).target === entry.entryName && JSON.parse(wipeCalls[0].init.body).confirm === true);

    // wipe 失败：宿主错误原样透传并包本地化前缀
    globalThis.fetch = async () => ({ status: 409, ok: false, json: async () => ({ ok: false, error: '条目被占用' }) });
    threw = null;
    try { await overlayInjects.runConfirm(wipeRequest); } catch (error) { threw = error; }
    check('wipe 失败翻成本地化错误', threw !== null && threw.message.includes('彻底删除失败') && threw.message.includes('条目被占用'));

    console.log('C6 清空回收站（确认流）');
    installGoodFetch();
    trashEntries = [makeTrashEntry(1), makeTrashEntry(2), makeTrashEntry(3)];
    await footerInjects.refresh();
    await tick();
    footerInjects.requestWipeAll();
    const wipeAllRequest = overlayInjects.hooks.request.getSnapshot();
    check('requestWipeAll 携带当前条目数', wipeAllRequest && wipeAllRequest.kind === 'wipe-all' && wipeAllRequest.count === 3);
    await overlayInjects.runConfirm(wipeAllRequest);
    const wipeAllCalls = fetchCalls.filter((call) => call.url.includes('.wipe') && JSON.parse(call.init.body ?? '{}').target === 'all');
    check('清空 POST target=all 且显式 confirm', wipeAllCalls.length === 1 && JSON.parse(wipeAllCalls[0].init.body).confirm === true);

    // 部分失败：留在确认框中报错
    globalThis.fetch = async () => okJson({ ok: true, purged: 2, failed: 1 });
    threw = null;
    try { await overlayInjects.runConfirm(wipeAllRequest); } catch (error) { threw = error; }
    check('部分失败给出计数错误', threw !== null && threw.message.includes('2 个条目') && threw.message.includes('1 个失败'));

    console.log('C7 恢复（行内操作）');
    globalThis.fetch = async (url, init) => {
      const route = String(url);
      fetchCalls.push({ url: route, init: init ?? {} });
      if (route.includes('.restore')) return okJson({ ok: true, id: entry.id });
      return okJson({ ok: true, retentionDays: 30, entries: trashEntries });
    };
    await footerInjects.doRestore(entry.entryName);
    const restoreCalls = fetchCalls.filter((call) => call.url.includes('.restore'));
    check('doRestore POST restore 路由', restoreCalls.length === 1 && JSON.parse(restoreCalls[0].init.body).entryName === entry.entryName);
    globalThis.fetch = async () => ({ status: 409, ok: false, json: async () => ({ ok: false, error: '原位置已存在同名会话目录，恢复取消。' }) });
    threw = null;
    try { await footerInjects.doRestore(entry.entryName); } catch (error) { threw = error; }
    check('恢复失败翻成本地化错误', threw !== null && threw.message.includes('恢复失败') && threw.message.includes('原位置已存在'));

    console.log('C8 读取失败态（徽标降级）');
    globalThis.fetch = async () => { throw new Error('连接中断'); };
    await footerInjects.refresh();
    await tick();
    const errored = footerInjects.hooks.trash.getSnapshot();
    check('读取失败落进 error 且清空 entries（徽标归零）', errored.read === true && errored.error !== null && errored.error.includes('连接中断') && errored.entries.length === 0, JSON.stringify(errored));

    console.log('C9 定时任务页签（v1.4.0：列表/删除/恢复回执）');
    installGoodFetch();
    await footerInjects.refreshSchedules();
    await tick();
    const schedState = footerInjects.hooks.schedules.getSnapshot();
    check('refreshSchedules 读取任务列表', schedState.read === true && schedState.available === true && schedState.tasks.length === 1
      && schedState.tasks[0].id === 'schedule-aaaa1111-2222-4bbb-8ccc-000000000001' && schedState.tasks[0].title === '每日站会', JSON.stringify(schedState));
    footerInjects.requestSchedDelete(schedState.tasks[0]);
    const schedRequest = overlayInjects.hooks.request.getSnapshot();
    check('requestSchedDelete 设置 kind/taskId/标题', schedRequest && schedRequest.kind === 'sched-delete'
      && schedRequest.taskId === 'schedule-aaaa1111-2222-4bbb-8ccc-000000000001' && schedRequest.title === '每日站会', JSON.stringify(schedRequest));
    const schedDelCursor = fetchCalls.length;
    await overlayInjects.runConfirm(schedRequest);
    const schedDelCalls = fetchCalls.slice(schedDelCursor).filter((call) => call.url.includes('.schedule-delete'));
    check('runConfirm POST schedule-delete 路由且带任务 id', schedDelCalls.length === 1
      && JSON.parse(schedDelCalls[0].init.body).id === 'schedule-aaaa1111-2222-4bbb-8ccc-000000000001', JSON.stringify(fetchCalls.slice(schedDelCursor).map((c) => c.url)));
    await tick();
    await tick();
    check('定时任务删除后回收站与任务列表双双刷新', fetchCalls.slice(schedDelCursor).some((c) => c.url.includes('.trash'))
      && fetchCalls.slice(schedDelCursor).some((c) => c.url.includes('.schedules')));

    // 定时任务删除失败透传
    globalThis.fetch = async () => ({ status: 409, ok: false, json: async () => ({ ok: false, error: '宿主拒绝删除' }) });
    threw = null;
    try { await overlayInjects.runConfirm(schedRequest); } catch (error) { threw = error; }
    check('定时任务删除失败翻成本地化错误', threw !== null && threw.message.includes('删除失败') && threw.message.includes('宿主拒绝删除'));

    // schedules 读取失败 → error 态
    globalThis.fetch = async (url) => {
      const route = String(url);
      if (route.includes('.schedules')) throw new Error('连接中断');
      return okJson({ ok: true, retentionDays: 30, entries: trashEntries });
    };
    await footerInjects.refreshSchedules();
    await tick();
    const schedErr = footerInjects.hooks.schedules.getSnapshot();
    check('schedules 读取失败落进 error', schedErr.read === true && schedErr.error !== null && schedErr.error.includes('连接中断'), JSON.stringify(schedErr));

    // 定时任务条目的恢复调用链（宿主返回 type:schedule + newId）
    installGoodFetch();
    globalThis.fetch = async (url, init) => {
      const route = String(url);
      fetchCalls.push({ url: route, init: init ?? {} });
      if (route.includes('.restore')) return okJson({ ok: true, type: 'schedule', id: 'schedule-old', newId: 'schedule-new9', title: '每日站会' });
      return okJson({ ok: true, retentionDays: 30, entries: trashEntries });
    };
    const schedEntry = {
      entryName: '1700000000000-sched-aaaa1111',
      type: 'schedule',
      id: 'schedule-old',
      trashedAt: 1700000000000,
      title: '每日站会',
      sessionId: 'session-B',
    };
    const schedRestoreCursor = fetchCalls.length;
    await footerInjects.doRestore(schedEntry.entryName);
    const schedRestoreCalls = fetchCalls.slice(schedRestoreCursor).filter((call) => call.url.includes('.restore'));
    check('定时任务条目恢复 POST restore 路由（同一入口，宿主按类型分派）', schedRestoreCalls.length === 1
      && JSON.parse(schedRestoreCalls[0].init.body).entryName === schedEntry.entryName);

    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exitCode = failed > 0 ? 1 : 0;
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

main();
