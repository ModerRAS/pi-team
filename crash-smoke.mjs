import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

if (process.platform !== "win32") {
	console.log("SKIP Windows-only crash cleanup test");
	process.exit(0);
}

const cwd = resolve(import.meta.dirname, "../..");
const extension = resolve(import.meta.dirname, "index.ts");
const child = spawn("pi.cmd", ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension], {
	cwd,
	shell: true,
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
});
const decoder = new StringDecoder("utf8");
let buffer = "";
let nextId = 1;
const pending = new Map();

child.stdout.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) break;
		let line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		if (event.type !== "response" || !event.id || !pending.has(event.id)) continue;
		const item = pending.get(event.id);
		clearTimeout(item.timer);
		pending.delete(event.id);
		event.success ? item.resolve(event) : item.reject(new Error(event.error || `${event.command} failed`));
	}
});

function send(type, fields = {}) {
	const id = `crash-${nextId++}`;
	child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error(`${type} timed out`)), 60_000);
		pending.set(id, { resolve: resolvePromise, reject, timer });
	});
}

async function waitForBossPid() {
	const start = Date.now();
	while (Date.now() - start < 120_000) {
		const response = await send("get_entries");
		const states = (response.data?.entries ?? []).filter((entry) => entry.customType === "pi-team-state");
		const boss = states.at(-1)?.data?.agents?.find((agent) => agent.agentId === "boss-1");
		if (boss?.pid) return boss.pid;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
	}
	throw new Error("Boss PID timed out");
}

function supervisorPid() {
	const escaped = extension.replaceAll("'", "''");
	const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^node' -and $_.CommandLine -like '*--mode rpc*' -and $_.CommandLine -like '*${escaped}*' -and $_.CommandLine -notlike '*--team-instance*' } | Select-Object -First 1 -ExpandProperty ProcessId`;
	return Number(execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim());
}

function processExists(pid) {
	try {
		const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", `@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count`], { encoding: "utf8" }).trim();
		return output === "1";
	} catch {
		return false;
	}
}

try {
	await send("get_state");
	await send("prompt", { message: "/boss Wait silently for further instructions." });
	const bossPid = await waitForBossPid();
	const parentPid = supervisorPid();
	if (!parentPid) throw new Error("Could not locate Supervisor Node PID");
	execFileSync("taskkill", ["/PID", String(parentPid), "/F"], { stdio: "ignore" });
	const start = Date.now();
	while (processExists(bossPid) && Date.now() - start < 10_000) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
	}
	if (processExists(bossPid)) throw new Error(`Boss ${bossPid} survived Supervisor ${parentPid}`);
	console.log(`PASS Supervisor ${parentPid} crash terminated Boss ${bossPid}`);
} finally {
	child.kill();
}
