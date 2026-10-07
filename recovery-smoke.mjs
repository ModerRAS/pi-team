/**
 * Recovery smoke: the self-owned workspace registry must rebuild a Team that no Pi session remembers, must not be
 * duplicated while another Supervisor still runs it, and must leave a stale snapshot alone until /team-restore.
 * Uses real `pi --mode rpc` processes in a temp workspace; no mocks.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const extension = resolve(import.meta.dirname, "index.ts");
const command = process.platform === "win32" ? "pi.cmd" : "pi";
const cwd = mkdtempSync(join(tmpdir(), "pi-team-recovery-"));

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const running = [];

function boot(label) {
	const child = spawn(command, ["--mode", "rpc", "--no-extensions", "-e", extension], { cwd, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const state = { child, label, buffer: "", decoder: new StringDecoder("utf8"), nextId: 1, pending: new Map() };
	child.stdout.on("data", (chunk) => {
		state.buffer += state.decoder.write(chunk);
		while (true) {
			const newline = state.buffer.indexOf("\n");
			if (newline === -1) break;
			let line = state.buffer.slice(0, newline);
			state.buffer = state.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			let event;
			try { event = JSON.parse(line); } catch { continue; }
			if (event.type !== "response" || !event.id || !state.pending.has(event.id)) continue;
			const item = state.pending.get(event.id);
			clearTimeout(item.timer);
			state.pending.delete(event.id);
			event.success ? item.resolve(event) : item.reject(new Error(event.error || `${event.command} failed`));
		}
	});
	running.push(state);
	return state;
}

function send(state, type, fields = {}) {
	const id = `${state.label}-${state.nextId++}`;
	state.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error(`${state.label} ${type} timed out`)), 90_000);
		state.pending.set(id, { resolve: resolvePromise, reject, timer });
	});
}

async function entries(state) {
	return (await send(state, "get_entries")).data?.entries ?? [];
}

function states(items) {
	return items.filter((entry) => entry.customType === "pi-team-state").map((entry) => entry.data);
}

function events(items) {
	return items.filter((entry) => entry.customType === "pi-team-event").map((entry) => entry.data);
}

async function waitFor(description, predicate, timeoutMs = 120_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await predicate()) return;
		await sleep(1000);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function pidAlive(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function ownerProcessPid() {
	const url = JSON.parse(readFileSync(join(cwd, ".pi", "pi-team", "latest.json"), "utf8")).supervisorUrl;
	if (!url) return undefined;
	try { return (await (await fetch(`${url}/alive`, { method: "POST" })).json()).pid; } catch { return undefined; }
}

function killTree(state) {
	try { execFileSync("taskkill", ["/PID", String(state.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
	state.child.kill();
}

const stateRoot = join(cwd, ".pi", "pi-team");
const registryPath = join(stateRoot, "latest.json");
const readRegistry = () => JSON.parse(readFileSync(registryPath, "utf8"));

async function bootTeam() {
	const supervisor = boot("boot");
	await send(supervisor, "get_state");
	await send(supervisor, "prompt", { message: "/boss Wait silently; reply with exactly RECOVERY_SMOKE and no other text." });
	let state;
	await waitFor("the first Team snapshot", async () => {
		state = [...states(await entries(supervisor))].reverse().find((item) => item?.agents?.some((agent) => agent.agentId === "boss-1"));
		return Boolean(state);
	});
	const boss = state.agents.find((agent) => agent.agentId === "boss-1");
	return { supervisor, boss, teamId: state.teamId };
}

try {
	// 1. A brand new session in the same workspace rebuilds the Team from the registry alone.
	const first = await bootTeam();
	const registry = readRegistry();
	if (!registry.updatedAt || !registry.supervisorUrl || !registry.agents?.some((agent) => agent.agentId === "boss-1")) throw new Error("latest.json is not a full registry snapshot");
	const instancePath = join(cwd, ".pi", "pi-team", registry.storageId, "agents", "boss-1", "instance.json");
	const instance = JSON.parse(readFileSync(instancePath, "utf8"));
	if (!instance.sessionPath || instance.sessionPath !== first.boss.sessionPath) throw new Error("instance.json does not record the role transcript path");
	killTree(first.supervisor);
	await sleep(3000);

	const adopted = boot("adopted");
	await send(adopted, "get_state");
	let adoptedState;
	await waitFor("the Team to be adopted from the registry", async () => {
		adoptedState = [...states(await entries(adopted))].reverse().find((item) => item?.agents?.some((agent) => agent.agentId === "boss-1"));
		return Boolean(adoptedState);
	});
	const adoptedBoss = adoptedState.agents.find((agent) => agent.agentId === "boss-1");
	if (adoptedState.teamId !== first.teamId) throw new Error("the adopted Team got a new teamId");
	if (adoptedBoss.task !== first.boss.task || adoptedBoss.sessionPath !== first.boss.sessionPath) throw new Error("the adopted role lost its brief or transcript path");
	await waitFor("the adopted role to be respawned with a new pid", async () => {
		const current = [...states(await entries(adopted))].reverse().find((item) => item?.agents?.some((agent) => agent.agentId === "boss-1" && agent.pid && agent.pid !== first.boss.pid));
		return Boolean(current);
	});
	console.log("PASS registry adoption resumed the same Team and role session");

	// 2. A second Supervisor in the same workspace must not adopt a Team that is still live.
	const live = boot("live");
	await send(live, "get_state");
	await waitFor("the live-owner warning", async () => events(await entries(live)).some((event) => /is still running in another Supervisor/.test(String(event.content))));
	if (states(await entries(live)).some((state) => state?.agents?.some((agent) => agent.agentId === "boss-1"))) throw new Error("a live Team was adopted by a second Supervisor");

	// 3. /team-restore refuses a live owner unless force is given; force ends that Supervisor and takes over.
	await send(live, "prompt", { message: "/team-restore" });
	await waitFor("the takeover refusal", async () => events(await entries(live)).some((event) => /stop it there first, or run \/team-restore force/.test(String(event.content))));
	const ownerPid = await ownerProcessPid();
	if (!ownerPid || !pidAlive(ownerPid)) throw new Error("/team-restore without force ended the live Supervisor");
	if (states(await entries(live)).some((state) => state?.agents?.some((agent) => agent.agentId === "boss-1"))) throw new Error("/team-restore without force adopted a live Team");
	await send(live, "prompt", { message: "/team-restore force" });
	let takeoverPid;
	await waitFor("the takeover respawn", async () => {
		takeoverPid = [...states(await entries(live))].reverse().find((item) => item?.agents?.some((agent) => agent.agentId === "boss-1" && agent.pid && agent.pid !== first.boss.pid))?.agents?.find((agent) => agent.agentId === "boss-1")?.pid;
		return Boolean(takeoverPid);
	});
	if (takeoverPid === first.boss.pid) throw new Error("/team-restore force kept the previous owner's role process");
	if (takeoverPid === adoptedBoss.pid) throw new Error("/team-restore force kept the previous owner's role process");
	const ownerDeadSince = Date.now();
	while (pidAlive(ownerPid) && Date.now() - ownerDeadSince < 10_000) await sleep(250);
	if (pidAlive(ownerPid)) throw new Error("/team-restore force left the previous Supervisor alive");

	// 4. A snapshot older than the adoption window waits for /team-restore instead of resurrecting roles.
	for (const state of running) killTree(state);
	running.length = 0;
	await sleep(3000);
	const staleRegistry = readRegistry();
	const staleAt = new Date(Date.now() - 60 * 24 * 3_600_000).toISOString();
	writeFileSync(registryPath, JSON.stringify({ ...staleRegistry, updatedAt: staleAt }), "utf8");
	const staleDirs = readdirSync(stateRoot).length;
	const stale = boot("stale");
	await send(stale, "get_state");
	await waitFor("the stale-team notice", async () => events(await entries(stale)).some((event) => /was not restored automatically/.test(String(event.content))));
	// The declining session must still finish binding: it keeps its own state directory instead of aborting.
	await waitFor("the declining session to create its own state directory", () => readdirSync(stateRoot).length > staleDirs, 15_000);
	if (!existsSync(registryPath)) throw new Error("the stale registry was deleted instead of being kept for /team-restore");
	const untouched = readRegistry();
	if (untouched.updatedAt !== staleAt) throw new Error(`a stale registry was rewritten instead of being left for /team-restore (${staleAt} -> ${untouched.updatedAt} via ${untouched.supervisorUrl})`);
	await send(stale, "prompt", { message: "/team-restore" });
	await waitFor("/team-restore to adopt the stale Team", async () => states(await entries(stale)).some((state) => state?.teamId === staleRegistry.teamId));
	killTree(stale);
	console.log(`PASS live Team protected from duplicate adoption, /team-restore refuses a live owner and force takes over, stale snapshot kept (registry=${staleRegistry.storageId})`);
} finally {
	for (const state of running) killTree(state);
	await sleep(1500);
	try { rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (error) { console.error(`cleanup: ${error.message}`); }
}
