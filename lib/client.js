window.__ModuleLoader__.load({
	id: "dsh-session-recycle-bin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		// react-dom 只为一件事：把弹层 portal 到 document.body（与 dsh-auto-memory
		// 的浮窗同款做法）。弹层若留在侧边栏列内，会被侧边栏自己的层叠上下文
		// （sidebarCol = position:relative + z-index:0）困住：整块侧边栏都画在
		// 「会话正文列」下面，于是超出侧边栏宽度的那半面板（恢复/彻底清除按钮
		// 就在那一半）被正文层截走点击 —— 按钮看得见、点不动，界面毫无异常
		// （2026-10-22 实测：命中栈顶是 wSkVaW_scrollBody/_body/_root）。
		// 拿不到 react-dom 时降级为就地渲染：功能不丢，窄侧边栏下仍可用。
		let react_dom = null;
		try { react_dom = require("react-dom") ?? null; } catch (eReactDom) { react_dom = null; }
		//#region lib/types/client/index.js
		/**
		 * dsh-session-recycle-bin 的浏览器半侧：
		 *
		 *   1. 删除入口：会话行菜单与悬停按钮（归档旁边）里的「删除（进回收站）」，
		 *      点击后弹确认框，确认即调用宿主插件的删除路由；
		 *   2. 回收站面板：侧边栏底部（sidebar.footer.action）的回收站座位按钮，
		 *      带条目数徽标，点击向上弹出锚定面板——两个页签：「会话回收站」
		 *      （列表 + 每行恢复/彻底清除 + 头部「清空」）与「定时任务」（v1.4.0，
		 *      列出宿主自动化任务 + 行内删除，删除=移入回收站可恢复），
		 *      彻底清除与清空走 shell.overlay 确认框。
		 *
		 * 通道选择：不新增 Host Remote（远程装配是应用侧固化组合，第三方
		 * 插件不易扩展），也不走斜杠命令（依赖“当前会话”的 agent 存在，且
		 * 会污染命令日志），而是 POST 宿主 `webServer` 路由——浏览器相对
		 * 路径 fetch，`connection.requestRejection` 鉴权围栏与产品自身路由
		 * 一致。
		 *
		 * 删「当前正在看的会话」时先把主视图挪开再删，绝不整页刷新：刷新会
		 * 重跑 web boot，而桌面壳把「有客户端条目激活失败」判为致命错误
		 * （crash-*-web-boot.log + recovery 屏），别的插件一抖就整个应用崩
		 * （2026-10-17 02:59 实测：删当前会话 → 刷新 → 一个条目导入失败 →
		 * 壳判致命）。挪开走公开的 `uiWorkspace` 服务：有别的会话就
		 * openSession 切过去，没有就让官方 startSession 新建一个并导航；
		 * 挪不动就取消删除并提示先手动切换——宁可不删，也不刷新。
		 *
		 * 面板布局采用第一方 CordisPanel（sidebar.footer.action 的现有使用者）
		 * 的同款做法：座位按钮 + fixed 锚定弹层（getBoundingClientRect 定位、
		 * resize 重算、外点/Escape 关闭）；样式只引用 `--dsw-alias-*` 主题 token。
		 *
		 * @module dsh-session-recycle-bin/client
		 */
		const NS = "session-recycle-bin";
		// 带前导斜杠（origin 绝对路径）：宿主注册的就是这些绝对路径。此前写的是
		// 相对路径，只有 GUI 挂在站点根目录（new URL 相对解析回根）时才对得上，
		// 一旦 DSH 被挂到子路径就会 POST 到错地址、落进 SPA 回退页。
		const ROUTE_DELETE = "/dsh-session-recycle-bin.delete";
		const ROUTE_TRASH = "/dsh-session-recycle-bin.trash";
		const ROUTE_RESTORE = "/dsh-session-recycle-bin.restore";
		const ROUTE_WIPE = "/dsh-session-recycle-bin.wipe";
		const ROUTE_SCHEDULES = "/dsh-session-recycle-bin.schedules";
		const ROUTE_SCHEDULE_DELETE = "/dsh-session-recycle-bin.schedule-delete";
		/** 删当前会话前「离开该会话」的落定轮询间隔与超时（导航是异步落定的）。 */
		const LEAVE_POLL_MS = 60;
		const LEAVE_TIMEOUT_MS = 3000;
		/** 简单延时（导航落定轮询用）。 */
		const delay = (ms) => new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
		// 客户端只依赖三个服务；所有操作走宿主 webServer 路由（浏览器相对路径
		// fetch，connection 鉴权围栏），与命令通道互不依赖——因此没有打开
		// 的会话也能操作，且不会在任何会话日志里记录命令事件。
		const inject = ["slots", "sessions", "locale"];

		const zh = {
			"actions.delete": "删除",
			"menu.deleteSession": "删除会话（进回收站）",
			"confirm.title": "把会话移入回收站？",
			"confirm.desc": "会话「{title}」将从侧边栏移除并进入回收站（默认保留 30 天）。可在任意会话输入 /recycle 恢复或彻底清除。",
			"confirm.action": "移入回收站",
			"confirm.pending": "正在移入回收站…",
			"confirm.pendingCurrent": "正在切换会话并移入回收站…",
			"cancel": "取消",
			"close": "关闭",
			"deleteFailed": "删除失败：{message}",
			"confirm.currentNote": "这是当前正在对话的会话：本窗口会先切到另一个会话，再把它移入回收站。",
			"confirm.leaveUnavailable": "删除已取消：本窗口拿不到会话导航服务，请先切换到其它会话再删除。",
			"confirm.leaveFailed": "删除已取消：自动切换会话没有生效，请先手动切到其它会话再删除。",
			"trash.panel.aria": "回收站",
			"trash.panel.title": "回收站",
			"trash.panel.retention": "保留 {days} 天后自动彻底清除",
			"trash.panel.retention.off": "永不自动清理",
			"trash.panel.empty": "回收站为空",
			"trash.panel.loading": "正在读取回收站…",
			"trash.panel.readFailed": "读取回收站失败：{message}",
			"trash.panel.wipeAll": "清空",
			"trash.restore": "恢复",
			"trash.wipe": "彻底清除",
			"trash.row.untitled": "（无标题）",
			"trash.restoreFailed": "恢复失败：{message}",
			"trash.restoreDone": "已恢复「{title}」：会话已放回原位并挂回原工作区，可继续对话。",
			"trash.restoreUngrouped": "已恢复「{title}」：会话已放回原位，但未能挂回原工作区（{note}），暂留「未分组」；重启 DSH 后可按路径自动归组。",
			"trash.wipeFailed": "彻底删除失败：{message}",
			"trash.wipe.confirm.title": "彻底删除该条目？",
			"trash.wipe.confirm.desc": "会话「{title}」将从回收站永久删除，不可恢复。",
			"trash.wipe.confirm.action": "彻底删除",
			"trash.wipe.confirm.pending": "正在彻底删除…",
			"trash.wipeAll.confirm.title": "清空回收站？",
			"trash.wipeAll.count": "将彻底删除回收站全部 {count} 个条目（不可恢复）。",
			"trash.wipeAll.confirm.action": "清空",
			"trash.wipeAll.confirm.pending": "正在清空回收站…",
			"trash.wipeAll.partial": "已彻底删除 {purged} 个条目，{count} 个失败（可能被占用）。",
			"tab.sessions": "会话回收站",
			"tab.schedules": "定时任务",
			"sched.panel.empty": "没有定时任务",
			"sched.panel.unavailable": "宿主未启用自动化任务，无法管理定时任务。",
			"sched.panel.readFailed": "读取定时任务失败：{message}",
			"sched.kind.at": "一次性（定时）",
			"sched.kind.after": "一次性（延迟）",
			"sched.kind.every": "固定间隔",
			"sched.kind.daily": "每天",
			"sched.kind.weekly": "每周",
			"sched.kind.cron": "Cron",
			"sched.kind.unknown": "未知",
			"sched.status.active": "已开启",
			"sched.status.inactive": "已结束",
			"sched.status.unknown": "未知状态",
			"sched.row.session": "会话 {session}",
			"sched.delete": "删除",
			"sched.confirm.title": "删除该定时任务？",
			"sched.confirm.desc": "任务「{title}」将停止运行并移入回收站（默认保留 30 天），可在回收站面板恢复（重建后任务 id 会变）。",
			"sched.confirm.action": "移入回收站",
			"sched.confirm.pending": "正在移入回收站…",
			"sched.deleteFailed": "删除失败：{message}",
			"trash.row.scheduled": "定时任务",
			"trash.restoreDoneSched": "已恢复定时任务「{title}」：已按原规则重建（新 id：{newId}）。"
		};
		const en = {
			"actions.delete": "Delete",
			"menu.deleteSession": "Delete session (trash)",
			"confirm.title": "Move session to trash?",
			"confirm.desc": "Session \"{title}\" will be removed from the sidebar and moved to the trash (kept for 30 days by default). Type /recycle in any session to restore or purge.",
			"confirm.action": "Move to trash",
			"confirm.pending": "Moving to trash…",
			"confirm.pendingCurrent": "Switching session and moving to trash…",
			"cancel": "Cancel",
			"close": "Close",
			"deleteFailed": "Delete failed: {message}",
			"confirm.currentNote": "This is the session you are chatting in; this window switches to another session before moving it to the trash.",
			"confirm.leaveUnavailable": "Delete cancelled: this window has no session-navigation service; switch to another session first.",
			"confirm.leaveFailed": "Delete cancelled: switching away did not take effect; switch to another session manually first.",
			"trash.panel.aria": "Trash",
			"trash.panel.title": "Trash",
			"trash.panel.retention": "Auto-purged after {days} days",
			"trash.panel.retention.off": "Never auto-purged",
			"trash.panel.empty": "Trash is empty",
			"trash.panel.loading": "Loading trash…",
			"trash.panel.readFailed": "Failed to read trash: {message}",
			"trash.panel.wipeAll": "Empty",
			"trash.restore": "Restore",
			"trash.wipe": "Delete forever",
			"trash.row.untitled": "(untitled)",
			"trash.restoreFailed": "Restore failed: {message}",
			"trash.restoreDone": "Restored \"{title}\": the session is back in place, reattached to its original workspace, and ready to continue.",
			"trash.restoreUngrouped": "Restored \"{title}\": the session is back in place, but it could not be reattached to its original workspace ({note}); it stays under Ungrouped until DSH restarts and realigns it by path.",
			"trash.wipeFailed": "Delete forever failed: {message}",
			"trash.wipe.confirm.title": "Delete this entry forever?",
			"trash.wipe.confirm.desc": "Session \"{title}\" will be permanently deleted from the trash. This cannot be undone.",
			"trash.wipe.confirm.action": "Delete forever",
			"trash.wipe.confirm.pending": "Deleting forever…",
			"trash.wipeAll.confirm.title": "Empty the trash?",
			"trash.wipeAll.count": "This permanently deletes all {count} entries in the trash. This cannot be undone.",
			"trash.wipeAll.confirm.action": "Empty",
			"trash.wipeAll.confirm.pending": "Emptying the trash…",
			"trash.wipeAll.partial": "Deleted {purged} entries; {count} failed (possibly in use).",
			"tab.sessions": "Sessions trash",
			"tab.schedules": "Scheduled tasks",
			"sched.panel.empty": "No scheduled tasks",
			"sched.panel.unavailable": "Automation tasks are not enabled on the host; scheduled tasks cannot be managed.",
			"sched.panel.readFailed": "Failed to read scheduled tasks: {message}",
			"sched.kind.at": "One-shot (at)",
			"sched.kind.after": "One-shot (delay)",
			"sched.kind.every": "Interval",
			"sched.kind.daily": "Daily",
			"sched.kind.weekly": "Weekly",
			"sched.kind.cron": "Cron",
			"sched.kind.unknown": "Unknown",
			"sched.status.active": "Active",
			"sched.status.inactive": "Ended",
			"sched.status.unknown": "Unknown",
			"sched.row.session": "Session {session}",
			"sched.delete": "Delete",
			"sched.confirm.title": "Delete this scheduled task?",
			"sched.confirm.desc": "Task \"{title}\" will stop running and move to the trash (kept for 30 days by default); restore it from the trash panel (the task id changes on rebuild).",
			"sched.confirm.action": "Move to trash",
			"sched.confirm.pending": "Moving to trash…",
			"sched.deleteFailed": "Delete failed: {message}",
			"trash.row.scheduled": "Scheduled",
			"trash.restoreDoneSched": "Restored scheduled task \"{title}\": rebuilt with its original rule (new id: {newId})."
		};

		/** 悬停按钮的极简样式：对齐行内图标按钮，不依赖任何 CSS module。 */
		const ICON_BUTTON_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 24,
			height: 24,
			padding: 0,
			border: "none",
			borderRadius: 6,
			background: "transparent",
			color: "inherit",
			cursor: "pointer"
		};

		/** 侧边栏底部座位按钮：对齐 CordisPanel 的徽标座位（尺寸与圆角内联）。 */
		const SEAT_BUTTON_STYLE = {
			position: "relative",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 32,
			height: 32,
			padding: 0,
			border: "none",
			borderRadius: 8,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer"
		};

		/** 座位按钮右上角的条目数徽标。 */
		const BADGE_STYLE = {
			position: "absolute",
			top: 1,
			right: 1,
			minWidth: 14,
			height: 14,
			padding: "0 3px",
			borderRadius: 7,
			background: "var(--dsw-alias-brand-primary)",
			color: "var(--dsw-alias-label-primary-inverted)",
			fontSize: 10,
			lineHeight: "14px",
			fontWeight: 600,
			textAlign: "center"
		};

		/** 座位的根容器：同时包住弹层与按钮，供外点关闭判定与锚定测量。 */
		const SEAT_ROOT_STYLE = {
			position: "relative",
			display: "inline-flex"
		};

		/** 锚定弹层容器：fixed 定位（left/bottom 来自座位矩形），token 配色。 */
		const PANEL_STYLE = {
			position: "fixed",
			// 弹层挂在 body（portal）后 z-index 才真正在根层叠上下文里生效：
			// 900 = 高于应用自身的常规 chrome（侧边栏 z-index 0、正文列 auto），
			// 低于第一方模态层（1000）与其它插件的浮窗，避免盖住确认框。
			zIndex: 900,
			width: 400,
			maxWidth: "calc(100vw - 24px)",
			maxHeight: "min(70vh, 560px)",
			overflowY: "auto",
			display: "flex",
			flexDirection: "column",
			gap: 6,
			padding: "12px 14px",
			borderRadius: 10,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-3)",
			boxShadow: "0 8px 24px rgba(0, 0, 0, 0.2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			lineHeight: 1.5,
			fontFamily: "inherit",
			textAlign: "left"
		};

		const PANEL_HEADER_STYLE = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 8
		};

		const PANEL_TITLE_STYLE = {
			fontSize: 13,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};

		const PANEL_NOTE_STYLE = {
			margin: "4px 0",
			fontSize: 12,
			color: "var(--dsw-alias-label-tertiary)"
		};

		const PANEL_ERROR_STYLE = {
			margin: "4px 0",
			fontSize: 12,
			color: "var(--dsw-alias-label-error)"
		};

		const TEXT_BUTTON_STYLE = {
			padding: "2px 8px",
			border: "none",
			borderRadius: 6,
			background: "transparent",
			fontSize: 12,
			fontFamily: "inherit",
			cursor: "pointer",
			color: "var(--dsw-alias-label-secondary)"
		};

		const DANGER_TEXT_BUTTON_STYLE = {
			...TEXT_BUTTON_STYLE,
			color: "var(--dsw-alias-label-error)"
		};

		const LIST_STYLE = {
			listStyle: "none",
			margin: 0,
			padding: 0,
			display: "flex",
			flexDirection: "column",
			gap: 2
		};

		const ROW_STYLE = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			padding: "6px 4px",
			borderRadius: 6
		};

		const ROW_MAIN_STYLE = {
			flex: 1,
			minWidth: 0
		};

		const ROW_TITLE_STYLE = {
			fontSize: 13,
			color: "var(--dsw-alias-label-primary)",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		const ROW_META_STYLE = {
			fontSize: 12,
			color: "var(--dsw-alias-label-tertiary)",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		const ROW_ACTIONS_STYLE = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexShrink: 0
		};

		const ROW_BUTTON_STYLE = {
			padding: "3px 10px",
			border: "none",
			borderRadius: 6,
			background: "var(--dsw-alias-fill-l2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			fontFamily: "inherit",
			cursor: "pointer"
		};

		const PANEL_FOOTER_STYLE = {
			marginTop: 2,
			fontSize: 11,
			color: "var(--dsw-alias-label-tertiary)"
		};

		/** 页签条（会话回收站 / 定时任务）。 */
		const TAB_BAR_STYLE = {
			display: "flex",
			gap: 4,
			marginTop: 2
		};

		const TAB_BUTTON_STYLE = {
			padding: "3px 10px",
			border: "none",
			borderRadius: 999,
			background: "transparent",
			fontSize: 12,
			fontFamily: "inherit",
			cursor: "pointer",
			color: "var(--dsw-alias-label-secondary)"
		};

		const TAB_BUTTON_ACTIVE_STYLE = {
			...TAB_BUTTON_STYLE,
			background: "var(--dsw-alias-fill-l2)",
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600
		};

		/** 客户端本地时间的短格式（YYYY-MM-DD HH:mm）。 */
		function fmtLocalTime(ts) {
			if (!Number.isFinite(ts)) return "";
			const d = new Date(ts);
			const pad = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}

		/** id 前缀的短显示（与宿主命令输出同规则）。 */
		function shortId(id) {
			if (typeof id !== "string") return "";
			return id.length <= 21 ? id : `${id.slice(0, 18)}…${id.slice(-3)}`;
		}

		/**
		 * 挂载浏览器侧 UI：菜单项 + 悬停按钮 + 确认对话框 + 回收站座位面板。
		 * @param ctx - 浏览器插件上下文（slots / sessions / locale 已注入）。
		 */
		function apply(ctx) {
			const sessions = ctx.get("sessions");
			const t = ctx.locale.bind(NS);

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-recycle-bin: dictionaries");

			/** 待确认请求：{ seq, kind?, sessionId, title, isCurrent? } | { seq, kind, entryName, title } | { seq, kind: 'wipe-all', count } | { seq, kind: 'sched-delete', taskId, title } | null。 */
			const confirmRequest = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(null);
			/** 回收站列表快照：{ read, entries, retentionDays, error }。entries 含定时任务条目（type: 'schedule'）。 */
			const trashStore = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				read: false,
				entries: [],
				retentionDays: undefined,
				error: null
			});
			/** 定时任务列表快照：{ read, available, tasks, error }（v1.4.0）。 */
			const schedulesStore = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				read: false,
				available: undefined,
				tasks: [],
				error: null
			});
			let seq = 0;
			let trashEpoch = 0;

			/** 主视图当前保留的会话 id（与 ui-workspace 的 mainSessionId 同一判定）。 */
			function currentMainSessionId() {
				return Object.values(sessions.list.getSnapshot().byId)
					.find((row) => (row.retainedBy.mainView ?? 0) > 0)?.id;
			}

			/**
			 * 按需解析可选客户端服务。删「当前会话」需要会话导航能力，但缺了
			 * 它只该让这一步降级（拒绝并提示），不该让整个插件失活——客户端
			 * 条目激活失败在桌面壳里是致命错误（整应用 recovery）。
			 * 每次现取（不缓存）：服务出现得比本插件晚也没关系。
			 * @param name - 服务键（uiWorkspace / workspaces）。
			 */
			const optionalService = (name) => {
				try {
					return ctx.get(name);
				} catch {
					return undefined;
				}
			};

			/**
			 * 找一个可以切过去的替代会话：优先同一工作区（工作区成员表可用
			 * 时以它为准，否则按 cwd 匹配），其次列表里最靠前的其它会话。
			 * 目标自身与子代理会话都排除。
			 * @param sessionId - 准备删除的会话 id。
			 * @returns 替代会话的行对象，或 undefined（列表里没有别的会话）。
			 */
			const pickReplacementSession = (sessionId) => {
				const snapshot = sessions.list.getSnapshot();
				const byId = snapshot?.byId ?? {};
				const others = (snapshot?.ids ?? [])
					.filter((id) => id !== sessionId)
					.map((id) => byId[id])
					.filter((row) => row !== undefined && row.origin !== "subagent");
				if (others.length === 0) return undefined;
				const target = byId[sessionId];
				let members;
				let archived;
				try {
					const state = optionalService("workspaces")?.list?.getSnapshot?.();
					if (Array.isArray(state?.archivedSessionIds)) archived = new Set(state.archivedSessionIds);
					const items = state?.items;
					if (Array.isArray(items)) {
						members = new Set(items.find((item) => Array.isArray(item.sessionIds)
							&& item.sessionIds.includes(sessionId))?.sessionIds ?? []);
					}
				} catch {
					members = undefined;
				}
				// 归档会话优先跳过（它们在侧边栏里本来就藏着）；全被归档时不再挑拣
				const visible = archived === undefined ? others : others.filter((row) => !archived.has(row.id));
				const pool = visible.length > 0 ? visible : others;
				const sameScope = pool.filter((row) => members === undefined
					? (typeof target?.cwd === "string" && row.cwd === target.cwd)
					: members.has(row.id));
				return (sameScope.length > 0 ? sameScope : pool)[0];
			};

			/**
			 * 等主视图真的离开该会话（openSession / startSession 的落定是
			 * 异步的，保留计数要在下一次列表快照才反映出来）。
			 * @returns true = 已离开；false = 超时仍在原会话。
			 */
			const waitUntilLeft = async (sessionId) => {
				const deadline = Date.now() + LEAVE_TIMEOUT_MS;
				for (;;) {
					if (currentMainSessionId() !== sessionId) return true;
					if (Date.now() >= deadline) return false;
					await delay(LEAVE_POLL_MS);
				}
			};

			/**
			 * 把主视图从待删会话上挪开（删「当前会话」的第一步）。
			 * 顺序：别的会话 → uiWorkspace.openSession 切过去；没有别的会话
			 * → 官方 startSession 新建一个并导航（该工作区不可用时会清空主
			 * 视图，同样算离开）。挪不动就抛错，由调用方取消删除。
			 * **绝不在这里整页刷新**：刷新重跑 web boot，桌面壳把「有客户端
			 * 条目激活失败」判为致命错误，一次删除就变成整应用 recovery。
			 */
			const leaveCurrentSession = async (sessionId) => {
				const uiWorkspace = optionalService("uiWorkspace");
				if (typeof uiWorkspace?.openSession !== "function") throw new Error(t("confirm.leaveUnavailable"));
				const replacement = pickReplacementSession(sessionId);
				if (replacement !== undefined) uiWorkspace.openSession(replacement.id);
				else if (typeof uiWorkspace.startSession === "function") uiWorkspace.startSession();
				else throw new Error(t("confirm.leaveUnavailable"));
				if (await waitUntilLeft(sessionId)) return;
				throw new Error(t("confirm.leaveFailed"));
			};

			/**
			 * POST 宿主 JSON 路由的公共通道。
			 * @param makeError - 把可读错误消息包装成本地化 Error 的回调。
			 */
			const postJson = async (route, body, makeError) => {
				let response;
				try {
					response = await fetch(route, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body ?? {})
					});
				} catch (reason) {
					throw makeError(reason instanceof Error ? reason.message : String(reason));
				}
				let payload = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				if (!response.ok || payload?.ok !== true) {
					const message = typeof payload?.error === "string" && payload.error.length > 0
						? payload.error
						: `HTTP ${String(response.status)}`;
					throw makeError(message);
				}
				return payload;
			};

			/** 拉取回收站列表（徽标计数与面板数据源）；过期响应按 epoch 丢弃。 */
			const refreshTrash = async () => {
				const epoch = trashEpoch + 1;
				trashEpoch = epoch;
				try {
					const payload = await postJson(ROUTE_TRASH, {}, (message) => new Error(t("trash.panel.readFailed", { message })));
					if (epoch !== trashEpoch) return;
					trashStore.set({
						read: true,
						entries: Array.isArray(payload.entries) ? payload.entries : [],
						retentionDays: typeof payload.retentionDays === "number" ? payload.retentionDays : undefined,
						error: null
					});
				} catch (reason) {
					if (epoch !== trashEpoch) return;
					trashStore.set({
						read: true,
						entries: [],
						retentionDays: trashStore.getSnapshot().retentionDays,
						error: reason instanceof Error ? reason.message : String(reason)
					});
				}
			};

			/**
			 * 调宿主删除路由：POST dsh-session-recycle-bin.delete { sessionId }。
			 * 响应：{ ok, deleted, warnings } 或 { ok: false, error, code }。
			 * 删的是主视图正开着的会话时，先把主视图挪到别的会话（没有就新建
			 * 一个）再发起删除：列表摘行时本窗口已经不在那个会话上，既不把
			 * 主视图冻在已删除的会话里，也不需要整页刷新（刷新会重跑 web
			 * boot，桌面壳对「客户端条目激活失败」是致命的）。
			 * 挪不动则抛错取消删除：宁可不删，也不刷新、不把窗口留在死会话。
			 */
			const doDelete = async (sessionId, { wasCurrent = false } = {}) => {
				if (wasCurrent) await leaveCurrentSession(sessionId);
				const payload = await postJson(ROUTE_DELETE, { sessionId }, (message) => new Error(t("deleteFailed", { message })));
				refreshTrash();
				return payload;
			};

			/** 恢复一个回收站条目到原位。 */
			const doRestore = async (entryName) => {
				const payload = await postJson(ROUTE_RESTORE, { entryName }, (message) => new Error(t("trash.restoreFailed", { message })));
				refreshTrash();
				return payload;
			};

			/** 彻底删除单个条目（confirm 由确认框保证）。 */
			const doWipe = async (entryName) => {
				const payload = await postJson(ROUTE_WIPE, { target: entryName, confirm: true }, (message) => new Error(t("trash.wipeFailed", { message })));
				refreshTrash();
				return payload;
			};

			/** 清空回收站；部分失败时抛错留在确认框里展示。 */
			const doWipeAll = async () => {
				const payload = await postJson(ROUTE_WIPE, { target: "all", confirm: true }, (message) => new Error(t("trash.wipeFailed", { message })));
				refreshTrash();
				const failed = Number(payload.failed ?? 0);
				if (failed > 0) {
					throw new Error(t("trash.wipeAll.partial", { purged: String(payload.purged ?? 0), count: String(failed) }));
				}
				return payload;
			};

			/** 拉取定时任务列表（「定时任务」页签数据源）；过期响应按 epoch 丢弃。 */
			let schedEpoch = 0;
			const refreshSchedules = async () => {
				const epoch = schedEpoch + 1;
				schedEpoch = epoch;
				try {
					const payload = await postJson(ROUTE_SCHEDULES, {}, (message) => new Error(t("sched.panel.readFailed", { message })));
					if (epoch !== schedEpoch) return;
					schedulesStore.set({
						read: true,
						available: payload.available === true,
						tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
						error: typeof payload.error === "string" ? payload.error : null
					});
				} catch (reason) {
					if (epoch !== schedEpoch) return;
					schedulesStore.set({
						read: true,
						available: schedulesStore.getSnapshot().available,
						tasks: [],
						error: reason instanceof Error ? reason.message : String(reason)
					});
				}
			};

			/** 删除一个定时任务（先确认）：POST schedule-delete { id }，随后刷新两份列表。 */
			const doScheduleDelete = async (taskId) => {
				const payload = await postJson(ROUTE_SCHEDULE_DELETE, { id: taskId }, (message) => new Error(t("sched.deleteFailed", { message })));
				refreshTrash();
				refreshSchedules();
				return payload;
			};

			/** 打开删除确认框（菜单与悬停按钮共用）；当前会话带 isCurrent 供文案与刷新判定。 */
			const requestDelete = (sessionId) => {
				const summary = sessions.list.getSnapshot().byId[sessionId];
				confirmRequest.set({
					seq: ++seq,
					sessionId,
					title: summary?.displayTitle ?? sessionId,
					isCurrent: currentMainSessionId() === sessionId
				});
			};

			/** 打开单条「彻底清除」确认框。 */
			const requestWipe = (entry) => {
				confirmRequest.set({
					seq: ++seq,
					kind: "wipe",
					entryName: entry.entryName,
					title: entry.title ?? t("trash.row.untitled")
				});
			};

			/** 打开「清空回收站」确认框（条目数取自最近一次列表）。 */
			const requestWipeAll = () => {
				confirmRequest.set({
					seq: ++seq,
					kind: "wipe-all",
					count: trashStore.getSnapshot().entries.length
				});
			};

			/** 打开「删除定时任务」确认框（v1.4.0）。 */
			const requestSchedDelete = (task) => {
				confirmRequest.set({
					seq: ++seq,
					kind: "sched-delete",
					taskId: task.id,
					title: task.title ?? task.id
				});
			};

			/** 按待确认请求的 kind 分派到对应操作（确认框的执行端）。 */
			const runConfirm = async (request) => {
				if (request?.kind === "wipe") return doWipe(request.entryName);
				if (request?.kind === "wipe-all") return doWipeAll();
				if (request?.kind === "sched-delete") return doScheduleDelete(request.taskId);
				// 是否属于「当前会话」以点确认这一刻为准：确认框开着时用户可能已经切走
				return doDelete(request.sessionId, { wasCurrent: currentMainSessionId() === request.sessionId });
			};

			const deleteInjected = () => ({ requestDelete });
			const confirmInjected = () => ({
				hooks: { request: confirmRequest },
				settle: () => {
					confirmRequest.set(null);
				},
				runConfirm
			});
			const trashInjected = () => ({
				hooks: { trash: trashStore, schedules: schedulesStore },
				refresh: refreshTrash,
				refreshSchedules,
				requestWipe,
				requestWipeAll,
				doRestore,
				requestSchedDelete
			});

			// 菜单项：pin 100 / rename 200 / fork 300 / archive 400 → 删除排 455（归档正下方）。
			// 不用 450：第一方的「会话 id」项（id=session-id）已经占了 450，同值会退化成
			// 按注册先后定序，位置不稳定。
			ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
				yield ctx.slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "recycle-bin-delete",
					order: 455,
					locale: NS,
					inject: deleteInjected
				}, DeleteSessionMenuItem);
			});
			// 悬停按钮：archive 100 / pin 200 → 删除排 150（紧挨归档）
			ctx.slots.inject("sidebar.workspaces.session.row.action", function* () {
				yield ctx.slots.register({
					name: "sidebar.workspaces.session.row.action",
					id: "recycle-bin-delete",
					order: 150,
					locale: NS,
					inject: deleteInjected
				}, DeleteSessionRowButton);
			});
			// 确认对话框挂在全局 overlay 层（删除 / 彻底清除 / 清空共用）
			ctx.slots.inject("shell.overlay", function* () {
				yield ctx.slots.register({
					name: "shell.overlay",
					id: "session-recycle-bin.confirm",
					locale: NS,
					inject: confirmInjected
				}, ConfirmDialog);
			});
			// 回收站座位：侧边栏底部，CordisPanel 同款入口
			ctx.slots.inject("sidebar.footer.action", function* () {
				yield ctx.slots.register({
					name: "sidebar.footer.action",
					id: "recycle-bin-panel",
					locale: NS,
					inject: trashInjected
				}, TrashSeat);
			});

			// 启动时拉一次回收站计数（徽标）；后续靠打开面板与操作后刷新
			refreshTrash();
		}

		/**
		 * 行「...」菜单里的删除项。
		 * @param props - sessionId 由列表按行注入；useMenuOpenState 由菜单归属方提供。
		 */
		function DeleteSessionMenuItem({ sessionId, requestDelete, useMenuOpenState, t }) {
			const [, setMenuOpen] = useMenuOpenState();
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuItemButton, {
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false);
					requestDelete(sessionId);
				},
				children: t("menu.deleteSession")
			});
		}

		/** 行悬停按钮：归档（order 100）与置顶（order 200）之间的删除按钮。 */
		function DeleteSessionRowButton({ sessionId, requestDelete, t }) {
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: t("actions.delete"),
				side: "bottom",
				align: "end",
				delayMs: 500,
				children: (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					style: ICON_BUTTON_STYLE,
					"aria-label": t("menu.deleteSession"),
					onClick: () => {
						requestDelete(sessionId);
					},
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutlineRegular, { size: 14 })
				})
			});
		}

		/**
		 * 确认框文案按 kind 分派；旧请求无 kind，视为删除。
		 */
		function confirmCopy(request, t) {
			if (request.kind === "wipe") {
				return {
					title: t("trash.wipe.confirm.title"),
					description: t("trash.wipe.confirm.desc", { title: request.title }),
					action: t("trash.wipe.confirm.action"),
					pending: t("trash.wipe.confirm.pending")
				};
			}
			if (request.kind === "wipe-all") {
				return {
					title: t("trash.wipeAll.confirm.title"),
					description: t("trash.wipeAll.count", { count: String(request.count ?? 0) }),
					action: t("trash.wipeAll.confirm.action"),
					pending: t("trash.wipeAll.confirm.pending")
				};
			}
			if (request.kind === "sched-delete") {
				return {
					title: t("sched.confirm.title"),
					description: t("sched.confirm.desc", { title: request.title }),
					action: t("sched.confirm.action"),
					pending: t("sched.confirm.pending")
				};
			}
			return {
				title: t("confirm.title"),
				description: t("confirm.desc", { title: request.title }),
				action: t("confirm.action"),
				pending: t("confirm.pending")
			};
		}

		/**
		 * shell.overlay 上的确认对话框：无待确认请求时渲染 null，
		 * 有请求时按 kind + 目标 + seq 为 key 挂一个独立表单。
		 */
		function ConfirmDialog({ useRequest, settle, runConfirm, t }) {
			const request = useRequest((pending) => pending);
			if (request === null) return null;
			return (0, react_jsx_runtime.jsx)(ConfirmForm, {
				request,
				settle,
				runConfirm,
				t
			}, `${request.kind ?? "delete"}:${request.entryName ?? request.sessionId ?? "all"}:${String(request.seq)}`);
		}

		/** 单个请求的表单：in-flight 与错误状态随请求生灭。 */
		function ConfirmForm({ request, settle, runConfirm, t }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const copy = confirmCopy(request, t);
			const close = () => {
				if (busy) return;
				settle();
			};
			const confirm = () => {
				setBusy(true);
				setError(null);
				Promise.resolve().then(() => runConfirm(request)).then(() => {
					setBusy(false);
					settle();
				}).catch((reason) => {
					setBusy(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			const statusText = request.isCurrent === true ? t("confirm.pendingCurrent") : copy.pending;
			return (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("close"),
				title: copy.title,
				description: copy.description,
				footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						disabled: busy,
						onClick: close,
						children: t("cancel")
					}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						disabled: busy,
						onClick: confirm,
						children: copy.action
					})
				] }),
				children: [
					request.isCurrent === true ? (0, react_jsx_runtime.jsx)("div", {
						role: "note",
						style: PANEL_ERROR_STYLE,
						children: t("confirm.currentNote")
					}) : null,
					busy ? (0, react_jsx_runtime.jsx)("div", {
						role: "status",
						children: statusText
					}) : null,
					error !== null ? (0, react_jsx_runtime.jsx)("div", {
						role: "alert",
						children: error
					}) : null
				]
			});
		}

		/**
		 * 侧边栏底部的回收站座位：垃圾桶按钮 + 条目数徽标，点击弹出锚定面板。
		 * 布局照抄第一方 CordisPanel：根容器包住弹层与按钮，按钮矩形算出
		 * fixed 坐标（座位上方 8px），resize 重算；外点与 Escape 关闭。
		 */
		function TrashSeat({ useTrash, useSchedules, refresh, refreshSchedules, requestWipe, requestWipeAll, doRestore, requestSchedDelete, t }) {
			const trash = useTrash((state) => state);
			const schedules = useSchedules((state) => state);
			const [open, setOpen] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			/** 弹层根：portal 到 body 后它已不在 rootRef 内，外点判定要同时看两处。 */
			const panelRef = (0, react.useRef)(null);
			const [anchor, setAnchor] = (0, react.useState)(undefined);
			(0, react.useLayoutEffect)(() => {
				if (!open) return undefined;
				const place = () => {
					const rect = rootRef.current?.getBoundingClientRect();
					if (rect !== void 0) setAnchor({
						left: rect.left,
						bottom: window.innerHeight - rect.top + 8
					});
				};
				place();
				window.addEventListener("resize", place);
				return () => {
					window.removeEventListener("resize", place);
				};
			}, [open]);
			// 外点关闭：座位与弹层都算「内部」。不用第一方 useDismissOnOutsidePointer
			// 是因为它只认一个 ref，而弹层 portal 到 body 后已不在 rootRef 里 ——
			// 用它会把弹层内的每次点击都判成外部点击，点一下就被关掉（点了等于没点）。
			(0, react.useEffect)(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const target = event.target;
					if (rootRef.current?.contains(target) === true) return;
					if (panelRef.current?.contains(target) === true) return;
					setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
				};
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return undefined;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			const count = trash.error === null && trash.read === true ? trash.entries.length : 0;
			/** 弹层节点（座位上方 8px 的 fixed 面板）；portal 与就地渲染共用同一个节点。 */
			const panelNode = open && anchor !== void 0 ? (0, react_jsx_runtime.jsx)(TrashPanel, {
				panelRef,
				anchor,
				trash,
				schedules,
				close: () => {
					setOpen(false);
				},
				requestWipe,
				requestWipeAll,
				doRestore,
				requestSchedDelete,
				t
			}) : null;
			const portalReady = react_dom !== null && typeof react_dom.createPortal === "function"
				&& typeof document !== "undefined" && Boolean(document.body);
			return (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				style: SEAT_ROOT_STYLE,
				children: [
					panelNode === null ? null : portalReady ? (0, react_dom.createPortal)(panelNode, document.body) : panelNode,
					(0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						style: SEAT_BUTTON_STYLE,
						"aria-label": t("trash.panel.aria"),
						"aria-expanded": open,
						onClick: () => {
							const next = !open;
							if (next) {
								refresh();
								refreshSchedules();
							}
							setOpen(next);
						},
						children: [
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutlineRegular, { size: 18 }),
							count > 0 ? (0, react_jsx_runtime.jsx)("span", {
								style: BADGE_STYLE,
								children: String(count > 99 ? "99+" : count)
							}) : null
						]
					})
				]
			});
		}

		/**
		 * 回收站锚定面板：页签条（会话回收站 / 定时任务）→ 各页签内容。
		 * 读取失败与操作失败分别以 alert 行呈现；恢复在行内完成。
		 */
		function TrashPanel({ panelRef, anchor, trash, schedules, close, requestWipe, requestWipeAll, doRestore, requestSchedDelete, t }) {
			const [busyEntry, setBusyEntry] = (0, react.useState)(null);
			const [actionError, setActionError] = (0, react.useState)(null);
			const [actionNote, setActionNote] = (0, react.useState)(null);
			const [tab, setTab] = (0, react.useState)("sessions");
			const entries = trash.entries;
			const restore = async (entry) => {
				if (busyEntry !== null) return;
				setBusyEntry(entry.entryName);
				setActionError(null);
				setActionNote(null);
				try {
					const payload = await doRestore(entry.entryName);
					if (payload?.type === "schedule") {
						setActionNote(t("trash.restoreDoneSched", {
							title: entry.title ?? t("trash.row.untitled"),
							newId: String(payload?.newId ?? "")
						}));
						return;
					}
					setActionNote(payload?.attached === false
						? t("trash.restoreUngrouped", { title: entry.title ?? t("trash.row.untitled"), note: payload?.attachNote ?? t("trash.row.untitled") })
						: t("trash.restoreDone", { title: entry.title ?? t("trash.row.untitled") }));
				} catch (reason) {
					setActionError(reason instanceof Error ? reason.message : String(reason));
				} finally {
					setBusyEntry(null);
				}
			};
			const retention = trash.retentionDays === 0 ? t("trash.panel.retention.off")
				: trash.retentionDays !== undefined ? t("trash.panel.retention", { days: String(trash.retentionDays) }) : null;
			const schedCount = schedules.available === true && schedules.error === null ? schedules.tasks.length : null;
			return (0, react_jsx_runtime.jsxs)("section", {
				ref: panelRef,
				style: { ...PANEL_STYLE, left: anchor.left, bottom: anchor.bottom },
				"data-recycle-bin-panel": true,
				"aria-label": t("trash.panel.title"),
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						style: PANEL_HEADER_STYLE,
						children: [
							(0, react_jsx_runtime.jsx)("span", { style: PANEL_TITLE_STYLE, children: t("trash.panel.title") }),
							tab === "sessions" && entries.length > 0 ? (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: DANGER_TEXT_BUTTON_STYLE,
								disabled: busyEntry !== null,
								onClick: () => {
									close();
									requestWipeAll();
								},
								children: t("trash.panel.wipeAll")
							}) : null
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						style: TAB_BAR_STYLE,
						role: "tablist",
						children: [
							(0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								role: "tab",
								"aria-selected": tab === "sessions",
								style: tab === "sessions" ? TAB_BUTTON_ACTIVE_STYLE : TAB_BUTTON_STYLE,
								onClick: () => {
									setTab("sessions");
								},
								children: t("tab.sessions")
							}), (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								role: "tab",
								"aria-selected": tab === "schedules",
								style: tab === "schedules" ? TAB_BUTTON_ACTIVE_STYLE : TAB_BUTTON_STYLE,
								onClick: () => {
									setTab("schedules");
								},
								children: schedCount !== null ? `${t("tab.schedules")} (${String(schedCount)})` : t("tab.schedules")
							})
						]
					}),
					actionError !== null ? (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						style: PANEL_ERROR_STYLE,
						children: actionError
					}) : null,
					actionNote !== null ? (0, react_jsx_runtime.jsx)("p", {
						role: "status",
						style: PANEL_NOTE_STYLE,
						children: actionNote
					}) : null,
					tab === "sessions" ? (0, react_jsx_runtime.jsx)(SessionsTrashTab, {
						trash,
						entries,
						busyEntry,
						close,
						restore,
						requestWipe,
						retention,
						t
					}) : (0, react_jsx_runtime.jsx)(SchedulesTab, {
						schedules,
						requestSchedDelete,
						close,
						t
					})
				]
			});
		}

		/** 「会话回收站」页签：读取态 + 回收站条目列表 + 保留期脚注。 */
		function SessionsTrashTab({ trash, entries, busyEntry, close, restore, requestWipe, retention, t }) {
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				trash.error !== null ? (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					style: PANEL_ERROR_STYLE,
					children: trash.error
				}) : null,
				trash.read !== true && trash.error === null ? (0, react_jsx_runtime.jsx)("p", {
					style: PANEL_NOTE_STYLE,
					children: t("trash.panel.loading")
				}) : null,
				trash.read === true && trash.error === null && entries.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
					style: PANEL_NOTE_STYLE,
					children: t("trash.panel.empty")
				}) : null,
				entries.length > 0 ? (0, react_jsx_runtime.jsx)("ul", {
					style: LIST_STYLE,
					children: entries.map((entry) => (0, react_jsx_runtime.jsx)(TrashRow, {
						entry,
						busy: busyEntry === entry.entryName,
						disabled: busyEntry !== null,
						onRestore: () => {
							restore(entry);
						},
						onWipe: () => {
							close();
							requestWipe(entry);
						},
						t
					}, entry.entryName))
				}) : null,
				retention !== null ? (0, react_jsx_runtime.jsx)("footer", {
					style: PANEL_FOOTER_STYLE,
					children: retention
				}) : null
			] });
		}

		/** 「定时任务」页签（v1.4.0）：可用性 / 读取态 + 任务列表（行内删除）。 */
		function SchedulesTab({ schedules, requestSchedDelete, close, t }) {
			if (schedules.available === false) {
				return (0, react_jsx_runtime.jsx)("p", {
					style: PANEL_NOTE_STYLE,
					children: t("sched.panel.unavailable")
				});
			}
			if (schedules.error !== null) {
				return (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					style: PANEL_ERROR_STYLE,
					children: schedules.error
				});
			}
			if (schedules.read !== true) {
				return (0, react_jsx_runtime.jsx)("p", {
					style: PANEL_NOTE_STYLE,
					children: t("trash.panel.loading")
				});
			}
			const tasks = schedules.tasks;
			if (tasks.length === 0) {
				return (0, react_jsx_runtime.jsx)("p", {
					style: PANEL_NOTE_STYLE,
					children: t("sched.panel.empty")
				});
			}
			return (0, react_jsx_runtime.jsx)("ul", {
				style: LIST_STYLE,
				children: tasks.map((task) => (0, react_jsx_runtime.jsx)(ScheduleRow, {
					task,
					onDelete: () => {
						close();
						requestSchedDelete(task);
					},
					t
				}, task.id))
			});
		}

		/** 定时任务行：标题 + 元信息（频率 · 状态 · 下次运行 · 所属会话）+ 行内删除。 */
		function ScheduleRow({ task, onDelete, t }) {
			const kindLabel = t(`sched.kind.${typeof task.kind === "string" ? task.kind : "unknown"}`);
			const statusLabel = t(`sched.status.${typeof task.status === "string" ? task.status : "unknown"}`);
			const meta = [
				kindLabel,
				statusLabel,
				Number.isFinite(task.scheduledAt) ? fmtLocalTime(task.scheduledAt) : "",
				typeof task.sessionId === "string" ? t("sched.row.session", { session: shortId(task.sessionId) }) : ""
			].filter((part) => part.length > 0).join(" · ");
			return (0, react_jsx_runtime.jsxs)("li", {
				style: ROW_STYLE,
				"data-schedule-task": task.id,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						style: ROW_MAIN_STYLE,
						children: [
							(0, react_jsx_runtime.jsx)("div", { style: ROW_TITLE_STYLE, children: task.title ?? t("trash.row.untitled") }),
							(0, react_jsx_runtime.jsx)("div", { style: ROW_META_STYLE, children: meta })
						]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						style: ROW_ACTIONS_STYLE,
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: { ...ROW_BUTTON_STYLE, color: "var(--dsw-alias-label-error)" },
							onClick: onDelete,
							children: t("sched.delete")
						})
					})
				]
			});
		}

		/** 回收站条目行：标题 + 元信息（时间 · 类型/工作区 · id 前缀）+ 行内操作。 */
		function TrashRow({ entry, busy, disabled, onRestore, onWipe, t }) {
			const kindPrefix = entry.type === "schedule" ? `${t("trash.row.scheduled")} · ` : "";
			const meta = [
				fmtLocalTime(entry.trashedAt),
				kindPrefix,
				entry.type === "schedule"
					? (typeof entry.sessionId === "string" ? t("sched.row.session", { session: shortId(entry.sessionId) }) : "")
					: entry.cwd ?? "",
				shortId(entry.id)
			].filter((part) => part.length > 0).join(" · ");
			return (0, react_jsx_runtime.jsxs)("li", {
				style: ROW_STYLE,
				"data-recycle-entry": entry.entryName,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						style: ROW_MAIN_STYLE,
						children: [
							(0, react_jsx_runtime.jsx)("div", { style: ROW_TITLE_STYLE, children: entry.title ?? t("trash.row.untitled") }),
							(0, react_jsx_runtime.jsx)("div", { style: ROW_META_STYLE, children: meta })
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						style: ROW_ACTIONS_STYLE,
						children: [
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: ROW_BUTTON_STYLE,
								disabled,
								"aria-busy": busy,
								onClick: onRestore,
								children: t("trash.restore")
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: { ...ROW_BUTTON_STYLE, color: "var(--dsw-alias-label-error)" },
								disabled,
								onClick: onWipe,
								children: t("trash.wipe")
							})
						]
					})
				]
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
