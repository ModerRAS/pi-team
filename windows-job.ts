export interface ProcessJob {
	assign(pid: number): void;
	close(): void;
}

export async function createProcessJob(): Promise<ProcessJob | undefined> {
	if (process.platform !== "win32") return undefined;
	if (!("Bun" in globalThis)) {
		// Node/libuv assigns non-detached Windows children to its process-wide
		// KILL_ON_JOB_CLOSE Job Object. Normal cancellation is handled separately.
		return { assign() {}, close() {} };
	}
	if (process.arch !== "x64") throw new Error(`Pi Team Windows Job Object requires x64, got ${process.arch}`);

	const { dlopen, FFIType } = await import("bun:ffi");
	const library = dlopen("kernel32.dll", {
		AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.bool },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
		CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
		GetLastError: { args: [], returns: FFIType.u32 },
		OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 },
		SetInformationJobObject: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
	});
	const symbols = library.symbols;
	const rawJob = symbols.CreateJobObjectW(null, null);
	const job = typeof rawJob === "bigint" ? rawJob : BigInt(rawJob);
	if (job === 0n) {
		const error = symbols.GetLastError();
		library.close();
		throw new Error(`CreateJobObjectW failed with Win32 error ${error}`);
	}

	const info = new Uint8Array(144);
	new DataView(info.buffer).setUint32(16, 0x2000, true); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if (!symbols.SetInformationJobObject(job, 9, info, info.byteLength)) {
		const error = symbols.GetLastError();
		symbols.CloseHandle(job);
		library.close();
		throw new Error(`SetInformationJobObject failed with Win32 error ${error}`);
	}

	let closed = false;
	return {
		assign(pid: number): void {
			if (closed) throw new Error("Pi Team Windows Job Object is closed");
			const rawProcess = symbols.OpenProcess(0x0101, false, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
			const processHandle = typeof rawProcess === "bigint" ? rawProcess : BigInt(rawProcess);
			if (processHandle === 0n) throw new Error(`OpenProcess(${pid}) failed with Win32 error ${symbols.GetLastError()}`);
			try {
				if (!symbols.AssignProcessToJobObject(job, processHandle)) {
					throw new Error(`AssignProcessToJobObject(${pid}) failed with Win32 error ${symbols.GetLastError()}`);
				}
			} finally {
				symbols.CloseHandle(processHandle);
			}
		},
		close(): void {
			if (closed) return;
			closed = true;
			symbols.CloseHandle(job);
			library.close();
		},
	};
}
