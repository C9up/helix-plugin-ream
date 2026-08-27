import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `tests.forceExit` — does the PROCESS actually leave?
 *
 * Asserting that an env var was set proves the plumbing, not the behaviour:
 * `HELIX_FORCE_EXIT` is read by helix's own CLI, and `ream test` goes through
 * the programmatic runner instead, where nothing was reading it. The only
 * honest check is to run it and see whether the process dies while a handle is
 * still open.
 */
const here = dirname(fileURLToPath(import.meta.url));
const runTestsPath = join(here, "../../src/runTests.ts");
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/**
 * The tsx loader. Resolved through the package itself (tsx exports `.` as
 * dist/loader.mjs) — walking up to a pnpm store only works in a workspace
 * checkout, not in this repo on its own.
 */
function tsxLoader(): string | undefined {
	try {
		return import.meta.resolve("tsx");
	} catch {
		return undefined;
	}
}

/**
 * Run `runTests` in a child that ALSO holds an open handle, and report how it
 * ended. Without force-exit the interval keeps the loop alive forever, which is
 * exactly the difference being measured.
 */
function runChild(
	forceExit: boolean,
	timeoutMs: number,
): Promise<{ exited: boolean; code: number | null }> {
	const root = mkdtempSync(join(tmpdir(), "ream-forceexit-"));
	dirs.push(root);

	const script = [
		`import { runTests } from ${JSON.stringify(runTestsPath)}`,
		// A handle nothing closes — a DB pool or a server, in a real app.
		`const handle = setInterval(() => {}, 1000)`,
		`await runTests({ suites: [], forceExit: ${forceExit} }, { root: ${JSON.stringify(root)} })`,
		// Reached only when the run did NOT force-exit.
		`console.log('returned')`,
	].join("\n");

	const loader = tsxLoader();
	const args = loader ? ["--import", loader] : [];
	const child = spawn(
		process.execPath,
		[...args, "--input-type=module", "-e", script],
		{
			stdio: ["ignore", "ignore", "ignore"],
		},
	);

	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ exited: false, code: null });
		}, timeoutMs);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ exited: true, code });
		});
	});
}

describe("tests.forceExit", () => {
	it("leaves the process even with a handle still open", async () => {
		// Generous window: a loaded machine only ever makes this SLOWER, and a
		// timeout here would be a flake, not a finding. The opposite case below is
		// the one that must stay tight.
		const outcome = await runChild(true, 45_000);

		expect(outcome.exited).toBe(true);
		expect(outcome.code).toBe(0);
	}, 60_000);

	it("without it, the open handle keeps the process alive", async () => {
		// The contrast is the point: if this one also exited, the test above would
		// pass for a reason that has nothing to do with forceExit.
		const outcome = await runChild(false, 6_000);

		expect(outcome.exited).toBe(false);
	}, 30_000);
});
