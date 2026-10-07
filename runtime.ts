import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRecord, TeamEvent, TeamInstanceConfig, TeamRole, TeamSnapshot } from "./shared.ts";

export interface RpcPromptRequester {
	request(command: { message: string; streamingBehavior: "steer"; type: "prompt" }): Promise<unknown>;
}

export type ModelPool = Record<string, string>;

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

type TreeAgent = {
	agentId: string;
	identity?: string;
	model?: string;
	name?: string;
	parentId?: string;
	role: "boss" | "lead" | "worker";
	runCount?: number;
	status: string;
	tokenUsage?: TokenUsage;
};

export function formatAgentTree(allAgents: TreeAgent[], focusedBossId?: string): string[] {
	const children = (parentId: string, role: TreeAgent["role"]): TreeAgent[] => allAgents.filter((agent) => agent.parentId === parentId && agent.role === role);
	const label = (agent: TreeAgent): string => `${agent.name && agent.name !== agent.agentId ? `${agent.name} (${agent.agentId})` : agent.agentId} [${agent.identity ?? "inherited"}: ${agent.model ?? "default"}] [${agent.status} r${agent.runCount ?? 0}]${agent.tokenUsage ? ` ${formatTokenUsage(agent.tokenUsage)}` : ""}`;
	const lines: string[] = [];
	for (const boss of allAgents.filter((agent) => agent.role === "boss")) {
		lines.push(`${boss.agentId === focusedBossId ? ">" : " "} ${label(boss)}`);
		const leads = children(boss.agentId, "lead");
		leads.forEach((lead, leadIndex) => {
			const lastLead = leadIndex === leads.length - 1;
			const workers = children(lead.agentId, "worker");
			lines.push(`  ${lastLead ? "└─" : "├─"} ${label(lead)} (${workers.length} worker${workers.length === 1 ? "" : "s"})`);
			workers.forEach((worker, workerIndex) => {
				lines.push(`  ${lastLead ? "   " : "│  "}${workerIndex === workers.length - 1 ? "└─" : "├─"} ${label(worker)}`);
			});
		});
	}
	return lines;
}

export const BUILTIN_IDENTITIES = ["text-high", "text-medium", "text-low", "vision-high", "vision-medium", "vision-low"] as const;

export function readModelPool(poolPath: string): ModelPool {
	return readJsonFile<ModelPool>(poolPath) ?? {};
}

/**
 * Reserved identity meaning "the main session model".
 * Some callers cannot act on an unconfigured pool, so `team_models` always lists this row; an explicit pool
 * entry with this name wins.
 */
export const INHERITED_IDENTITY = "inherited";

export function mainModelPattern(mainModel: { provider: string; id: string } | undefined): string | undefined {
	return mainModel ? `${mainModel.provider}/${mainModel.id}` : undefined;
}

export function resolveModelPattern(pool: ModelPool, identity?: string): string | undefined {
	if (!identity) return pool.default;
	const pattern = pool[identity];
	if (!pattern) throw new Error(`Unknown identity: "${identity}". Add it to .pi/pi-team/identities.json; configured: ${Object.keys(pool).join(", ") || "none"}; built-in: "${INHERITED_IDENTITY}" (main session model)`);
	return pattern;
}

export function resolveSpawnModel(pool: ModelPool, identity: string | undefined, mainModel: { provider: string; id: string } | undefined): string | undefined {
	const key = identity?.trim();
	if (!key) return mainModelPattern(mainModel);
	if (key === INHERITED_IDENTITY && !pool[key]) return mainModelPattern(mainModel);
	return resolveModelPattern(pool, key);
}

/** Effective identity list for `team_models`: the configured pool plus the built-in `inherited` row. */
export function identityRows(pool: ModelPool, mainModel?: { provider: string; id: string }): { identity: string; inherited?: boolean; pattern?: string }[] {
	const rows: { identity: string; inherited?: boolean; pattern?: string }[] = Object.entries(pool).map(([identity, pattern]) => ({ identity, pattern }));
	if (!(INHERITED_IDENTITY in pool)) rows.push({ identity: INHERITED_IDENTITY, inherited: true, pattern: mainModelPattern(mainModel) });
	return rows;
}

export const INSPECTION_INTERVAL_MS = 10 * 60_000;

/** Role labels are single tokens: they label a role in the Team panel and can address it in team tools. */
export const ROLE_NAME_MAX = 24;
const ROLE_NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;
const ROLE_NAME_RESERVED = new Set(["off", "group", "supervisor", "user"]);

/** Why a delegator-supplied role name cannot be used, or undefined when it is valid. */
export function roleNameError(name: string): string | undefined {
	const trimmed = name.trim();
	if (!trimmed) return "it is empty";
	if (trimmed.length > ROLE_NAME_MAX) return `it is longer than ${ROLE_NAME_MAX} characters`;
	if (/\s/.test(trimmed)) return "it contains whitespace";
	if (!ROLE_NAME_PATTERN.test(trimmed)) return 'it contains characters other than letters, digits, "-" and "_"';
	if (/^(?:boss|lead|worker)-\d+$/i.test(trimmed)) return "it looks like an agent id";
	if (ROLE_NAME_RESERVED.has(trimmed.toLowerCase())) return "it is a reserved word";
	return undefined;
}

/** Guidance attached to a rejected name so the delegating model can retry with a valid one. */
export const ROLE_NAME_GUIDE = `Pass a short workstream label as name: 1-${ROLE_NAME_MAX} letters, digits, "-" or "_" (no spaces, no / # @ : [ ]), unique within the Team, for example "nav-tree" or "发布线".`;

function sanitizeRoleName(value: string): string {
	return value.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, ROLE_NAME_MAX).replace(/-$/, "");
}

/** A valid label derived from the brief, used when the delegator did not name the role. */
export function fallbackRoleName(task: string, fallback: string): string {
	const derived = sanitizeRoleName(taskSummary(task, ROLE_NAME_MAX));
	if (derived && !roleNameError(derived)) return derived;
	const source = derived || sanitizeRoleName(fallback) || "role";
	// Sanitizing cannot introduce punctuation, so the only rejectable form left is an id-like label.
	const tail = "-role";
	return roleNameError(source) ? `${source.slice(0, ROLE_NAME_MAX - tail.length)}${tail}` : source;
}

/** Keeps labels unambiguous: name resolution must never hit two roles, so duplicates get a numeric suffix. */
export function uniqueRoleName(name: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	if (!used.has(name)) return name;
	for (let suffix = 2; suffix < 1000; suffix++) {
		const tail = `-${suffix}`;
		const candidate = `${name.slice(0, ROLE_NAME_MAX - tail.length)}${tail}`;
		if (!used.has(candidate)) return candidate;
	}
	return name;
}

/** One line identifying a delegated brief without carrying its body. */
export function taskSummary(task: string, max = 80): string {
	const firstLine = task.split(/\r?\n/).find((line) => line.trim()) ?? "";
	const normalized = firstLine.replace(/\s+/g, " ").trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/** State of one role for `team_list` status mode: identity, activity, and the brief's first line instead of the brief. */
export interface TeamStatusRow {
	agentId: string;
	artifacts?: string[];
	departmentId?: string;
	identity?: string;
	lastEventAgeMs?: number;
	model?: string;
	name?: string;
	noReport?: boolean;
	parentId?: string;
	path: string;
	role: "boss" | "lead" | "worker";
	runCount: number;
	status: string;
	taskSummary: string;
}

/** Compact status form: enough to answer "who is running, what finished, what is stuck" without re-reading briefs. */
export function formatStatusLines(rows: TeamStatusRow[]): string[] {
	const age = (ms: number): string => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;
	const lines = rows.map((row) => {
		const parts = [row.name ? `${row.name} (${row.path})` : row.path, `[${row.role}/${row.status} r${row.runCount}]`, row.identity ?? "inherited", `"${row.taskSummary}"`];
		if (row.lastEventAgeMs !== undefined) parts.push(`last event ${age(row.lastEventAgeMs)} ago`);
		if (row.noReport) parts.push("no report since settle");
		if (row.artifacts?.length) parts.push(`requires ${row.artifacts.join(", ")}`);
		return parts.join(" ");
	});
	const stuck = rows.filter((row) => row.status === "running" && (row.lastEventAgeMs ?? 0) > INSPECTION_INTERVAL_MS);
	if (stuck.length) lines.push(`ATTENTION: ${stuck.map((row) => `${row.path} running with no event for ${age(row.lastEventAgeMs ?? 0)}`).join("; ")}`);
	return lines;
}

/** Note when every configured tier aliases one model, so identical rows are not read as separate choices. */
export function degeneratePoolNote(pool: ModelPool): string | undefined {
	const patterns = Object.values(pool);
	if (patterns.length < 2 || new Set(patterns).size > 1) return undefined;
	return `All ${patterns.length} tiers map to ${patterns[0]}. If one model is intended, drop the pool file and pass identity "${INHERITED_IDENTITY}" instead.`;
}

/** Lines printed by `team_models`: the effective identities, then the empty-pool hint and the degenerate-pool note. */
export function formatIdentityLines(models: ModelPool, identities?: { identity: string; inherited?: boolean; pattern?: string }[]): string[] {
	const rows: { identity: string; inherited?: boolean; pattern?: string }[] = identities ?? Object.entries(models).map(([identity, pattern]) => ({ identity, pattern }));
	const lines = rows.map((row) => {
		if (!row.inherited) return `${row.identity}: ${row.pattern}`;
		return row.pattern
			? `${row.identity}: ${row.pattern} (main session model; pass identity "${row.identity}")`
			: `${row.identity} (main session model; pass identity "${row.identity}")`;
	});
	if (!Object.keys(models).length) lines.push(`No identity pool configured; add .pi/pi-team/identities.json to choose a model per tier, or keep passing identity "${INHERITED_IDENTITY}".`);
	const note = degeneratePoolNote(models);
	if (note) lines.push(note);
	return lines;
}

export function formatProgress(progress: unknown): string {
	const items = Array.isArray(progress) ? progress : [progress];
	return items.filter((item): item is string => typeof item === "string").join("\n\n");
}

interface UsageEntry {
	message?: { role?: string; usage?: TokenUsage };
	type?: string;
	usage?: TokenUsage;
}

/** Sum session usage from assistant messages, nested toolResult LLM work, and compaction/branch summaries. */
export function sumTokenUsage(entries: unknown[]): TokenUsage {
	const totals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries as UsageEntry[]) {
		let usage: TokenUsage | undefined;
		if (entry.message?.role === "assistant") usage = entry.message.usage;
		else if (entry.message?.role === "toolResult" && entry.message.usage) usage = entry.message.usage;
		else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) usage = entry.usage;
		if (!usage) continue;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		totals.cost += usage.cost?.total ?? 0;
	}
	return totals;
}

export function formatTokenUsage(usage?: TokenUsage): string {
	if (!usage) return "";
	const count = compactCount;
	const cost = formatCost;
	const parts = [`in ${count(usage.input)}`, `out ${count(usage.output)}`, `cache ${count((usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0))}`];
	if ((usage.cost ?? 0) > 0) parts.push(cost(usage.cost));
	return parts.join(" ");
}

function compactCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	const fixed = value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value >= 0.01 ? value.toFixed(4) : value.toFixed(6);
	return `$${fixed.replace(/\.?0+$/, "")}`;
}

/** Session-wide per-identity totals: only consumed tiers, in/out/cache slash-compact to stay inside the bottom bar. */
export function formatIdentityUsageLine(usageByIdentity: Record<string, TokenUsage> | undefined): string {
	if (!usageByIdentity) return "";
	const others = Object.keys(usageByIdentity).filter((key) => !(BUILTIN_IDENTITIES as readonly string[]).includes(key)).sort();
	const parts: string[] = [];
	for (const identity of [...BUILTIN_IDENTITIES, ...others]) {
		const usage = usageByIdentity[identity];
		if (!usage || (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite && !usage.cost)) continue;
		const base = `${compactCount(usage.input)}/${compactCount(usage.output)}/${compactCount((usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0))}`;
		parts.push(`${identity} ${(usage.cost ?? 0) > 0 ? `${base} ${formatCost(usage.cost)}` : base}`);
	}
	return parts.join(" | ");
}

export function readJsonFile<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function readJsonLines<T>(path: string): T[] {
	try {
		return readFileSync(path, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.flatMap((line) => {
				try { return [JSON.parse(line) as T]; }
				catch { return []; }
			});
	} catch {
		return [];
	}
}

export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
	renameSync(temporaryPath, path);
}

export interface PersistedState extends TeamSnapshot {
	identityUsage?: Record<string, TokenUsage>;
	nextAgentIndexes?: Record<TeamRole, number>;
	/** Directory name of the storage this snapshot belongs to; also the workspace registry key. */
	storageId?: string;
	supervisorSessionPath?: string;
	/** Loopback IPC address of the Supervisor that wrote this snapshot, used only for the liveness probe. */
	supervisorUrl?: string;
	updatedAt?: string;
	version: 1;
}

/**
 * One team directory. Prefers the atomic snapshot; without it, rebuilds the structure chain from the per-role
 * `instance.json` files and the cancellation events, so losing `state.json` costs history but not the hierarchy.
 */
export function readStandaloneState(directory: string): PersistedState | undefined {
	const stored = readJsonFile<PersistedState>(join(directory, "state.json"));
	if (stored?.version === 1 && Array.isArray(stored.agents)) return stored;

	const agentsDirectory = join(directory, "agents");
	if (!existsSync(agentsDirectory)) return undefined;
	const storedEvents = readJsonLines<TeamEvent>(join(directory, "events.jsonl"));
	const cancelled = new Set(storedEvents.filter((event) => event.kind === "control" && /^(Cancelled|Removed) /.test(event.content)).flatMap((event) => event.targetIds));
	const records: AgentRecord[] = [];
	let legacyTeamId: string | undefined;
	for (const entry of readdirSync(agentsDirectory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const config = readJsonFile<TeamInstanceConfig>(join(agentsDirectory, entry.name, "instance.json"));
		if (!config?.agentId || !config.task || !(["boss", "lead", "worker"] as const).includes(config.role)) continue;
		if (cancelled.has(config.agentId)) continue;
		legacyTeamId ??= config.teamId;
		const legacySessionDirectory = join(agentsDirectory, entry.name, "sessions");
		const legacySessionPath = existsSync(legacySessionDirectory)
			? readdirSync(legacySessionDirectory)
				.filter((name) => name.endsWith(".jsonl"))
				.map((name) => join(legacySessionDirectory, name))
				.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
			: undefined;
		const sessionPath = config.sessionPath && existsSync(config.sessionPath) ? config.sessionPath : legacySessionPath;
		records.push({
			actorEpoch: config.actorEpoch,
			agentId: config.agentId,
			departmentId: config.departmentId,
			name: config.name ?? config.agentId,
			parentId: config.parentId,
			role: config.role,
			runCount: 0,
			sessionPath,
			identity: config.identity,
			status: "recovering",
			task: config.task,
		});
	}
	if (!legacyTeamId || !records.length) return undefined;
	return { version: 1, teamId: legacyTeamId, focusedBossId: records.find((agent) => agent.role === "boss")?.agentId, agents: records };
}

/** The workspace registry written outside every state directory: full snapshot plus the storage directory it belongs to. */
export function readRegistryState(root: string): { directory: string; state: PersistedState } | undefined {
	const registry = readJsonFile<PersistedState>(join(root, "latest.json"));
	if (registry?.version !== 1 || !Array.isArray(registry.agents) || !registry.storageId) return undefined;
	if (!/^[A-Za-z0-9_-]+$/.test(registry.storageId)) return undefined;
	return { directory: join(root, registry.storageId), state: registry };
}

/**
 * Self-owned recovery source. Order: an explicit/preferred directory, the workspace registry, a legacy pointer, then
 * every state directory newest-first. Deliberately independent of any Pi session file.
 */
export function findStandaloneState(root: string, preferredDirectory?: string): { directory: string; state: PersistedState } | undefined {
	const registry = readRegistryState(root);
	const pointer = registry ? undefined : readJsonFile<{ storageId?: string }>(join(root, "latest.json"));
	const pointedDirectory = pointer?.storageId && /^[A-Za-z0-9_-]+$/.test(pointer.storageId) ? join(root, pointer.storageId) : undefined;
	const directories = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name))
		.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
	const candidates = [...new Set([preferredDirectory, registry?.directory, pointedDirectory, ...directories].filter((directory): directory is string => Boolean(directory)))];
	for (const directory of candidates) {
		const state = directory === registry?.directory ? registry.state : readStandaloneState(directory);
		if (state) return { directory, state };
	}
	return undefined;
}

/** How old a persisted team may be and still be adopted automatically; older teams need `/team-restore`. */
export const ADOPTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The live Supervisor still running this team, when one answers. The probe goes to the loopback address recorded in
 * the snapshot, so a recycled port or PID cannot fake it, and a Supervisor never counts its own process as foreign
 * (a `/reload` re-entry in the same process answers with its own pid).
 */
export async function supervisorAlive(state: Pick<PersistedState, "supervisorUrl" | "teamId">): Promise<{ pid?: number } | undefined> {
	if (!state.supervisorUrl || !state.teamId) return undefined;
	try {
		const response = await fetch(`${state.supervisorUrl}/alive`, { method: "POST", signal: AbortSignal.timeout(700) });
		if (!response.ok) return undefined;
		const payload = (await response.json()) as { pid?: number; teamId?: string };
		return payload.teamId === state.teamId && payload.pid !== process.pid ? payload : undefined;
	} catch {
		return undefined;
	}
}

export async function sendRpcPrompt(rpc: RpcPromptRequester, message: string): Promise<void> {
	await rpc.request({ type: "prompt", message, streamingBehavior: "steer" });
}
