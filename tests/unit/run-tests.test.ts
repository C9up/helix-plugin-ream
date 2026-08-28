import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	runTests,
	runTestsFromRcFile,
	SuiteConfigureUnreachableError,
	UnknownSuiteError,
	workerNodeArgs,
} from "../../src/runTests.js";

/**
 * `ream test` — the framework reads its rc file and hands the suites to the
 * runner, the way `@adonisjs/core` reads `adonisrc.ts` and hands them to helix.
 * These cover the translation ream owns; the execution itself is helix's and is
 * proven there.
 */
describe("runTests", () => {
	const dirs: string[] = [];
	let root: string;
	let savedNodeEnv: string | undefined;

	beforeEach(() => {
		savedNodeEnv = process.env.NODE_ENV;
		root = mkdtempSync(join(tmpdir(), "ream-runtests-"));
		dirs.push(root);
	});

	afterEach(() => {
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
		delete process.env.HELIX_BOOTSTRAP;
		delete process.env.HELIX_FORCE_EXIT;
		delete process.env.HELIX_SUITE_CONFIG;
		delete process.env.HELIX_SUITE_CONFIG_KEY;
		for (const key of [
			"REAM_RT_DB",
			"REAM_RT_BASE",
			"REAM_RT_LOCAL",
			"REAM_RT_SHELL",
		]) {
			delete process.env[key];
		}
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	/** A suite with no matching file, so nothing is ever spawned. */
	const emptySuite = { name: "unit", files: "tests/unit/**/*.spec.ts" };

	it("sets NODE_ENV=test before anything else — what makes .env.test win", async () => {
		process.env.NODE_ENV = "development";

		await runTests({ suites: [emptySuite] }, { root });

		expect(process.env.NODE_ENV).toBe("test");
	});

	it("loads .env.test over .env, with no hook asked of the app", async () => {
		// "Loaded automatically" has to mean the app writes nothing. It happens in
		// this process, so every worker spawned below inherits it.
		writeFileSync(join(root, ".env"), "REAM_RT_DB=dev\nREAM_RT_BASE=base\n");
		writeFileSync(join(root, ".env.test"), "REAM_RT_DB=testdb\n");

		await runTests({ suites: [emptySuite] }, { root });

		expect(process.env.REAM_RT_DB).toBe("testdb");
		// `.env` still fills what `.env.test` leaves out.
		expect(process.env.REAM_RT_BASE).toBe("base");
	});

	it("ignores .env.local, so a local override never decides what CI runs", async () => {
		writeFileSync(join(root, ".env"), "REAM_RT_LOCAL=base\n");
		writeFileSync(join(root, ".env.local"), "REAM_RT_LOCAL=from_local\n");

		await runTests({ suites: [emptySuite] }, { root });

		expect(process.env.REAM_RT_LOCAL).toBe("base");
	});

	it("lets the shell keep the last word", async () => {
		process.env.REAM_RT_SHELL = "from_shell";
		writeFileSync(join(root, ".env.test"), "REAM_RT_SHELL=from_file\n");

		await runTests({ suites: [emptySuite] }, { root });

		expect(process.env.REAM_RT_SHELL).toBe("from_shell");
	});

	it("names the unknown suite and lists what is declared", async () => {
		await expect(
			runTests(
				{ suites: [emptySuite, { name: "e2e", files: "x" }] },
				{ root, suites: ["nope"] },
			),
		).rejects.toThrow(UnknownSuiteError);

		await expect(
			runTests({ suites: [emptySuite] }, { root, suites: ["nope"] }),
		).rejects.toThrow(/Declared: unit\./);
	});

	it("says so when the rc file declares no suite at all", async () => {
		await expect(
			runTests({ suites: [] }, { root, suites: ["nope"] }),
		).rejects.toThrow(/declares none/);
	});

	it("forwards the bootstrap module it resolved", async () => {
		mkdirSync(join(root, "tests"), { recursive: true });
		writeFileSync(
			join(root, "tests/bootstrap.ts"),
			"export const plugins = []\n",
		);

		await runTests({ suites: [emptySuite] }, { root });

		expect(process.env.HELIX_BOOTSTRAP).toBe(join(root, "tests/bootstrap.ts"));
	});

	it("leaves the bootstrap unset when the project has none", async () => {
		await runTests({ suites: [emptySuite] }, { root });

		expect(process.env.HELIX_BOOTSTRAP).toBe("");
	});

	it("honours a bootstrap path declared in the rc file", async () => {
		mkdirSync(join(root, "custom"), { recursive: true });
		writeFileSync(join(root, "custom/boot.ts"), "export const plugins = []\n");

		await runTests(
			{ suites: [emptySuite], bootstrap: "custom/boot.ts" },
			{ root },
		);

		expect(process.env.HELIX_BOOTSTRAP).toBe(join(root, "custom/boot.ts"));
	});

	it("names the config module only when a suite declares configure", async () => {
		// Pointing at it makes every worker import the rc file; a project not using
		// the callback must not pay for that.
		await runTests(
			{ suites: [emptySuite] },
			{ root, configModule: "/tmp/rc.ts" },
		);
		expect(process.env.HELIX_SUITE_CONFIG).toBe("");

		await runTests(
			{ suites: [{ ...emptySuite, configure: () => {} }] },
			{ root, configModule: "/tmp/rc.ts" },
		);
		expect(process.env.HELIX_SUITE_CONFIG).toBe("/tmp/rc.ts");
		// ream declares its suites under `tests.suites`, not at the top level.
		expect(process.env.HELIX_SUITE_CONFIG_KEY).toBe("tests.suites");
	});

	it("refuses to run when it cannot deliver a suite configure", async () => {
		// helix runs a declared `configure`. This entry point cannot — it was handed
		// the exported object, not the module — so it stops instead of producing a
		// green suite configured differently from what the rc file says.
		await expect(
			runTests({ suites: [{ ...emptySuite, configure: () => {} }] }, { root }),
		).rejects.toThrow(SuiteConfigureUnreachableError);

		await expect(
			runTests({ suites: [{ ...emptySuite, configure: () => {} }] }, { root }),
		).rejects.toThrow(/runTestsFromRcFile/);
	});

	it("names every suite whose configure it cannot deliver", async () => {
		await expect(
			runTests(
				{
					suites: [
						{ ...emptySuite, configure: () => {} },
						{ name: "e2e", files: "x", configure: () => {} },
					],
				},
				{ root },
			),
		).rejects.toThrow(/"unit", "e2e"/);
	});

	it("runs normally when no suite declares configure", async () => {
		await expect(runTests({ suites: [emptySuite] }, { root })).resolves.toBe(0);
	});

	it("clears a stale forceExit rather than inheriting it", async () => {
		// The flag is what a plugin reads off `api.cliArgs.forceExit`. It is
		// assigned unconditionally, so a value left in the environment — by the
		// CLI, by CI, by an earlier run — cannot make a run claim it force-exits
		// when its rc file says nothing of the sort.
		//
		// Not asserted here: that force-exit actually leaves the process. It does,
		// which is precisely why it cannot be called from inside a test runner —
		// see tests/integration/force-exit.test.ts.
		process.env.HELIX_FORCE_EXIT = "1";

		await runTests({ suites: [emptySuite] }, { root });

		expect(process.env.HELIX_FORCE_EXIT).toBe("");
	});

	it("succeeds when every declared suite matches nothing", async () => {
		// An empty suite is a warning, not a failure — the exit code must not
		// claim tests failed when none ran.
		await expect(runTests({ suites: [emptySuite] }, { root })).resolves.toBe(0);
	});
});

describe("workerNodeArgs", () => {
	it("keeps the loader the workers already needed", () => {
		// Replacing it instead of passing it through would leave them unable to
		// read TypeScript, which every fixture in a ream app is.
		const args = workerNodeArgs(
			{ suites: [] },
			{ nodeArgs: ["--import", "tsx-loader"] },
		);

		expect(args).toEqual(["--import", "tsx-loader"]);
	});

	it("inherits this process's own flags when none are given", () => {
		expect(workerNodeArgs(undefined, {})).toEqual(process.execArgv);
	});
});

describe("runTestsFromRcFile", () => {
	const dirs: string[] = [];
	let root: string;
	let savedNodeEnv: string | undefined;

	beforeEach(() => {
		savedNodeEnv = process.env.NODE_ENV;
		root = mkdtempSync(join(tmpdir(), "ream-runtests-rc-"));
		dirs.push(root);
	});

	afterEach(() => {
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
		delete process.env.HELIX_BOOTSTRAP;
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("reads the tests block off the rc file default export", async () => {
		writeFileSync(
			join(root, "reamrc.ts"),
			'export default { tests: { suites: [{ name: "unit", files: "tests/unit/**/*.spec.ts" }] } }\n',
		);

		await expect(runTestsFromRcFile("reamrc.ts", { root })).resolves.toBe(0);
		// Selecting a suite the rc file declares proves the block was read, not
		// silently defaulted away.
		await expect(
			runTestsFromRcFile("reamrc.ts", { root, suites: ["nope"] }),
		).rejects.toThrow(/Declared: unit\./);
	});

	it("treats an rc file without a tests block as no suites declared", async () => {
		writeFileSync(
			join(root, "reamrc.ts"),
			"export default { providers: [] }\n",
		);

		await expect(
			runTestsFromRcFile("reamrc.ts", { root, suites: ["nope"] }),
		).rejects.toThrow(/declares none/);
	});
});
