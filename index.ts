import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createProcessJob, type ProcessJob } from "./windows-job.ts";
import {
	ADOPTION_WINDOW_MS,
	CHILD_SOFT_LIMIT,
	INHERITED_IDENTITY,
	INSPECTION_INTERVAL_MS,
	ROLE_NAME_GUIDE,
	TEAM_EVENT_ENTRY,
	TEAM_INSTANCE_FLAG,
	TEAM_STATE_ENTRY,
	childCapacityNote,
	fallbackRoleName,
	findStandaloneState,
	formatAgentTree,
	formatIdentityUsageLine,
	formatStatusLines,
	formatTokenUsage,
	getMessageText,
	identityRows,
	readInstanceConfig,
	readJsonLines,
	readModelPool,
	readStandaloneState,
	registerRoleExtension,
	resolveSpawnModel,
	roleNameError,
	sendRpcPrompt,
	sumTokenUsage,
	supervisorAlive,
	taskSummary,
	undispatchedTargets,
	unansweredMessages,
	uniqueRoleName,
	writeJsonAtomic,
	type AgentRecord,
	type AgentStatus,
	type ModelPool,
	type PersistedState,
	type TeamEvent,
	type TeamInstanceConfig,
	type TeamRole,
	type TeamSnapshot,
	type TeamStatusRow,
} from "./shared.ts";

const MAX_BOSSES = 3;
const TEAM_STATUS_KEY = "pi-team";
const TEAM_WIDGET_KEY = "pi-team-agents";
const RECOVERY_LIMIT = 3;
const ROLE_NAMES: Record<TeamRole, string> = { boss: "Boss", lead: "Lead", worker: "Worker" };
const ROLE_PROMPTS: Record<TeamRole, string> = {
	boss: `You are a Boss in a Pi coding team. You are a strictly event-driven coordinator and decision-maker, not a project implementer. For substantive project work, do not edit files, run implementation commands, or carry out the task yourself. Inspect only enough to scope and verify, then reuse or create the minimum sufficient Department Leads. For a new set of non-conflicting tasks, default to creating a Lead for each task in parallel; use one Lead only when the work is truly one coherent workstream. Do not cancel an existing Team or its roles unless the user explicitly says stop, pause, or replace. Before creating a Lead, call team_models and choose an available identity by business need. Leads normally use a high tier: choose vision-high only when the Lead must inspect images, screenshots, video, GUI state, or other visual evidence; otherwise choose text-high. Use another available tier only when the task clearly does not need high-tier planning or review. Never invent an identity that team_models did not return. The built-in identity "inherited" always means the main session model; pass it when every role should run on the same model. Name every Lead after its workstream or department through the team_delegate name parameter (one token, e.g. "nav-tree", "发布线"). Act only on the current user message or a new Lead report. Handle that event by deciding, delegating, verifying, or reporting, then stop and remain idle until another external event arrives. Never invent follow-up work or keep working merely to stay busy. ${CHILD_SOFT_LIMIT} direct Leads is a soft limit, not a hard cap: delegation past it still succeeds but returns a capacity warning, so add the extra Lead only for genuinely independent work and release the rest with team_cancel. Before adding another Lead, call team_list and explain why existing Leads cannot own the work. team_list reports state by default; request mode "full" only when you need a role's brief text. Trivial questions, status checks, and Team control commands may be answered directly without delegation.`,
	lead: `You are a Department Lead in a Pi coding team. You are an event-driven coordinator and reviewer, not a project implementer. For substantive execution, do not edit files or carry out Worker tasks yourself. On a Boss assignment, scope it, reuse or create the minimum useful Workers, send concrete tasks, then stop and remain idle. Before creating a Worker, call team_models and choose an available identity by business need. Workers normally use medium or low tiers: use medium for ordinary implementation, investigation, and testing; use low for simple, bounded, low-risk work; use high only when the Worker task genuinely needs complex reasoning or unusually strong execution. At any tier, choose vision only when the Worker must inspect images, screenshots, video, GUI state, or other visual evidence; otherwise choose text. Never invent an identity that team_models did not return. The built-in identity "inherited" always means the main session model; pass it when every role should run on the same model. Name every Worker after its unit of work through the team_delegate name parameter (one token, e.g. "hero-pages", "verify-a"). One coherent execution task normally needs one Worker; add Workers only for genuinely independent parallel work. Worker progress, settled/idle, crash, and recovery reports will wake you. On those events, inspect the report, intervene only when correction or unblocking is needed, summarize meaningful completion or risk to your Boss, then stop and idle again. Do not create routine follow-up work merely to stay active. ${CHILD_SOFT_LIMIT} direct Workers is a soft limit, not a hard cap: delegation past it still succeeds but returns a capacity warning, so add the extra Worker only for genuinely independent work and release the rest with team_cancel. Before adding another Worker, call team_list and explain why existing Workers cannot handle it. team_list reports state by default; request mode "full" only when you need a role's brief text.`,
	worker: `You are a Worker in a Pi coding team. Execute the concrete task assigned to you using the full Pi tool environment. You receive only task-relevant messages. Explain your next actions and findings normally; your text is visible to your Department Lead and the user. Ask your Lead when blocked. You cannot create other agents.`,
};

interface TeamStateEntry {
	customType?: string;
	data?: PersistedState;
	type: string;
}

interface TeamEventEntry {
	customType?: string;
	data?: TeamEvent;
	type: string;
}

interface RpcResponse {
	command: string;
	data?: any;
	error?: string;
	id?: string;
	success: boolean;
	type: "response";
}

interface RuntimeAgent extends AgentRecord {
	artifactNudged: boolean;
	configPath: string;
	details: string[];
	dispatchWarnedFor?: string;
	intentionalStop: boolean;
	lastAssistantText: string;
	lastEventAt?: number;
	lastSettleHadReport?: boolean;
	pendingParentMessages: string[];
	progressTimer?: ReturnType<typeof setTimeout>;
	process?: ChildProcessWithoutNullStreams;
	recoveryAttempts: number;
	rpc?: RpcClient;
	runTools: string[];
	token: string;
}

function truncate(text: string, max = 100): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function now(): string {
	return new Date().toISOString();
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: process.platform === "win32" ? "pi.cmd" : "pi", args };
}

class RpcClient {
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private nextId = 1;
	private pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

	constructor(
		private process: ChildProcessWithoutNullStreams,
		private onEvent: (event: any) => void,
		private onProtocolError: (line: string) => void,
	) {
		process.stdout.on("data", (chunk) => this.consume(chunk));
		process.stdout.on("end", () => {
			this.buffer += this.decoder.end();
			if (this.buffer.trim()) this.processLine(this.buffer);
		});
	}

	private consume(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.processLine(line);
		}
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			this.onProtocolError(line);
			return;
		}
		if (event.type === "response" && event.id && this.pending.has(event.id)) {
			const pending = this.pending.get(event.id)!;
			clearTimeout(pending.timer);
			this.pending.delete(event.id);
			if (event.success) pending.resolve(event as RpcResponse);
			else pending.reject(new Error(event.error || `RPC ${event.command} failed`));
			return;
		}
		try {
			this.onEvent(event);
		} catch (error) {
			this.onProtocolError(`event handler error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	request(command: Record<string, unknown>, timeoutMs = 60_000): Promise<RpcResponse> {
		const id = `team-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC command ${String(command.type)} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export class TeamActivityPanel {
	constructor(
		private tui: TUI,
		private getAgents: () => RuntimeAgent[],
		private getFocusedBoss: () => string | undefined,
		private getInspectedAgent: () => RuntimeAgent | undefined,
		private getIdentityUsage: () => Record<string, TokenUsage>,
	) {}

	render(width: number): string[] {
		if (width < 2) return [" ".repeat(Math.max(0, width))];
		const inner = width - 2;
		const frameLine = (line: string): string => {
			const clipped = truncateToWidth(line, inner, "…");
			return `│${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}│`;
		};
		const allAgents = this.getAgents();
		const byId = new Map(allAgents.map((agent) => [agent.agentId, agent]));
		const pathOf = (agentId: string): string => {
			const parts: string[] = [];
			let current = byId.get(agentId);
			while (current) {
				parts.unshift(current.agentId);
				current = current.parentId ? byId.get(current.parentId) : undefined;
			}
			return parts.length ? parts.join("/") : agentId;
		};
		const inspected = this.getInspectedAgent();
		if (inspected) {
			const usageLine = inspected.tokenUsage ? formatTokenUsage(inspected.tokenUsage) : "";
			const lines = [
				`INSPECT ${inspected.name} (${pathOf(inspected.agentId)})`,
				`[${inspected.identity ?? "inherited"}: ${inspected.model ?? "default"}]`,
				`[${inspected.role}/${inspected.status} r${inspected.runCount ?? 0}]`,
				...(usageLine ? [usageLine] : []),
				"",
				...inspected.details.slice(-30),
			];
			return [
				`┌${"─".repeat(inner)}┐`,
				...lines.map(frameLine),
				`└${"─".repeat(inner)}┘`,
			];
		}
		const agentLines = formatAgentTree(allAgents, this.getFocusedBoss());
		const usageLine = formatIdentityUsageLine(this.getIdentityUsage());
		const lines = ["PI TEAM", ...(agentLines.length ? agentLines : ["No active agents"]), ...(usageLine ? [usageLine] : [])];
		return [
			`┌${"─".repeat(inner)}┐`,
			...lines.map(frameLine),
			`└${"─".repeat(inner)}┘`,
		];
	}

	requestRender(): void {
		this.tui.requestRender();
	}

	handleInput(): void {}
	invalidate(): void {}
}

export default function piTeamExtension(pi: ExtensionAPI): void {
	pi.registerFlag(TEAM_INSTANCE_FLAG, { type: "string", description: "Internal Pi Team role instance config" });
	const instance = readInstanceConfig(pi);
	if (instance) {
		registerRoleExtension(pi, instance.role);
		pi.on("before_agent_start", async (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${ROLE_PROMPTS[instance.role]}\n\nAgent ID: ${instance.agentId}\nTask: ${instance.task}\nUse team tools for delegation, directed communication, cancellation, and reading the formal group chat.`,
		}));
		return;
	}

	let context: ExtensionContext | undefined;
	let teamId = randomUUID();
	let focusedBossId: string | undefined;
	let seq = 0;
	let shuttingDown = false;
	let server: ReturnType<typeof createServer> | undefined;
	let startupPromise: Promise<void> | undefined;
	let processJob: ProcessJob | undefined;
	let serverUrl = "";
	let stateRoot = "";
	let stateDir = "";
	let statePath = "";
	let eventsPath = "";
	let teamSessionMirror: SessionManager | undefined;
	let supervisorSessionPath: string | undefined;
	let identityUsage: Record<string, TokenUsage> = {};
	let modelPool: ModelPool = {};
	let nextAgentIndexes: Record<TeamRole, number> = { boss: 1, lead: 1, worker: 1 };
	let inspectedAgentId: string | undefined;
	let restorableTeam: { ageMs: number; directory: string; live: boolean; teamId: string } | undefined;
	let activityPanel: TeamActivityPanel | undefined;
	const agents = new Map<string, RuntimeAgent>();
	const events: TeamEvent[] = [];
	const parentNotifications = new Map<string, { messages: string[]; timer?: ReturnType<typeof setTimeout> }>();
	const extensionPath = fileURLToPath(import.meta.url);

	function agentPath(agentId: string): string {
		const parts: string[] = [];
		let current = agents.get(agentId);
		while (current) {
			parts.unshift(current.agentId);
			current = current.parentId ? agents.get(current.parentId) : undefined;
		}
		return parts.length ? parts.join("/") : agentId;
	}

	function resolveAgent(reference: string, rejectAmbiguousName = false): RuntimeAgent | undefined {
		const normalized = reference.trim().replace(/^@/, "");
		const addressed = agents.get(normalized) ?? [...agents.values()].find((agent) => agentPath(agent.agentId) === normalized);
		if (addressed) return addressed;
		const named = [...agents.values()].filter((agent) => agent.name === normalized);
		if (named.length === 1) return named[0];
		if (named.length > 1 && rejectAmbiguousName) throw new Error(`Ambiguous target name: ${normalized}; use an agent ID or full path`);
		return undefined;
	}

	function publicAgent(agent: RuntimeAgent): AgentRecord {
		const { artifactNudged: _artifactNudged, configPath: _configPath, details: _details, dispatchWarnedFor: _dispatchWarnedFor, intentionalStop: _intentionalStop, lastAssistantText: _lastAssistantText, lastEventAt: _lastEventAt, lastSettleHadReport: _lastSettleHadReport, pendingParentMessages: _pendingParentMessages, progressTimer: _progressTimer, process: _process, recoveryAttempts: _recoveryAttempts, rpc: _rpc, runTools: _runTools, token: _token, ...record } = agent;
		return { ...record, path: agentPath(agent.agentId) };
	}

	function snapshot(): PersistedState {
		return {
			version: 1,
			teamId,
			focusedBossId,
			nextAgentIndexes: { ...nextAgentIndexes },
			supervisorSessionPath,
			storageId: stateDir ? basename(stateDir) : undefined,
			supervisorUrl: serverUrl || undefined,
			identityUsage: { ...identityUsage },
			updatedAt: now(),
			agents: [...agents.values()].map(publicAgent),
		};
	}

	function reserveAgentId(agentId: string): void {
		const match = agentId.match(/^(boss|lead|worker)-(\d+)$/);
		if (!match) return;
		const role = match[1] as TeamRole;
		nextAgentIndexes[role] = Math.max(nextAgentIndexes[role], Number(match[2]) + 1);
	}

	function teamSessionName(): string {
		const boss = [...agents.values()].find((agent) => agent.role === "boss");
		return boss ? `Pi Team: ${truncate(boss.task, 60)}` : "Pi Team";
	}

	function mainSessionPersists(): boolean {
		return Boolean(context?.sessionManager.getSessionFile());
	}

	function ensureTeamSessionMirror(): SessionManager | undefined {
		if (!context || mainSessionPersists()) return undefined;
		if (!teamSessionMirror) {
			const existing = supervisorSessionPath && existsSync(supervisorSessionPath);
			teamSessionMirror = existing ? SessionManager.open(supervisorSessionPath!) : SessionManager.create(context.cwd);
			supervisorSessionPath = teamSessionMirror.getSessionFile();
			if (!existing) {
				teamSessionMirror.appendSessionInfo(teamSessionName());
				teamSessionMirror.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "Pi Team supervisor session. Resume this session to restore the team, focused Boss, and formal group chat." }],
					api: "openai-responses",
					provider: "pi-team",
					model: "supervisor",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				const persistedEvents = eventsPath ? readJsonLines<TeamEvent>(eventsPath) : events;
				for (const event of persistedEvents) teamSessionMirror.appendCustomEntry(TEAM_EVENT_ENTRY, event);
			}
		}
		return teamSessionMirror;
	}

	function persistState(): void {
		const mirror = ensureTeamSessionMirror();
		const state = snapshot();
		pi.appendEntry<PersistedState>(TEAM_STATE_ENTRY, state);
		mirror?.appendCustomEntry(TEAM_STATE_ENTRY, state);
		if (statePath) writeJsonAtomic(statePath, state);
		// Workspace registry: the snapshot of record, read by recovery without any Pi session chain, so a team survives
		// /new, branch switches, compaction, and --no-session runs. A session that owns no agent (including one that
		// declined a restorable Team) never rewrites it, so the declined snapshot waits untouched for /team-restore.
		if (stateRoot && stateDir && agents.size) writeJsonAtomic(join(stateRoot, "latest.json"), state);
	}

	function appendEvent(input: Omit<TeamEvent, "eventId" | "seq" | "timestamp">): TeamEvent {
		const event: TeamEvent = { ...input, eventId: randomUUID(), seq: ++seq, timestamp: now() };
		events.push(event);
		if (events.length > 1000) events.splice(0, events.length - 1000);
		if (eventsPath) appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
		pi.appendEntry<TeamEvent>(TEAM_EVENT_ENTRY, event);
		const existingMirror = teamSessionMirror;
		const mirror = ensureTeamSessionMirror();
		if (mirror && existingMirror) mirror.appendCustomEntry(TEAM_EVENT_ENTRY, event);
		return event;
	}

	function isMainTranscriptEvent(event: TeamEvent): boolean {
		return event.kind === "message";
	}

	function updateUi(): void {
		if (!context?.hasUI) return;
		const list = [...agents.values()];
		context.ui.setStatus(TEAM_STATUS_KEY, `team ${list.filter((a) => a.status === "running").length}/${list.length}`);
		if (context.mode === "tui") {
			if (!activityPanel) {
				context.ui.setWidget(TEAM_WIDGET_KEY, (tui) => {
					activityPanel = new TeamActivityPanel(
						tui,
						() => [...agents.values()],
						() => focusedBossId,
						() => inspectedAgentId ? agents.get(inspectedAgentId) : undefined,
						() => identityUsage,
					);
					return activityPanel;
				}, { placement: "belowEditor" });
			} else {
				activityPanel.requestRender();
			}
			return;
		}
		const lines = formatAgentTree(list, focusedBossId);
		const usageLine = formatIdentityUsageLine(identityUsage);
		// non-TUI widgets render raw Text without clipping; cap each line so it cannot push past the panel width.
		const widgetLines = [...lines, ...(usageLine ? [usageLine] : [])].map((line) => truncateToWidth(line, 160, "…"));
		context.ui.setWidget(TEAM_WIDGET_KEY, widgetLines.length ? widgetLines : ["Pi Team: /boss <task> to start"], { placement: "belowEditor" });
	}

	/** Age wording for a restorable team: a legacy snapshot rebuilt from instance.json files carries no timestamp. */
	function lastActiveLabel(team: { ageMs: number }): string {
		return Number.isFinite(team.ageMs) ? `${Math.round(team.ageMs / 3_600_000)}h ago` : "at an unrecorded time";
	}

	async function reconstruct(ctx: ExtensionContext, reason: string, options: { previousSessionFile?: string; restore?: boolean; storageId?: string } = {}): Promise<void> {
		context = ctx;
		teamSessionMirror = undefined;
		supervisorSessionPath = undefined;
		identityUsage = {};
		restorableTeam = undefined;
		for (const batch of parentNotifications.values()) if (batch.timer) clearTimeout(batch.timer);
		parentNotifications.clear();
		agents.clear();
		events.length = 0;
		seq = 0;
		nextAgentIndexes = { boss: 1, lead: 1, worker: 1 };
		let saved: PersistedState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			const stateEntry = entry as TeamStateEntry;
			if (stateEntry.type === "custom" && stateEntry.customType === TEAM_STATE_ENTRY && stateEntry.data) saved = stateEntry.data;
			const eventEntry = entry as TeamEventEntry;
			if (eventEntry.type === "custom" && eventEntry.customType === TEAM_EVENT_ENTRY && eventEntry.data) events.push(eventEntry.data);
		}

		stateRoot = join(ctx.cwd, CONFIG_DIR_NAME, "pi-team");
		mkdirSync(stateRoot, { recursive: true });
		modelPool = {
			...readModelPool(join(homedir(), CONFIG_DIR_NAME, "agent", "pi-team-identities.json")),
			...readModelPool(join(stateRoot, "models.json")),
			...readModelPool(join(stateRoot, "identities.json")),
		};
		const sessionStateDir = join(stateRoot, ctx.sessionManager.getSessionId());
		// The workspace registry is the self-owned recovery source: it lives outside every Pi session file, so a team
		// survives /new, session entry loss, branch switches, compaction, and --no-session runs. It is adopted whenever
		// this session has no team of its own, or when /team-restore asks for it explicitly.
		const previousSessionId = options.previousSessionFile ? basename(options.previousSessionFile, ".jsonl").split("_").at(-1) : undefined;
		const preferredDirectory = options.storageId ? join(stateRoot, options.storageId) : previousSessionId ? join(stateRoot, previousSessionId) : undefined;
		const registryTeam = findStandaloneState(stateRoot, preferredDirectory);
		if (options.restore && !registryTeam) throw new Error(`No persisted Pi Team found under ${stateRoot}${options.storageId ? ` for ${options.storageId}` : ""}`);
		let adopted = false;
		if (options.restore) {
			saved = registryTeam!.state;
			stateDir = registryTeam!.directory;
			adopted = true;
		} else if (!saved && registryTeam) {
			const ageMs = registryTeam.state.updatedAt ? Math.max(0, Date.now() - Date.parse(registryTeam.state.updatedAt)) : Number.POSITIVE_INFINITY;
			// Auto-adopt only a recent team that no other live Supervisor still runs; anything else stays on disk for
			// /team-restore, so a stale snapshot never resurrects roles or duplicates a running Team.
			if (await supervisorAlive(registryTeam.state)) restorableTeam = { ageMs, directory: registryTeam.directory, live: true, teamId: registryTeam.state.teamId };
			else if (ageMs > ADOPTION_WINDOW_MS) restorableTeam = { ageMs, directory: registryTeam.directory, live: false, teamId: registryTeam.state.teamId };
			else {
				saved = registryTeam.state;
				stateDir = registryTeam.directory;
				adopted = true;
			}
		} else stateDir = sessionStateDir;
		if (restorableTeam) {
			// The restorable Team's snapshot stays on disk for /team-restore; this session gets its own scratch state
			// directory so binding, /team, and a fresh /boss keep working while the Team stays empty.
			stateDir = sessionStateDir;
			const message = restorableTeam.live
				? `Pi Team ${restorableTeam.teamId} is still running in another Supervisor; this session stays empty. Run /team-restore to take over.`
				: `A persisted Pi Team (${restorableTeam.teamId}) was last active ${lastActiveLabel(restorableTeam)} and was not restored automatically; run /team-restore to adopt it.`;
			appendEvent({ actorId: "supervisor", content: message, kind: "status", targetIds: [] });
			context?.ui.notify(message, "warning");
		}
		mkdirSync(stateDir, { recursive: true });
		statePath = join(stateDir, "state.json");
		eventsPath = join(stateDir, "events.jsonl");
		const mergedEvents = new Map<string, TeamEvent>();
		for (const event of [...readJsonLines<TeamEvent>(eventsPath), ...events]) {
			if (!event?.eventId || !Number.isFinite(event.seq)) continue;
			mergedEvents.set(event.eventId, event);
		}
		events.length = 0;
		events.push(...[...mergedEvents.values()].sort((left, right) => left.seq - right.seq).slice(-1000));
		seq = events.reduce((maximum, event) => Math.max(maximum, event.seq), 0);
		for (const event of events) {
			reserveAgentId(event.actorId);
			for (const targetId of event.targetIds) reserveAgentId(targetId);
		}
		for (const [role, index] of Object.entries(saved?.nextAgentIndexes ?? {}) as [TeamRole, number][]) {
			if (!(role in nextAgentIndexes) || !Number.isInteger(index) || index <= 0) continue;
			nextAgentIndexes[role] = Math.max(nextAgentIndexes[role], index);
		}
		const storedAgentsDirectory = join(stateDir, "agents");
		if (existsSync(storedAgentsDirectory)) {
			for (const entry of readdirSync(storedAgentsDirectory, { withFileTypes: true })) if (entry.isDirectory()) reserveAgentId(entry.name);
		}
		if (!existsSync(eventsPath) && events.length) writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

		if (saved && (adopted || reason !== "new")) {
			teamId = reason === "fork" && !adopted ? randomUUID() : saved.teamId;
			focusedBossId = saved.focusedBossId;
			supervisorSessionPath = reason === "fork" && !adopted ? undefined : saved.supervisorSessionPath;
			identityUsage = saved.identityUsage ?? {};
			for (const record of saved.agents) {
				reserveAgentId(record.agentId);
				if (record.status === "cancelled") continue;
				agents.set(record.agentId, {
					...record,
					actorEpoch: randomUUID(),
					artifactNudged: false,
					configPath: "",
					details: [],
					intentionalStop: false,
					lastAssistantText: "",
					lastEventAt: undefined,
					lastSettleHadReport: undefined,
					pendingParentMessages: [],
					process: undefined,
					recoveryAttempts: 0,
					rpc: undefined,
					runCount: record.runCount ?? 0,
					runTools: [],
					status: "recovering",
					token: randomBytes(24).toString("hex"),
				});
			}
			if (!focusedBossId || agents.get(focusedBossId)?.role !== "boss") focusedBossId = [...agents.values()].find((agent) => agent.role === "boss")?.agentId;
			pi.setSessionName(teamSessionName());
			persistState();
		} else {
			teamId = randomUUID();
			focusedBossId = undefined;
		}
		updateUi();
	}

	function resumeTeam(): void {
		for (const agent of agents.values()) {
			if (agent.status === "cancelled") continue;
			void startAgent(agent, true).catch((error) => addDetail(agent, `resume failed: ${error instanceof Error ? error.message : String(error)}`));
		}
	}

	function roleVisibleEvents(agent: Pick<RuntimeAgent, "agentId" | "role" | "departmentId">, drillDown = false): TeamEvent[] {
		if (agent.role === "boss") {
			const directLeadIds = new Set([...agents.values()].filter((child) => child.parentId === agent.agentId).map((child) => child.agentId));
			if (!drillDown) {
				return events.filter((event) => event.actorId === "user" || event.actorId === agent.agentId || directLeadIds.has(event.actorId) || event.targetIds.includes(agent.agentId));
			}
			const scope = new Set([agent.agentId, ...descendants(agent.agentId).map((child) => child.agentId)]);
			return events.filter((event) => scope.has(event.actorId) || event.targetIds.some((target) => scope.has(target)));
		}
		if (agent.role === "lead") return events.filter((event) => event.departmentId === agent.departmentId || event.targetIds.includes(agent.agentId));
		return events.filter((event) => event.targetIds.includes(agent.agentId));
	}

	function buildInitialPrompt(agent: RuntimeAgent, recovering: boolean): string {
		// The brief lives in the system prompt; repeating it here would put a second full copy in the child's session.
		return recovering
			? "Your Pi Team process was restarted unexpectedly. Continue the same task after checking the current session and workspace state. Do not blindly repeat side effects. Your task is in the system prompt."
			: "Begin your assigned Pi Team role now. Your task is in the system prompt.";
	}

	/** Provenance for a brief that stays out of the event log: the delegator's own history, instance.json, and the child session hold the full text. */
	function briefReference(agent: RuntimeAgent): string {
		const configPath = context ? relative(context.cwd, agent.configPath).replace(/\\/g, "/") : agent.configPath;
		return `brief ${agent.task.length} chars, ${configPath}`;
	}

	function addDetail(agent: RuntimeAgent, line: string): void {
		agent.details.push(`${new Date().toLocaleTimeString()} ${line}`);
		if (agent.details.length > 500) agent.details.splice(0, agent.details.length - 500);
		updateUi();
	}

	function parentOf(agent: RuntimeAgent): RuntimeAgent | undefined {
		return agent.parentId ? agents.get(agent.parentId) : undefined;
	}

	async function deliver(agent: RuntimeAgent, message: string): Promise<void> {
		if (!agent.rpc) throw new Error(`${agent.agentId} is not connected`);
		const pendingBatch = parentNotifications.get(agent.agentId);
		if (pendingBatch) {
			if (pendingBatch.timer) clearTimeout(pendingBatch.timer);
			parentNotifications.delete(agent.agentId);
			message = [...pendingBatch.messages, message].join("\n\n---\n\n");
		}
		const throughSeq = seq;
		const unseen = roleVisibleEvents(agent)
			.filter((event) => event.seq > (agent.lastContextSeq ?? 0) && event.actorId !== agent.agentId)
			.map((event) => `#${event.seq} ${agentPath(event.actorId)} [${event.kind}]: ${event.content}`)
			.join("\n");
		// Written and woken is not read and acted on; the sender only sees the difference here.
		const unanswered = unansweredMessages(events, agent.agentId)
			.map((event) => `#${event.seq} -> ${event.targetIds.map(agentPath).join(", ")} at ${event.timestamp}: delivered, no event from the target since`)
			.join("\n");
		const sections = [
			unseen ? `Formal Team events since your previous wake:\n${unseen}` : "",
			unanswered ? `Messages you sent with no subsequent target activity:\n${unanswered}\nWait for that activity or re-send once; do not assume the target acted.` : "",
		].filter(Boolean);
		const enriched = sections.length ? `${sections.join("\n\n")}\n\nIncoming wake signal:\n${message}` : message;
		await sendRpcPrompt(agent.rpc, enriched);
		agent.lastContextSeq = Math.max(agent.lastContextSeq ?? 0, throughSeq);
		persistState();
	}

	async function publishAssistantText(agent: RuntimeAgent, text: string): Promise<void> {
		if (!text) return;
		agent.pendingParentMessages.push(text);
		appendEvent({ actorId: agent.agentId, content: text, departmentId: agent.departmentId, kind: "message", targetIds: agent.parentId ? [agent.parentId] : [] });
	}

	function scheduleWorkerInspection(agent: RuntimeAgent): void {
		if (agent.role !== "worker" || agent.progressTimer || agent.status !== "running") return;
		agent.progressTimer = setTimeout(() => {
			agent.progressTimer = undefined;
			if (agent.status !== "running") return;
			const hadProgress = agent.pendingParentMessages.length > 0;
			agent.pendingParentMessages.length = 0;
			appendEvent({
				actorId: "supervisor",
				content: `${agentPath(agent.agentId)} is still running at the 10-minute inspection`,
				departmentId: agent.departmentId,
				kind: "status",
				targetIds: agent.parentId ? [agent.parentId] : [],
			});
			void notifyParent(agent, hadProgress ? "New worker inspection events and assistant text are available in formal Team events." : "New worker inspection events are available; the Worker is still running without new assistant text.");
			scheduleWorkerInspection(agent);
		}, INSPECTION_INTERVAL_MS);
	}

	/** A composed directive that never reached a channel is invisible; flag it at settle instead of waiting for the subordinate to go quiet. */
	function flagUndispatchedDirective(agent: RuntimeAgent): void {
		if (agent.role === "worker" || !agent.lastAssistantText) return;
		const subordinates = [...agents.values()]
			.filter((child) => child.parentId === agent.agentId && child.status !== "cancelled")
			.map((child) => ({ agentId: child.agentId, path: agentPath(child.agentId) }));
		const targets = undispatchedTargets(agent.lastAssistantText, subordinates, agent.runTools);
		if (!targets.length || agent.dispatchWarnedFor === agent.lastAssistantText) return;
		agent.dispatchWarnedFor = agent.lastAssistantText;
		const warning = `This turn named ${targets.join(", ")} but called neither team_send nor team_delegate`;
		addDetail(agent, warning);
		appendEvent({ actorId: "supervisor", content: `${warning}. Composing a directive is not dispatching it.`, departmentId: agent.departmentId, kind: "error", targetIds: [agent.agentId] });
		void deliver(agent, `${warning}. If that reply was a directive it was never delivered: dispatch it now with team_send. If it was only a report, reply "no dispatch needed".`)
			.catch((error) => addDetail(agent, `dispatch check delivery failed: ${error instanceof Error ? error.message : String(error)}`));
	}

	async function notifyParent(agent: RuntimeAgent, message: string): Promise<void> {
		const parent = parentOf(agent);
		if (!parent || parent.status === "cancelled") return;
		let batch = parentNotifications.get(parent.agentId);
		if (!batch) {
			batch = { messages: [] };
			parentNotifications.set(parent.agentId, batch);
		}
		if (!batch.messages.includes(message)) batch.messages.push(message);
		if (batch.timer) clearTimeout(batch.timer);
		batch.timer = setTimeout(() => {
			const current = parentNotifications.get(parent.agentId);
			if (!current) return;
			parentNotifications.delete(parent.agentId);
			if (parent.status === "cancelled") return;
			const combined = current.messages.join("\n\n---\n\n");
			deliver(parent, combined).catch((error) => {
				addDetail(parent, `delivery failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, 1_500);
	}

	function onRpcEvent(agent: RuntimeAgent, event: any): void {
		agent.lastEventAt = Date.now();
		switch (event.type) {
			case "agent_start":
				agent.status = "running";
				agent.runCount = (agent.runCount ?? 0) + 1;
				agent.runTools = [];
				agent.lastAssistantText = "";
				agent.lastSettleHadReport = undefined;
				scheduleWorkerInspection(agent);
				persistState();
				addDetail(agent, "agent started");
				break;
			case "agent_settled": {
				if (agent.progressTimer) clearTimeout(agent.progressTimer);
				agent.progressTimer = undefined;
				refreshTokenUsage(agent);
				const missing = (agent.artifacts ?? []).filter((artifact) => !existsSync(resolve(context?.cwd ?? process.cwd(), artifact)));
				if (missing.length) {
					// A declared artifact that is absent turns a plausible "delivered" report into a hard failure.
					addDetail(agent, `settled without required artifact(s): ${missing.join(", ")}`);
					appendEvent({
						actorId: "supervisor",
						content: `${agentPath(agent.agentId)} settled without required artifact(s): ${missing.join(", ")}`,
						departmentId: agent.departmentId,
						kind: "error",
						targetIds: agent.parentId ? [agent.parentId] : [],
					});
					persistState();
					if (agent.artifactNudged) {
						agent.status = "failed";
						persistState();
						void notifyParent(agent, "New subordinate artifact-failure events need attention in formal Team events.");
					} else {
						agent.artifactNudged = true;
						agent.status = "running";
						void deliver(agent, `Required artifact(s) still missing: ${missing.join(", ")}. Create them now, or reply with why they cannot be created.`)
							.catch((error) => { agent.status = "failed"; addDetail(agent, `artifact check delivery failed: ${error instanceof Error ? error.message : String(error)}`); persistState(); });
					}
					break;
				}
				if (agent.artifacts?.length) {
					agent.artifacts = [];
					agent.artifactNudged = false;
				}
				agent.status = "idle";
				addDetail(agent, "agent settled");
				persistState();
				flagUndispatchedDirective(agent);
				const hadReport = agent.pendingParentMessages.length > 0;
				agent.pendingParentMessages.length = 0;
				agent.lastSettleHadReport = hadReport;
				appendEvent({
					actorId: "supervisor",
					content: `${agentPath(agent.agentId)} settled and is idle`,
					departmentId: agent.departmentId,
					kind: "status",
					targetIds: agent.parentId ? [agent.parentId] : [],
				});
				void notifyParent(agent, hadReport ? "New subordinate settled events and assistant text are available in formal Team events." : "New subordinate settled events are available without new assistant text.");
				break;
			}
			case "message_end":
				if (event.message?.role === "assistant") {
					agent.lastAssistantText = getMessageText(event.message);
					void publishAssistantText(agent, agent.lastAssistantText);
				}
				if (event.message?.usage) {
					addTokenUsage(agent, event.message.usage);
					persistState();
				}
				break;
			case "tool_execution_start":
				addDetail(agent, `tool ${event.toolName} started`);
				break;
			case "tool_execution_update":
				addDetail(agent, `tool ${event.toolName} updating`);
				break;
			case "tool_execution_end":
				addDetail(agent, `tool ${event.toolName} ${event.isError ? "failed" : "done"}`);
				if (typeof event.toolName === "string" && !agent.runTools.includes(event.toolName)) agent.runTools.push(event.toolName);
				break;
			case "queue_update":
				addDetail(agent, `queue steer=${event.steering?.length ?? 0} follow=${event.followUp?.length ?? 0}`);
				break;
			case "extension_ui_request":
				addDetail(agent, `UI request ${event.method}`);
				if (["select", "input", "editor", "confirm"].includes(event.method)) {
					agent.process?.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
				}
				break;
		}
		updateUi();
	}

	function refreshTokenUsage(agent: RuntimeAgent): void {
		if (!agent.sessionPath || !existsSync(agent.sessionPath)) return;
		const fileTotal = sumTokenUsage(readJsonLines(agent.sessionPath));
		const current = agent.tokenUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const delta: TokenUsage = {
			input: Math.max(0, fileTotal.input - current.input),
			output: Math.max(0, fileTotal.output - current.output),
			cacheRead: Math.max(0, fileTotal.cacheRead - current.cacheRead),
			cacheWrite: Math.max(0, fileTotal.cacheWrite - current.cacheWrite),
			cost: Math.max(0, fileTotal.cost - current.cost),
		};
		if (delta.input || delta.output || delta.cacheRead || delta.cacheWrite || delta.cost) addIdentityUsage(agent, delta);
		agent.tokenUsage = fileTotal;
	}

	function addTokenUsage(agent: RuntimeAgent, usage: TokenUsage): void {
		const current = agent.tokenUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const delta: TokenUsage = {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			cost: usage.cost?.total ?? 0,
		};
		agent.tokenUsage = {
			input: current.input + delta.input,
			output: current.output + delta.output,
			cacheRead: current.cacheRead + delta.cacheRead,
			cacheWrite: current.cacheWrite + delta.cacheWrite,
			cost: current.cost + delta.cost,
		};
		addIdentityUsage(agent, delta);
	}

	function addIdentityUsage(agent: RuntimeAgent, usage: TokenUsage): void {
		const identity = agent.identity ?? "inherited";
		const current = identityUsage[identity] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		identityUsage[identity] = {
			input: current.input + usage.input,
			output: current.output + usage.output,
			cacheRead: current.cacheRead + usage.cacheRead,
			cacheWrite: current.cacheWrite + usage.cacheWrite,
			cost: current.cost + usage.cost,
		};
	}

	function ensureNativeRoleSession(sessionPath: string): string {
		const nativeSessionDir = resolve(SessionManager.create(context!.cwd).getSessionDir());
		if (resolve(dirname(sessionPath)).toLowerCase() === nativeSessionDir.toLowerCase()) return sessionPath;
		return SessionManager.forkFrom(sessionPath, context!.cwd, nativeSessionDir).getSessionFile()!;
	}

	/**
	 * Per-role config on disk. `sessionPath` is refreshed once the child reports its session file, so a rebuild that
	 * has lost the registry can still reattach the role's own transcript instead of starting it over.
	 */
	function writeInstanceConfig(agent: RuntimeAgent): void {
		const config: TeamInstanceConfig = {
			actorEpoch: agent.actorEpoch,
			agentId: agent.agentId,
			departmentId: agent.departmentId,
			identity: agent.identity,
			name: agent.name,
			parentId: agent.parentId,
			role: agent.role,
			serverUrl,
			sessionPath: agent.sessionPath,
			task: agent.task,
			teamId,
			token: agent.token,
		};
		agent.configPath = join(stateDir, "agents", agent.agentId, "instance.json");
		writeFileSync(agent.configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
	}

	async function waitForReady(agent: RuntimeAgent): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 60; attempt++) {
			try {
				const response = await agent.rpc!.request({ type: "get_state" }, 1000);
				agent.sessionPath = response.data?.sessionFile || agent.sessionPath;
				writeInstanceConfig(agent);
				persistState();
				return;
			} catch (error) {
				lastError = error;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
		throw lastError instanceof Error ? lastError : new Error("RPC child did not become ready");
	}

	async function startAgent(agent: RuntimeAgent, recovering = false): Promise<void> {
		if (!serverUrl) throw new Error("Pi Team Supervisor is not ready");
		mkdirSync(join(stateDir, "agents", agent.agentId), { recursive: true });
		writeInstanceConfig(agent);

		const args = ["--mode", "rpc", "--name", `Pi Team ${agent.agentId}: ${truncate(agent.task, 50)}`, "--extension", extensionPath, `--${TEAM_INSTANCE_FLAG}`, agent.configPath];
		if (recovering && agent.sessionPath && existsSync(agent.sessionPath)) {
			agent.sessionPath = ensureNativeRoleSession(agent.sessionPath);
			args.push("--session", agent.sessionPath);
		}
		const modelPattern = resolveSpawnModel(modelPool, agent.identity, context?.model);
		agent.model = modelPattern;
		if (modelPattern) args.push("--model", modelPattern);
		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, { cwd: context!.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		agent.process = child;
		agent.pid = child.pid;
		if (!agent.pid) {
			child.kill();
			throw new Error(`Could not obtain PID for ${agent.agentId}`);
		}
		try {
			processJob?.assign(agent.pid);
		} catch (error) {
			await pi.exec("taskkill", ["/PID", String(agent.pid), "/T", "/F"], { timeout: 5000 }).catch(() => undefined);
			throw error;
		}
		agent.intentionalStop = false;
		agent.status = recovering ? "recovering" : "starting";
		agent.rpc = new RpcClient(child, (event) => onRpcEvent(agent, event), (line) => addDetail(agent, `non-JSON stdout: ${truncate(line, 200)}`));
		child.stderr.on("data", (chunk) => addDetail(agent, `stderr: ${truncate(chunk.toString(), 300)}`));
		child.on("error", (error) => addDetail(agent, `process error: ${error.message}`));
		child.on("exit", (code, signal) => {
			agent.rpc?.rejectAll(new Error(`${agent.agentId} exited`));
			agent.rpc = undefined;
			agent.process = undefined;
			agent.pid = undefined;
			addDetail(agent, `process exited code=${code} signal=${signal}`);
			const unexpected = !shuttingDown && !agent.intentionalStop && agent.status !== "cancelled";
			if (unexpected) {
				const stderrSnippet = agent.details.filter((detail) => detail.includes("stderr:")).slice(-2).join(" | ");
				appendEvent({
					actorId: "supervisor",
					content: `${agentPath(agent.agentId)} crashed and is recovering (code=${code}, signal=${signal})${stderrSnippet ? `; ${truncate(stderrSnippet, 240)}` : ""}`,
					departmentId: agent.departmentId,
					kind: "error",
					targetIds: agent.parentId ? [agent.parentId] : [],
				});
				void notifyParent(agent, "New subordinate crash and recovery events are available in formal Team events.");
				void recoverAgent(agent);
			}
		});
		await waitForReady(agent);
		appendEvent({ actorId: "supervisor", content: `${agentPath(agent.agentId)} [${agent.role}] started: "${taskSummary(agent.task)}" (${briefReference(agent)})`, departmentId: agent.departmentId, kind: "status", targetIds: agent.parentId ? [agent.parentId] : [] });
		await deliver(agent, buildInitialPrompt(agent, recovering));
		updateUi();
	}

	async function recoverAgent(agent: RuntimeAgent): Promise<void> {
		if (agent.recoveryAttempts >= RECOVERY_LIMIT) {
			agent.status = "failed";
			appendEvent({ actorId: "supervisor", content: `${agentPath(agent.agentId)} recovery failed after ${RECOVERY_LIMIT} attempts`, departmentId: agent.departmentId, kind: "error", targetIds: agent.parentId ? [agent.parentId] : [] });
			void notifyParent(agent, "New subordinate recovery-failure events need attention in formal Team events.");
			persistState();
			return;
		}
		agent.recoveryAttempts += 1;
		agent.actorEpoch = randomUUID();
		agent.token = randomBytes(24).toString("hex");
		agent.status = "recovering";
		await new Promise((resolve) => setTimeout(resolve, 500 * agent.recoveryAttempts));
		try {
			await startAgent(agent, true);
			agent.recoveryAttempts = 0;
		} catch (error) {
			addDetail(agent, `recovery attempt failed: ${error instanceof Error ? error.message : String(error)}`);
			void recoverAgent(agent);
		}
	}

	function childrenOf(parentId: string): RuntimeAgent[] {
		return [...agents.values()].filter((agent) => agent.parentId === parentId && agent.status !== "cancelled");
	}

	async function createAgent(role: TeamRole, task: string, parentId?: string, name?: string, identity?: string): Promise<RuntimeAgent> {
		await startupPromise;
		if (role === "boss" && [...agents.values()].filter((a) => a.role === "boss" && a.status !== "cancelled").length >= MAX_BOSSES) throw new Error(`Maximum Boss count is ${MAX_BOSSES}`);
		const parent = parentId ? agents.get(parentId) : undefined;
		if (role === "lead" && parent?.role !== "boss") throw new Error("Only a Boss can own a Department Lead");
		if (role === "worker" && parent?.role !== "lead") throw new Error("Only a Department Lead can own a Worker");
		const identityKey = identity?.trim() || undefined;
		const model = resolveSpawnModel(modelPool, identityKey, context?.model);
		const requestedName = name?.trim();
		if (requestedName) {
			const invalid = roleNameError(requestedName);
			if (invalid) throw new Error(`Invalid role name "${requestedName}": ${invalid}. ${ROLE_NAME_GUIDE}`);
		}
		const index = nextAgentIndexes[role]++;
		const agentId = `${role}-${index}`;
		const roleName = uniqueRoleName(requestedName || fallbackRoleName(task, `${ROLE_NAMES[role]} ${index}`), [...agents.values()].map((agent) => agent.name));
		const departmentId = role === "lead" ? agentId : role === "worker" ? parent?.departmentId : undefined;
		const agent: RuntimeAgent = {
			actorEpoch: randomUUID(), agentId, artifactNudged: false, configPath: "", departmentId, details: [], identity: identityKey, intentionalStop: false, lastAssistantText: "", lastEventAt: undefined, model,
			name: roleName, parentId, pendingParentMessages: [], progressTimer: undefined, recoveryAttempts: 0, role, runCount: 0, runTools: [],
			status: "starting", task: task.trim(), token: randomBytes(24).toString("hex"),
		};
		agents.set(agentId, agent);
		if (role === "boss" && agents.size === 1) pi.setSessionName(teamSessionName());
		persistState();
		try {
			await startAgent(agent);
			return agent;
		} catch (error) {
			agent.status = "failed";
			appendEvent({
				actorId: "supervisor",
				content: `${agent.agentId} failed to start: ${error instanceof Error ? error.message : String(error)}`,
				departmentId: agent.departmentId,
				kind: "error",
				targetIds: parentId ? [parentId] : [],
			});
			persistState();
			throw error;
		}
	}

	function descendants(agentId: string): RuntimeAgent[] {
		const output: RuntimeAgent[] = [];
		for (const child of agents.values()) {
			if (child.parentId !== agentId) continue;
			output.push(...descendants(child.agentId), child);
		}
		return output;
	}

	async function stopProcess(agent: RuntimeAgent): Promise<void> {
		agent.intentionalStop = true;
		agent.status = "cancelled";
		if (agent.progressTimer) clearTimeout(agent.progressTimer);
		agent.progressTimer = undefined;
		try { await agent.rpc?.request({ type: "abort" }, 2000); } catch {}
		if (agent.pid && process.platform === "win32") {
			await pi.exec("taskkill", ["/PID", String(agent.pid), "/T", "/F"], { timeout: 5000 }).catch(() => undefined);
		} else agent.process?.kill("SIGTERM");
		agent.rpc = undefined;
		agent.process = undefined;
		agent.pid = undefined;
	}

	async function cancelAgent(agentId: string, requester?: RuntimeAgent): Promise<string[]> {
		const target = resolveAgent(agentId);
		if (!target) throw new Error(`Unknown agent: ${agentId}`);
		if (requester && target.parentId !== requester.agentId) throw new Error(`${requester.agentId} may only cancel direct subordinates`);
		const list = [...descendants(agentId), target];
		const paths = new Map(list.map((agent) => [agent.agentId, agentPath(agent.agentId)]));
		for (const agent of list) await stopProcess(agent);
		for (const agent of list) {
			const pending = parentNotifications.get(agent.agentId);
			if (pending?.timer) clearTimeout(pending.timer);
			parentNotifications.delete(agent.agentId);
			agents.delete(agent.agentId);
		}
		if (inspectedAgentId && paths.has(inspectedAgentId)) inspectedAgentId = undefined;
		if (focusedBossId && paths.has(focusedBossId)) focusedBossId = [...agents.values()].find((agent) => agent.role === "boss")?.agentId;
		appendEvent({ actorId: requester?.agentId || "user", content: `Removed ${list.map((agent) => paths.get(agent.agentId)).join(", ")}`, kind: "control", targetIds: list.map((agent) => agent.agentId) });
		persistState();
		updateUi();
		return list.map((agent) => agent.agentId);
	}

	function visibleAgentRecords(requester: RuntimeAgent): RuntimeAgent[] {
		if (requester.role === "boss") return [...agents.values()].filter((agent) => agent.agentId === requester.agentId || agent.parentId === requester.agentId || (agent.parentId && agents.get(agent.parentId)?.parentId === requester.agentId));
		if (requester.role === "lead") return [...agents.values()].filter((agent) => agent.agentId === requester.agentId || agent.parentId === requester.agentId);
		return [requester];
	}

	function visibleAgents(requester: RuntimeAgent): AgentRecord[] {
		return visibleAgentRecords(requester).map(publicAgent);
	}

	/** State-only view: no task text, so a status poll costs the same whether briefs are short or huge. */
	function statusRow(agent: RuntimeAgent): TeamStatusRow {
		return {
			agentId: agent.agentId,
			artifacts: agent.artifacts?.length ? agent.artifacts : undefined,
			departmentId: agent.departmentId,
			identity: agent.identity,
			lastEventAgeMs: agent.lastEventAt && agent.status !== "starting" ? Date.now() - agent.lastEventAt : undefined,
			model: agent.model,
			name: agent.name,
			noReport: agent.status === "idle" && agent.lastSettleHadReport === false ? true : undefined,
			parentId: agent.parentId,
			path: agentPath(agent.agentId),
			role: agent.role,
			runCount: agent.runCount ?? 0,
			status: agent.status,
			taskSummary: taskSummary(agent.task),
		};
	}

	function canMessage(actor: RuntimeAgent, target: RuntimeAgent): boolean {
		return actor.agentId !== target.agentId;
	}

	function authorized(req: IncomingMessage): RuntimeAgent | undefined {
		const actorId = String(req.headers["x-pi-team-actor"] || "");
		const epoch = String(req.headers["x-pi-team-epoch"] || "");
		const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
		const agent = agents.get(actorId);
		return agent && agent.actorEpoch === epoch && agent.token === token ? agent : undefined;
	}

	async function body(req: IncomingMessage): Promise<any> {
		let text = "";
		for await (const chunk of req) {
			text += chunk.toString();
			if (text.length > 1024 * 1024) throw new Error("Request too large");
		}
		return text ? JSON.parse(text) : {};
	}

	function json(res: ServerResponse, status: number, payload: unknown): void {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(payload));
	}

	async function handleIpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// Unauthenticated liveness probe, answered before actor auth: another Supervisor asks whether this team is still
		// running before it adopts the workspace registry. It exposes nothing but the pid and team id.
		if (req.url === "/alive") return json(res, 200, { ok: true, pid: process.pid, teamId });
		const actor = authorized(req);
		if (!actor) {
			const expected = agents.get(String(req.headers["x-pi-team-actor"] || ""));
			return json(res, 401, {
				error: `Unauthorized; expected epoch=${expected?.actorEpoch?.slice(0, 8) ?? "?"} token=${expected?.token?.slice(0, 8) ?? "?"} status=${expected?.status}`,
			});
		}
		try {
			const data = await body(req);
			if (req.url === "/delegate") {
				const role: TeamRole = actor.role === "boss" ? "lead" : actor.role === "lead" ? "worker" : (() => { throw new Error("Workers cannot delegate"); })();
				const task = String(data.task || "").trim();
				const reason = String(data.reason || "").trim();
				if (!task) throw new Error("Delegated task is required");
				if (!reason) throw new Error("Delegation reason is required");
				const agent = await createAgent(role, task, actor.agentId, typeof data.name === "string" ? data.name : undefined, typeof data.identity === "string" ? data.identity : undefined);
				// Soft limit: past CHILD_SOFT_LIMIT the role is still created, but the delegator gets the headcount and states back.
				const warning = childCapacityNote(actor.agentId, childrenOf(actor.agentId));
				const assignment = appendEvent({
					actorId: actor.agentId,
					content: `Delegated ${agentPath(agent.agentId)} "${taskSummary(task)}" (${task.length} chars, ${agent.identity ?? INHERITED_IDENTITY}): ${truncate(reason, 160)}`,
					departmentId: agent.departmentId,
					kind: "assignment",
					targetIds: [agent.agentId],
				});
				return json(res, 200, { agent: publicAgent(agent), eventId: assignment.eventId, seq: assignment.seq, timestamp: assignment.timestamp, warning });
			}
			if (req.url === "/send") {
				const target = resolveAgent(String(data.target || ""), true);
				if (!target) throw new Error("Unknown target");
				if (!canMessage(actor, target)) throw new Error(`${actor.agentId} may only message another role in the same Pi Team`);
				const message = String(data.message || "").trim();
				if (!message) throw new Error("Message is required");
				const event = appendEvent({ actorId: actor.agentId, content: message, departmentId: actor.departmentId, kind: "message", targetIds: [target.agentId] });
				await deliver(target, `A new directed Team message is available in formal Team events (#${event.seq}).`);
				return json(res, 200, { delivered: true, eventId: event.eventId, seq: event.seq, timestamp: event.timestamp });
			}
			if (req.url === "/escalate") {
				const parent = parentOf(actor);
				if (!parent || parent.status === "cancelled") throw new Error("No parent is available to escalate to");
				const reason = String(data.reason || "").trim();
				if (!reason) throw new Error("Escalation reason is required");
				const needed = data.needed === "code" ? "code" : "write";
				const kind = String(data.kind || "mode_change").trim() || "mode_change";
				const event = appendEvent({ actorId: actor.agentId, content: `Escalation ${kind}: needs ${needed}. ${reason}`, departmentId: actor.departmentId, kind: "control", targetIds: [parent.agentId] });
				await deliver(parent, `${agentPath(actor.agentId)} escalated (${kind}: needs ${needed}) as #${event.seq}. Provide the capability or an alternative; the subject is blocked until you answer.`);
				return json(res, 200, { escalated: true, eventId: event.eventId, seq: event.seq });
			}
			if (req.url === "/require-artifact") {
				const artifact = String(data.path || "").trim();
				if (!artifact) throw new Error("Artifact path is required");
				actor.artifacts = [...new Set([...(actor.artifacts ?? []), artifact])];
				actor.artifactNudged = false;
				persistState();
				return json(res, 200, { artifacts: actor.artifacts });
			}
			if (req.url === "/cancel") return json(res, 200, { cancelled: await cancelAgent(String(data.target || ""), actor) });
			if (req.url === "/events") return json(res, 200, { events: roleVisibleEvents(actor, data.drillDown === true).slice(-Math.max(1, Math.min(100, Number(data.limit) || 30))) });
			if (req.url === "/list") return json(res, 200, data.mode === "full" ? { agents: visibleAgents(actor), mode: "full" } : { agents: visibleAgentRecords(actor).map(statusRow), mode: "status" });
			if (req.url === "/identities") return json(res, 200, { models: modelPool, identities: identityRows(modelPool, context?.model) });
			return json(res, 404, { error: "Not found" });
		} catch (error) {
			return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	async function startServer(): Promise<void> {
		server = createServer((req, res) => void handleIpc(req, res));
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Could not start Pi Team IPC server");
		serverUrl = `http://127.0.0.1:${address.port}`;
	}

	pi.registerEntryRenderer<TeamEvent>(TEAM_EVENT_ENTRY, (entry, { expanded }, theme) => {
		const event = entry.data!;
		if (!isMainTranscriptEvent(event)) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg(event.kind === "error" ? "error" : "accent", `[${agentPath(event.actorId)}]`)} ${event.content}`, 0, 0));
		if (expanded) box.addChild(new Text(theme.fg("dim", `#${event.seq} -> ${event.targetIds.map(agentPath).join(", ") || "group"} · ${event.timestamp}`), 0, 0));
		return box;
	});

	pi.registerCommand("identities", { description: "Show the team identity pool", handler: (_args, ctx) => {
		const rows = identityRows(modelPool, ctx.model);
		ctx.ui.notify(rows.map((row) => row.inherited ? `${row.identity}: ${row.pattern ?? "main session model"} (main session model)` : `${row.identity}: ${row.pattern}`).join("\n"), "info");
	}});
	pi.registerCommand("team", { description: "Show Pi Team status", handler: async (_args, ctx) => {
		const sessionFile = context?.sessionManager.getSessionFile() ?? teamSessionMirror?.getSessionFile();
		const ownership = restorableTeam
			? restorableTeam.live
				? `\n${restorableTeam.teamId} is running in another Supervisor; /team-restore to take over`
				: `\npersisted team ${restorableTeam.teamId} was last active ${lastActiveLabel(restorableTeam)}; /team-restore to adopt`
			: "";
		ctx.ui.notify(`${agents.size} agents; focused Boss: ${focusedBossId || "none"}; registry: ${stateDir ? basename(stateDir) : "none"}; session: ${sessionFile || "not created"}; IPC: ${serverUrl || "starting"}${ownership}`, "info");
	}});
	/**
	 * Takeover: end the Supervisor that still holds this team, together with the roles it spawned. Only its own
	 * `/alive` answer is trusted, so a stale snapshot can never make this kill an unrelated process.
	 */
	async function stopForeignOwner(storageId?: string): Promise<boolean> {
		const state = storageId ? readStandaloneState(join(stateRoot, storageId)) : findStandaloneState(stateRoot)?.state;
		if (!state) return false;
		const owner = await supervisorAlive(state);
		if (!owner?.pid) return false;
		if (process.platform === "win32") await pi.exec("taskkill", ["/PID", String(owner.pid), "/T", "/F"], { timeout: 10_000 }).catch(() => undefined);
		else { try { process.kill(owner.pid, "SIGTERM"); } catch {} }
		return true;
	}

	pi.registerCommand("team-restore", { description: "Adopt the persisted Pi Team in this workspace and resume its roles; pass force to end a Supervisor that still holds it", handler: async (args, ctx) => {
		await startupPromise;
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const force = parts.includes("force") || parts.includes("--force");
		const storageId = parts.find((part) => !part.startsWith("-") && part !== "force")?.replace(/^@/, "");
		shuttingDown = true;
		try {
			for (const agent of agents.values()) await stopProcess(agent);
			const target = storageId ? readStandaloneState(join(stateRoot, storageId)) : findStandaloneState(stateRoot)?.state;
			const owner = target ? await supervisorAlive(target) : undefined;
			if (owner && !force) {
				shuttingDown = false;
				const message = `Team ${target!.teamId} is still running in Supervisor pid ${owner.pid}; stop it there first, or run /team-restore force to end it and take over.`;
				appendEvent({ actorId: "supervisor", content: message, kind: "status", targetIds: [] });
				return ctx.ui.notify(message, "warning");
			}
			if (force && (await stopForeignOwner(storageId))) await new Promise((resolve) => setTimeout(resolve, 1500));
			await reconstruct(ctx, "restore", { restore: true, storageId });
		} catch (error) {
			shuttingDown = false;
			return ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		shuttingDown = false;
		resumeTeam();
		updateUi();
		ctx.ui.notify(`Adopted ${teamId}: ${agents.size} agents from ${basename(stateDir)}`, "info");
	}});
	pi.registerCommand("boss", { description: "Create and focus a new Boss", handler: async (args, ctx) => {
		const parts = args.trim().split(/\s+/);
		let identity: string | undefined;
		let task = args.trim();
		if (parts[0] === "--identity" && parts[1]) {
			identity = parts[1];
			task = parts.slice(2).join(" ");
		}
		if (!task) return ctx.ui.notify("Usage: /boss [--identity <name>] <task>", "warning");
		try {
			const agent = await createAgent("boss", task, undefined, undefined, identity);
			focusedBossId = agent.agentId;
			persistState(); updateUi();
			ctx.ui.notify(`Created and focused ${agent.agentId}`, "info");
		} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	}});
	pi.registerCommand("to", { description: "Send a directed message to a team agent", handler: async (args, ctx) => {
		const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
		if (!match) return ctx.ui.notify("Usage: /to <agent-id> <message>", "warning");
		const agent = resolveAgent(match[1]);
		if (!agent) return ctx.ui.notify(`Unknown agent: ${match[1]}`, "error");
		appendEvent({ actorId: "user", content: match[2], departmentId: agent.departmentId, kind: "message", targetIds: [agent.agentId] });
		try { await deliver(agent, "A new directed user message is available in formal Team events."); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	}});
	pi.registerCommand("focus", { description: "Route ordinary input to a Boss", handler: async (args, ctx) => {
		const agent = resolveAgent(args.trim());
		if (!agent || agent.role !== "boss") return ctx.ui.notify("Usage: /focus <boss-id>", "warning");
		focusedBossId = agent.agentId; persistState(); updateUi(); ctx.ui.notify(`Focused ${agent.agentId}`, "info");
	}});
	pi.registerCommand("cancel", { description: "Remove an agent and its descendants from the active team", handler: async (args, ctx) => {
		try { await cancelAgent(args.trim()); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	}});
	pi.registerCommand("agents", { description: "List Pi Team agents", handler: async (_args, ctx) => {
		ctx.ui.notify(formatStatusLines([...agents.values()].map(statusRow)).join("\n") || "No agents.", "info");
	}});
	pi.registerCommand("view", { description: "View recent formal group-chat events", handler: async (args, ctx) => {
		const requested = Number.parseInt(args.trim(), 10);
		const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, requested)) : 30;
		const lines = events.slice(-limit).map((event) => `#${event.seq} ${agentPath(event.actorId)} -> ${event.targetIds.map(agentPath).join(",") || "group"}: ${event.content}`);
		ctx.ui.notify(lines.join("\n") || "No team events.", "info");
	}});
	pi.registerCommand("inspect", { description: "Show one agent's RPC activity in the bottom team panel", handler: async (args, ctx) => {
		const target = args.trim();
		if (target === "off") {
			inspectedAgentId = undefined;
			updateUi();
			return;
		}
		const agent = resolveAgent(target);
		if (!agent) return ctx.ui.notify("Usage: /inspect <agent-id|off>", "warning");
		inspectedAgentId = agent.agentId;
		updateUi();
		ctx.ui.notify([`${agent.name} ${agentPath(agent.agentId)} [${agent.role}/${agent.status} r${agent.runCount ?? 0}]`, `Task: ${agent.task}`, ...agent.details.slice(-10)].join("\n"), "info");
	}});

	pi.on("input", async (event) => {
		if (event.source === "extension" || !focusedBossId) return;
		const agent = agents.get(focusedBossId);
		if (!agent) return;
		appendEvent({ actorId: "user", content: event.text, kind: "message", targetIds: [agent.agentId] });
		try { await deliver(agent, "A new focused user message is available in formal Team events."); } catch (error) { context?.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		return { action: "handled" as const };
	});

	startupPromise = (async () => {
		processJob = await createProcessJob();
		await startServer();
	})();

	pi.on("session_start", async (event, ctx) => {
		shuttingDown = false;
		await startupPromise;
		await reconstruct(ctx, event.reason, { previousSessionFile: event.previousSessionFile });
		resumeTeam();
		updateUi();
	});

	pi.on("session_tree", async (_event, ctx) => {
		shuttingDown = true;
		await startupPromise;
		for (const agent of agents.values()) await stopProcess(agent);
		await reconstruct(ctx, "tree");
		shuttingDown = false;
		resumeTeam();
		updateUi();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		await startupPromise?.catch(() => undefined);
		for (const batch of parentNotifications.values()) if (batch.timer) clearTimeout(batch.timer);
		parentNotifications.clear();
		context?.ui.setWidget(TEAM_WIDGET_KEY, undefined);
		activityPanel = undefined;
		server?.close();
		for (const agent of agents.values()) await stopProcess(agent);
		processJob?.close();
		processJob = undefined;
		startupPromise = undefined;
	});
}
