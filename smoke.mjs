import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const cwd = mkdtempSync(join(tmpdir(), "pi-team-smoke-"));
const extension = resolve(import.meta.dirname, "index.ts");
const command = process.platform === "win32" ? "pi.cmd" : "pi";
const child = spawn(command, ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension], {
	cwd,
	shell: process.platform === "win32",
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
});
const decoder = new StringDecoder("utf8");
let buffer = "";
let stderr = "";
let nextId = 1;
const events = [];
const pending = new Map();
let nativeSessionDir;
let teamAgentDir;

function send(type, fields = {}) {
	const id = `smoke-${nextId++}`;
	child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${type} timed out`));
		}, 60_000);
		pending.set(id, { resolve: resolvePromise, reject, timer });
	});
}

function onLine(line) {
	if (!line.trim()) return;
	let event;
	try { event = JSON.parse(line); }
	catch { events.push({ type: "non-json", line }); return; }
	events.push(event);
	if (event.type !== "response" || !event.id || !pending.has(event.id)) return;
	const item = pending.get(event.id);
	clearTimeout(item.timer);
	pending.delete(event.id);
	event.success ? item.resolve(event) : item.reject(new Error(event.error || `${event.command} failed`));
}

child.stdout.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) break;
		let line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		onLine(line);
	}
});
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

async function postAs(config, path, body, retries = 50) {
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
	const payload = await response.json();
	if (response.status === 401 && retries > 0 && teamAgentDir) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
		Object.assign(config, JSON.parse(readFileSync(join(teamAgentDir, config.agentId, "instance.json"), "utf8")));
		return postAs(config, path, body, retries - 1);
	}
	if (!response.ok) {
		const entryResponse = await send("get_entries").catch(() => undefined);
		const recentEvents = (entryResponse?.data?.entries ?? [])
			.filter((entry) => entry.customType === "pi-team-event")
			.slice(-15)
			.map((entry) => `#${entry.data?.seq} ${entry.data?.actorId} [${entry.data?.kind}]: ${String(entry.data?.content).slice(0, 90)}`);
		throw new Error(`${path} as ${config.agentId} with ${JSON.stringify(body)} failed: ${payload.error || response.status}; recent events: ${JSON.stringify(recentEvents)}`);
	}
	return payload;
}

async function expectRejected(action, fragment) {
	try {
		await action();
	} catch (error) {
		if (String(error).includes(fragment)) return;
		throw error;
	}
	throw new Error(`Expected rejection containing: ${fragment}`);
}

async function waitForEntry(predicate, timeoutMs = 180_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const response = await send("get_entries");
		const entries = response.data?.entries ?? [];
		const startupError = [...entries].reverse().find((entry) =>
			entry.customType === "pi-team-event" &&
			entry.data?.kind === "error" &&
			/(failed to start|recovery failed)/.test(entry.data?.content || ""),
		);
		if (startupError) throw new Error(startupError.data.content);
		if (predicate(entries)) return entries;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
	}
	throw new Error(`Expected session entry timed out. Recent events: ${JSON.stringify(events.slice(-20))}`);
}

try {
	await send("get_state");
	await send("prompt", { message: "/boss Reply with exactly BOSS_SMOKE_ONE and no other text." });
	const firstEntries = await waitForEntry((entries) => entries.some((entry) => entry.customType === "pi-team-event" && entry.data?.actorId === "boss-1" && entry.data?.content.includes("BOSS_SMOKE_ONE")));
	const firstBossState = [...firstEntries].reverse().find((entry) => entry.customType === "pi-team-state" && entry.data?.agents?.some((agent) => agent.agentId === "boss-1" && agent.pid));
	const firstBossRecord = firstBossState?.data?.agents?.find((agent) => agent.agentId === "boss-1");
	const firstBossPid = firstBossRecord?.pid;
	const supervisorSessionPath = firstBossState?.data?.supervisorSessionPath;
	if (!firstBossPid) throw new Error("Initial Boss PID was not persisted");
	if (!firstBossRecord.sessionPath || !existsSync(firstBossRecord.sessionPath)) throw new Error("Boss did not create a native Pi session");
	if (!supervisorSessionPath || !existsSync(supervisorSessionPath)) throw new Error("Supervisor did not create a native Pi session anchor");
	nativeSessionDir = dirname(supervisorSessionPath);
	if (dirname(firstBossRecord.sessionPath).toLowerCase() !== nativeSessionDir.toLowerCase()) throw new Error("Boss session was not stored in Pi's native project session directory");
	if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(firstBossPid), "/F"], { stdio: "ignore" });
	else process.kill(firstBossPid, "SIGKILL");
	const recoveredEntries = await waitForEntry((entries) => entries.some((entry) => entry.customType === "pi-team-state" && entry.data?.agents?.some((agent) => agent.agentId === "boss-1" && agent.pid && agent.pid !== firstBossPid && agent.status === "idle")));
	const recoveredBoss = [...recoveredEntries].reverse().find((entry) => entry.customType === "pi-team-state")?.data?.agents?.find((agent) => agent.agentId === "boss-1");
	if (recoveredBoss?.sessionPath !== firstBossRecord.sessionPath) throw new Error("Boss recovery did not continue the same native Pi session");
	await send("prompt", { message: "/to boss-1 Reply with exactly BOSS_SMOKE_TWO and no other text." });
	const entries = await waitForEntry((items) => items.some((entry) => entry.customType === "pi-team-event" && entry.data?.actorId === "boss-1" && entry.data?.content.includes("BOSS_SMOKE_TWO")));
	const usageState = await waitForEntry((items) => items.some((entry) => entry.customType === "pi-team-state" && entry.data?.agents?.some((agent) => agent.agentId === "boss-1" && agent.tokenUsage && agent.tokenUsage.output > 0)));
	const usageBoss = [...usageState].reverse().find((entry) => entry.customType === "pi-team-state")?.data?.agents?.find((agent) => agent.agentId === "boss-1");
	if (!usageBoss?.tokenUsage?.input) throw new Error("Boss token usage was not collected from its session");
	if (usageBoss.tokenUsage.input <= 0 || usageBoss.tokenUsage.output <= 0) throw new Error("Boss token usage was not persisted from its session");
	const firstUsageEntry = [...usageState].findIndex((entry) => entry.customType === "pi-team-state" && entry.data?.agents?.some((agent) => agent.agentId === "boss-1" && agent.tokenUsage?.output > 0));
	const firstSettledEntry = [...usageState].findIndex((entry) => entry.customType === "pi-team-event" && entry.data?.actorId === "supervisor" && entry.data?.content.includes("settled and is idle"));
	if (firstUsageEntry === -1 || firstSettledEntry === -1 || firstUsageEntry > firstSettledEntry) throw new Error("Boss token usage was not tracked in real time before settle");
	const latest = JSON.parse(readFileSync(join(cwd, ".pi", "pi-team", "latest.json"), "utf8"));
	teamAgentDir = join(cwd, ".pi", "pi-team", latest.storageId, "agents");
	const bossConfig = JSON.parse(readFileSync(resolve(teamAgentDir, "boss-1/instance.json"), "utf8"));
	const lead = (await postAs(bossConfig, "/delegate", { task: "Capacity smoke lead; wait for direction.", reason: "Exercise the explicit maximum-capacity control path.", name: "Capacity Lead" })).agent;
	const leadConfig = JSON.parse(readFileSync(resolve(teamAgentDir, `${lead.agentId}/instance.json`), "utf8"));
	const workers = await Promise.all(Array.from({ length: 4 }, (_, index) => postAs(leadConfig, "/delegate", { task: `Capacity smoke worker ${index + 1}; wait for direction.`, reason: `Verify concurrent Worker slot ${index + 1} remains available for complex tasks.` })));
	if (new Set(workers.map((result) => result.agent.agentId)).size !== 4) throw new Error("Worker IDs were not unique");
	const workerConfigs = workers.map((result) => JSON.parse(readFileSync(resolve(teamAgentDir, `${result.agent.agentId}/instance.json`), "utf8")));
	const crossLead = (await postAs(bossConfig, "/delegate", { task: "Cross-branch messaging smoke lead; wait for direction.", reason: "Create a second department to verify same-Team cross-branch messaging.", name: "Capacity Lead" })).agent;
	const crossLeadConfig = JSON.parse(readFileSync(resolve(teamAgentDir, `${crossLead.agentId}/instance.json`), "utf8"));
	const crossWorker = (await postAs(crossLeadConfig, "/delegate", { task: "Cross-branch messaging smoke worker; wait for direction.", reason: "Provide a Worker under a different Lead for messaging verification.", name: "Cross Branch Worker" })).agent;
	const crossWorkerConfig = JSON.parse(readFileSync(resolve(teamAgentDir, `${crossWorker.agentId}/instance.json`), "utf8"));

	const messages = {
		parentChild: "TEAM_MSG_PARENT_CHILD",
		siblingWorker: "TEAM_MSG_SIBLING_WORKER",
		crossWorker: "TEAM_MSG_CROSS_WORKER",
		siblingLead: "TEAM_MSG_SIBLING_LEAD",
		nonDirectLeadWorker: "TEAM_MSG_NONDIRECT_LEAD_WORKER",
		reverseLeadWorker: "TEAM_MSG_REVERSE_LEAD_WORKER",
	};
	await postAs(leadConfig, "/send", { target: `@${workers[0].agent.agentId}`, message: messages.parentChild });
	await postAs(workerConfigs[0], "/send", { target: `@${workers[1].agent.path}`, message: messages.siblingWorker });
	await postAs(workerConfigs[0], "/send", { target: "@Cross Branch Worker", message: messages.crossWorker });
	await postAs(leadConfig, "/send", { target: crossLead.path, message: messages.siblingLead });
	await postAs(leadConfig, "/send", { target: crossWorker.agentId, message: messages.nonDirectLeadWorker });
	await postAs(crossWorkerConfig, "/send", { target: lead.agentId, message: messages.reverseLeadWorker });
	await expectRejected(() => postAs(workerConfigs[0], "/send", { target: workers[0].agent.agentId, message: "self must fail" }), "may only message another role in the same Pi Team");
	await expectRejected(() => postAs(workerConfigs[0], "/send", { target: "@missing-worker", message: "unknown must fail" }), "Unknown target");
	await expectRejected(() => postAs(workerConfigs[0], "/send", { target: "@Capacity Lead", message: "ambiguous must fail" }), "Ambiguous target name");
	await expectRejected(() => postAs({ ...workerConfigs[0], actorEpoch: "foreign-team-epoch", token: "foreign-team-token" }, "/send", { target: crossWorker.agentId, message: "cross-team must fail" }, 0), "Unauthorized");
	await expectRejected(() => postAs(workerConfigs[0], "/delegate", { task: "must fail", reason: "Workers still cannot delegate team roles." }), "Workers cannot delegate");
	await expectRejected(() => postAs(leadConfig, "/cancel", { target: crossWorker.agentId }), "may only cancel direct subordinates");

	const messagingEntries = await waitForEntry((items) => Object.values(messages).every((message) => items.some((entry) => entry.customType === "pi-team-event" && entry.data?.kind === "message" && entry.data?.content === message)));
	const crossMessage = messagingEntries.find((entry) => entry.customType === "pi-team-event" && entry.data?.content === messages.crossWorker);
	if (crossMessage?.data?.actorId !== workers[0].agent.agentId || crossMessage.data.targetIds?.[0] !== crossWorker.agentId) throw new Error("Cross-worker group-chat event lost authenticated actor or target identity");

	let fifthRejected = false;
	try { await postAs(leadConfig, "/delegate", { task: "This fifth worker must be rejected.", reason: "Verify the hard safety ceiling still rejects a fifth concurrent Worker." }); }
	catch (error) { fifthRejected = String(error).includes("already has 4 active children"); }
	if (!fifthRejected) throw new Error("Fifth Worker was not rejected by the capacity limit");
	await postAs(leadConfig, "/cancel", { target: workers[0].agent.agentId });
	let listed = await postAs(leadConfig, "/list", {});
	if (listed.agents.some((agent) => agent.agentId === workers[0].agent.agentId) || listed.agents.filter((agent) => agent.role === "worker").length !== 3) throw new Error("Lead removal did not delete its direct Worker from the active team");
	const replacement = (await postAs(leadConfig, "/delegate", { task: "Replacement capacity smoke worker; wait for direction.", reason: "Verify removed capacity can be reused without reusing an old agent ID." })).agent;
	if (workers.some((worker) => worker.agent.agentId === replacement.agentId)) throw new Error("Removed Worker agent ID was reused");
	listed = await postAs(leadConfig, "/list", {});
	if (listed.agents.filter((agent) => agent.role === "worker").length !== 4) throw new Error("Lead could not restore four active Workers after removal");
	await postAs(bossConfig, "/cancel", { target: lead.agentId });
	const afterLeadRemoval = await postAs(bossConfig, "/list", {});
	if (afterLeadRemoval.agents.some((agent) => agent.agentId === lead.agentId || agent.parentId === lead.agentId)) throw new Error("Boss removal did not delete the Lead subtree from the active team");
	await send("prompt", { message: "/cancel boss-1" });
	const finalEntries = await waitForEntry((items) => items.some((entry) => entry.customType === "pi-team-event" && entry.data?.kind === "control" && entry.data?.actorId === "user" && entry.data?.content.includes("boss-1")));
	const finalState = [...finalEntries].reverse().find((entry) => entry.customType === "pi-team-state");
	if (finalState?.data?.agents?.some((agent) => agent.agentId === "boss-1") || finalState?.data?.focusedBossId === "boss-1") throw new Error("User removal left the Boss active or focused");
	if (!finalState?.data?.identityUsage || Object.values(finalState.data.identityUsage).every((usage) => !usage.input && !usage.output)) throw new Error("Session-wide identity usage was not persisted after removals");
	if (!entries.some((entry) => entry.customType === "pi-team-state" && entry.data?.focusedBossId === "boss-1")) throw new Error("Focused Boss was not persisted");
	if (events.some((event) => event.type === "non-json")) throw new Error("RPC stdout contained non-JSON output");
	if (stderr.trim()) throw new Error(`Supervisor stderr was not empty: ${stderr.trim()}`);
	console.log(`PASS boss replies=2 recoveryPid=${firstBossPid}->new hierarchy=1+2+5 capacityLimit=ok messaging=parent+sibling+cross-branch visibility=ok isolation=ok entries=${finalEntries.length} rpcEvents=${events.length}`);
} finally {
	for (const item of pending.values()) {
		clearTimeout(item.timer);
		item.reject(new Error("Smoke test shutting down"));
	}
	pending.clear();
	if (process.platform === "win32" && child.pid) {
		try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
	} else child.kill("SIGKILL");
	rmSync(cwd, { recursive: true, force: true });
	if (nativeSessionDir) rmSync(nativeSessionDir, { recursive: true, force: true });
}
