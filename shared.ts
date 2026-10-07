import { readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatIdentityLines, formatStatusLines, taskSummary, type TeamStatusRow } from "./runtime.ts";
export { ADOPTION_WINDOW_MS, BUILTIN_IDENTITIES, INHERITED_IDENTITY, INSPECTION_INTERVAL_MS, degeneratePoolNote, findStandaloneState, formatAgentTree, formatIdentityLines, formatIdentityUsageLine, formatProgress, formatStatusLines, formatTokenUsage, identityRows, mainModelPattern, readJsonFile, readJsonLines, readModelPool, readStandaloneState, resolveModelPattern, resolveSpawnModel, sendRpcPrompt, sumTokenUsage, supervisorAlive, taskSummary, writeJsonAtomic, type ModelPool, type PersistedState, type RpcPromptRequester, type TeamStatusRow, type TokenUsage } from "./runtime.ts";

export type TeamRole = "boss" | "lead" | "worker";
export type AgentStatus = "starting" | "running" | "idle" | "recovering" | "cancelled" | "failed";

export interface TeamInstanceConfig {
	actorEpoch: string;
	agentId: string;
	departmentId?: string;
	identity?: string;
	parentId?: string;
	role: TeamRole;
	serverUrl: string;
	sessionPath?: string;
	task: string;
	teamId: string;
	token: string;
}

export interface TeamEvent {
	actorId: string;
	content: string;
	departmentId?: string;
	eventId: string;
	kind: "message" | "status" | "assignment" | "control" | "error";
	seq: number;
	targetIds: string[];
	taskId?: string;
	timestamp: string;
}

export interface AgentRecord {
	actorEpoch: string;
	agentId: string;
	artifacts?: string[];
	departmentId?: string;
	identity?: string;
	lastContextSeq?: number;
	model?: string;
	name: string;
	parentId?: string;
	path?: string;
	pid?: number;
	role: TeamRole;
	runCount?: number;
	sessionPath?: string;
	status: AgentStatus;
	task: string;
	tokenUsage?: TokenUsage;
}

export interface TeamSnapshot {
	agents: AgentRecord[];
	focusedBossId?: string;
	teamId: string;
}

export const TEAM_INSTANCE_FLAG = "team-instance";
export const TEAM_EVENT_ENTRY = "pi-team-event";
export const TEAM_STATE_ENTRY = "pi-team-state";
export const CHILD_SOFT_LIMIT = 4;

/** Tools that actually deliver work to a subordinate; prose naming a subordinate is not delivery. */
export const DISPATCH_TOOLS = ["team_send", "team_delegate"] as const;

/**
 * Soft capacity note. Delegation past the limit is accepted, but the delegator is told the resulting headcount and
 * states, so a releasable idle slot is named instead of a generic "too many agents" line. Returns nothing at or
 * under the limit.
 */
export function childCapacityNote(parentId: string, children: { agentId: string; status: AgentStatus }[]): string | undefined {
	if (children.length <= CHILD_SOFT_LIMIT) return undefined;
	const listed = children.map((child) => `${child.agentId} (${child.status})`).join(", ");
	const idle = children.filter((child) => child.status === "idle").length;
	return `${parentId} now has ${children.length} active children, past the soft limit of ${CHILD_SOFT_LIMIT}: ${listed}${idle ? ` — ${idle} idle may be released via team_cancel` : ""}. The role was created; release extra roles unless each one owns genuinely independent work.`;
}

/** Messages this actor sent whose target produced no later event: the sender cannot see "delivered" as "received". */
export function unansweredMessages(events: TeamEvent[], actorId: string, limit = 3): TeamEvent[] {
	const lastSeqByActor = new Map<string, number>();
	for (const event of events) lastSeqByActor.set(event.actorId, Math.max(lastSeqByActor.get(event.actorId) ?? 0, event.seq));
	return events
		.filter((event) => event.actorId === actorId && event.kind === "message" && event.targetIds.length > 0)
		.filter((event) => event.targetIds.every((target) => (lastSeqByActor.get(target) ?? 0) <= event.seq))
		.slice(-limit);
}

/**
 * Direct subordinates named in `text` by a turn that used no dispatch tool.
 * Conservative on purpose: id/path tokens only, no imperative-language heuristics.
 * ponytail: a status report that names a subordinate also matches; the warning is de-duplicated per text instead of parsing intent.
 */
export function undispatchedTargets(text: string, subordinates: { agentId: string; path?: string }[], usedTools: Iterable<string>): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const tools = new Set(usedTools);
	if (DISPATCH_TOOLS.some((tool) => tools.has(tool))) return [];
	return subordinates.filter((agent) => namesAgent(trimmed, agent)).map((agent) => agent.agentId);
}

function namesAgent(text: string, agent: { agentId: string; path?: string }): boolean {
	const escaped = agent.agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`).test(text)) return true;
	return Boolean(agent.path && agent.path !== agent.agentId && text.includes(agent.path));
}

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function getMessageText(message: { content?: unknown } | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => {
			if (!block || typeof block !== "object") return false;
			const item = block as { type?: string; text?: string };
			return item.type === "text" && typeof item.text === "string";
		})
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export function readInstanceConfig(pi: ExtensionAPI): TeamInstanceConfig | undefined {
	const flagIndex = process.argv.findIndex((arg) => arg === `--${TEAM_INSTANCE_FLAG}` || arg.startsWith(`--${TEAM_INSTANCE_FLAG}=`));
	const rawArg = flagIndex === -1
		? undefined
		: process.argv[flagIndex].includes("=")
			? process.argv[flagIndex].slice(process.argv[flagIndex].indexOf("=") + 1)
			: process.argv[flagIndex + 1];
	const configPath = rawArg ?? pi.getFlag(TEAM_INSTANCE_FLAG);
	if (typeof configPath !== "string" || !configPath.trim()) return undefined;
	const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<TeamInstanceConfig>;
	if (
		!normalizeText(parsed.agentId) ||
		!normalizeText(parsed.actorEpoch) ||
		!normalizeText(parsed.serverUrl) ||
		!normalizeText(parsed.teamId) ||
		!normalizeText(parsed.token) ||
		!normalizeText(parsed.task) ||
		!(["boss", "lead", "worker"] as const).includes(parsed.role as TeamRole)
	) {
		throw new Error(`Invalid Pi Team instance config: ${configPath}`);
	}
	return parsed as TeamInstanceConfig;
}

async function request<T>(config: TeamInstanceConfig, path: string, body: unknown): Promise<T> {
	const response = await fetch(`${config.serverUrl}${path}`, {
		method: "POST",
		headers: {
			"authorization": `Bearer ${config.token}`,
			"content-type": "application/json",
			"x-pi-team-actor": config.agentId,
			"x-pi-team-epoch": config.actorEpoch,
		},
		body: JSON.stringify(body),
	});
	const payload = (await response.json()) as { error?: string } & T;
	if (!response.ok) throw new Error(payload.error || `Pi Team request failed: ${response.status}`);
	return payload;
}

export function registerRoleExtension(pi: ExtensionAPI, expectedRole: TeamRole): void {
	const config = readInstanceConfig(pi);
	if (!config) throw new Error(`${expectedRole} extension requires --${TEAM_INSTANCE_FLAG} <config.json>`);
	if (config.role !== expectedRole) throw new Error(`Expected role ${expectedRole}, got ${config.role}`);

	pi.registerTool({
		name: "team_send",
		label: "Team Send",
		description: "Send a directed message to another Pi Team role.",
		parameters: Type.Object({
			target: Type.String({ description: "Target agent ID" }),
			message: Type.String({ description: "Message to deliver" }),
		}),
		async execute(_id, params) {
			const result = await request<{ delivered: boolean; eventId: string; seq: number; timestamp: string }>(config, "/send", params);
			return { content: [{ type: "text", text: `Message delivered to ${params.target} as #${result.seq} at ${result.timestamp}. Delivery is a write, not a read receipt.` }], details: result };
		},
	});

	pi.registerTool({
		name: "team_models",
		label: "Team Models",
		description: "List the identity pool: each identity maps to a model, so delegation can pick one with a suitable price for the business. The built-in identity \"inherited\" always means the main session model; pass it when every role should use the same model instead of writing one tier per role.",
		parameters: Type.Object({}),
		async execute() {
			const result = await request<{ models: Record<string, string>; identities?: { identity: string; inherited?: boolean; pattern?: string }[] }>(config, "/identities", {});
			return { content: [{ type: "text", text: formatIdentityLines(result.models, result.identities).join("\n") }], details: result };
		},
	});

	if (expectedRole !== "worker") {
		pi.registerTool({
			name: "team_delegate",
			label: "Team Delegate",
			description:
				expectedRole === "boss"
					? "Delegate substantive project execution to the minimum sufficient Department Leads. For new non-conflicting tasks, create Leads in parallel by default; do not cancel an existing Team unless the user explicitly says stop, pause, or replace. " + `More than ${CHILD_SOFT_LIMIT} direct Leads is allowed but returns a capacity warning.`
					: "Delegate substantive execution to the minimum sufficient Workers. One coherent task normally needs one Worker; capacity is not a target. " + `More than ${CHILD_SOFT_LIMIT} direct Workers is allowed but returns a capacity warning.`,
			promptGuidelines: expectedRole === "boss"
				? [
					"Do not implement substantive project work yourself; scope it and delegate execution to the minimum sufficient Leads.",
					"For a new set of non-conflicting tasks, create a Lead for each task in parallel by default; use one Lead only when the work is truly one coherent workstream.",
				`${CHILD_SOFT_LIMIT} direct Leads is a soft limit, not a hard cap: past it the delegation still succeeds and returns a capacity warning, so add only genuinely independent work and release the rest via team_cancel.`,
					"Do not cancel an existing Team or its roles unless the user explicitly says stop, pause, or replace.",
					"Call team_models before delegation. Leads normally use high: choose vision-high only for visual or GUI evidence, otherwise text-high; pass only an available identity.",
					"team_list reports state by default; pass mode \"full\" only when you need a role's brief text.",
				]
				: [
					"Do not implement substantive Worker tasks yourself; coordinate, review, and delegate execution.",
					"Use one Worker for one coherent task and add more only for genuinely independent parallel work.",
				`${CHILD_SOFT_LIMIT} direct Workers is a soft limit, not a hard cap: past it the delegation still succeeds and returns a capacity warning, so add only genuinely independent work and release the rest via team_cancel.`,
					"Call team_models before delegation. Prefer medium for ordinary work, low for simple bounded work, and high only for genuinely complex work; choose vision only for visual or GUI evidence, otherwise text.",
					"team_list reports state by default; pass mode \"full\" only when you need a role's brief text.",
				],
			parameters: Type.Object({
				task: Type.String({ description: "Concrete delegated task with a verifiable outcome" }),
				reason: Type.String({ minLength: 12, description: "Why this needs a new role rather than a suitable existing subordinate" }),
				name: Type.Optional(Type.String({ description: "Short display name" })),
				identity: Type.Optional(Type.String({ description: "Available identity returned by team_models, normally text-high/vision-high for Leads and text-medium/vision-medium or low for Workers; \"inherited\" means the main session model" })),
			}),
			async execute(_id, params) {
				const result = await request<{ agent: AgentRecord; eventId: string; seq: number; timestamp: string; warning?: string }>(config, "/delegate", params);
				const reminder = params.identity ? "" : "\nNote: no identity was passed; call team_models and re-delegate with an identity if you have not.";
				const warning = result.warning ? `\nWarning: ${result.warning}` : "";
				return {
					content: [{ type: "text", text: `Created ${result.agent.role} ${result.agent.agentId} "${taskSummary(result.agent.task)}" (brief ${result.agent.task.length} chars) as #${result.seq}.${reminder}${warning}` }],
					details: result,
				};
			},
		});

		pi.registerTool({
			name: "team_cancel",
			label: "Team Remove",
			description: "Stop and remove one of your direct subordinate agents and its descendants from the active team.",
			parameters: Type.Object({ target: Type.String({ description: "Direct subordinate agent ID" }) }),
			async execute(_id, params) {
				const result = await request<{ cancelled: string[] }>(config, "/cancel", params);
				return { content: [{ type: "text", text: `Removed: ${result.cancelled.join(", ")}` }], details: result };
			},
		});
	}

	if (expectedRole !== "boss") {
		pi.registerTool({
			name: "team_escalate",
			label: "Team Escalate",
			description: "Ask your parent for a capability this run does not have (for example write access while the host blocks writes). This wakes your parent with a structured control event instead of a prose request.",
			parameters: Type.Object({
				reason: Type.String({ minLength: 12, description: "What is blocked and what you would do with the capability" }),
				needed: Type.Optional(Type.Union([Type.Literal("write"), Type.Literal("code")], { description: "Capability you need; defaults to write" })),
				kind: Type.Optional(Type.String({ description: "Escalation kind; defaults to mode_change" })),
			}),
			async execute(_id, params) {
				const result = await request<{ escalated: boolean; eventId: string; seq: number }>(config, "/escalate", params);
				return { content: [{ type: "text", text: `Escalated to your parent as #${result.seq}. Do not retry the blocked action until the parent answers.` }], details: result };
			},
		});

		pi.registerTool({
			name: "team_require_artifact",
			label: "Team Require Artifact",
			description: "Declare a file this run must produce. Settling while it is still missing is reported to your parent as a hard failure, not as a clean idle settle.",
			parameters: Type.Object({
				path: Type.String({ description: "Workspace-relative or absolute file path this run must leave on disk" }),
				note: Type.Optional(Type.String({ description: "Why this artifact is the deliverable" })),
			}),
			async execute(_id, params) {
				const result = await request<{ artifacts: string[] }>(config, "/require-artifact", params);
				return { content: [{ type: "text", text: `Artifact obligation recorded: ${params.path}. Settling without it is a failure.` }], details: result };
			},
		});
	}

	pi.registerTool({
		name: "team_read",
		label: "Team Read",
		description: expectedRole === "boss"
			? "Read recent formal events for this Boss. Defaults to user and direct Lead reports; set drillDown to inspect Worker records."
			: "Read recent formal group-chat events visible to this role.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
			drillDown: Type.Optional(Type.Boolean({ description: "Boss only: include Worker-level records" })),
		}),
		async execute(_id, params) {
			const result = await request<{ events: TeamEvent[] }>(config, "/events", { limit: params.limit ?? 30, drillDown: params.drillDown === true });
			const text = result.events
				.map((event) => `#${event.seq} ${event.actorId} -> ${event.targetIds.join(",") || "group"}: ${event.content}`)
				.join("\n");
			return { content: [{ type: "text", text: text || "No visible team events." }], details: result };
		},
	});

	pi.registerTool({
		name: "team_list",
		label: "Team List",
		description: "List the Pi Team roles you are allowed to see. Status mode (default) reports id, role, state, identity, last activity and a one-line task summary; pass mode \"full\" only when you need each role's complete brief text, which is already in your own delegation history.",
		parameters: Type.Object({
			mode: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("full")], { description: "status (default): state only; full: include the complete delegated brief per role" })),
		}),
		async execute(_id, params) {
			const mode = params.mode === "full" ? "full" : "status";
			const result = await request<{ agents: TeamStatusRow[] | AgentRecord[]; mode: string }>(config, "/list", { mode });
			const text = mode === "full"
				? (result.agents as AgentRecord[]).map((agent) => `${agent.path || agent.agentId} [${agent.role}/${agent.status} r${agent.runCount ?? 0}] ${agent.task}`).join("\n")
				: formatStatusLines(result.agents as TeamStatusRow[]).join("\n");
			return { content: [{ type: "text", text: text || "No team agents." }], details: result };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("pi-team-role", `${config.role}:${config.agentId}`);
	});
}
