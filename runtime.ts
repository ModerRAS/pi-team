import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
	parentId?: string;
	role: "boss" | "lead" | "worker";
	runCount?: number;
	status: string;
	tokenUsage?: TokenUsage;
};

export function formatAgentTree(allAgents: TreeAgent[], focusedBossId?: string): string[] {
	const children = (parentId: string, role: TreeAgent["role"]): TreeAgent[] => allAgents.filter((agent) => agent.parentId === parentId && agent.role === role);
	const label = (agent: TreeAgent): string => `${agent.agentId} [${agent.identity ?? "inherited"}: ${agent.model ?? "default"}] [${agent.status} r${agent.runCount ?? 0}]${agent.tokenUsage ? ` ${formatTokenUsage(agent.tokenUsage)}` : ""}`;
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

export function resolveModelPattern(pool: ModelPool, identity?: string): string | undefined {
	if (!identity) return pool.default;
	const pattern = pool[identity];
	if (!pattern) throw new Error(`Unknown identity: "${identity}". Add it to .pi/pi-team/identities.json; configured: ${Object.keys(pool).join(", ") || "none"}`);
	return pattern;
}

export function resolveSpawnModel(pool: ModelPool, identity: string | undefined, mainModel: { provider: string; id: string } | undefined): string | undefined {
	if (identity) return resolveModelPattern(pool, identity);
	return mainModel ? `${mainModel.provider}/${mainModel.id}` : undefined;
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

export async function sendRpcPrompt(rpc: RpcPromptRequester, message: string): Promise<void> {
	await rpc.request({ type: "prompt", message, streamingBehavior: "steer" });
}
