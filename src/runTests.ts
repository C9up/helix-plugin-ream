/**
 * `ream test` — run the suites declared in the rc file.
 *
 * The AdonisJS stratification, kept intact: the FRAMEWORK reads its rc file and
 * hands the suites to the runner, exactly as `@adonisjs/core` reads
 * `adonisrc.ts` and hands them to helix. The runner itself (helix) knows nothing
 * about ream, and ream owns no test execution — it only translates.
 *
 *     // bin/test.ts
 *     import { runTestsFromRcFile } from '@c9up/helix-plugin-ream/runner'
 *     process.exitCode = await runTestsFromRcFile('./reamrc.ts', {
 *       suites: process.argv.slice(2),
 *     })
 *
 * Prefer that over `runTests(rc.tests, …)`: a `suites[].configure` callback has
 * to be re-imported in each worker, so the runner needs the module's PATH, not
 * just the object it exported. `runTests` takes it as `configModule`, and
 * REFUSES to run when a suite declares a callback it was given no way to
 * deliver — in helix a declared `configure` runs, so a run that skipped it would
 * be green in a state its own config does not describe.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TestSuiteConfig, TestsConfig } from "@c9up/ream";
import { loadEnvFiles } from "@c9up/ream/env";

/** What a caller may override on top of the rc file. */
export interface RunTestsOptions {
	/** Project root the suites resolve against. Defaults to `process.cwd()`. */
	root?: string;
	/**
	 * Suite names to run. Empty (the default) runs every declared suite, in
	 * order — the AdonisJS behaviour for `ream test` with no argument.
	 */
	suites?: string[];
	/** Concurrent worker processes. */
	threads?: number;
	/** Reporter name, or several (`["spec", "json"]`). */
	reporters?: string[];
	/** Stop at the first failure. */
	bail?: boolean;
	/**
	 * The module that declared the suites, so a `suites[].configure` callback can
	 * be re-imported in each worker — a function does not cross a process
	 * boundary. Set for you by {@link runTestsFromRcFile}.
	 */
	configModule?: string;
	/**
	 * Flags the worker processes are spawned with. Defaults to this process's own
	 * (`process.execArgv`), so the workers load TypeScript through whatever
	 * loader the parent was started with — `--import @swc-node/register/esm-register`
	 * for `ream test`, tsx for a project that prefers it. Nothing to detect: the
	 * workers simply run under the same loader as their parent.
	 */
	nodeArgs?: string[];
}

/** A suite name that was asked for but is not declared. */
export class UnknownSuiteError extends Error {
	constructor(name: string, declared: string[]) {
		super(
			declared.length === 0
				? `Unknown test suite "${name}": the rc file declares none.`
				: `Unknown test suite "${name}". Declared: ${declared.join(", ")}.`,
		);
		this.name = "UnknownSuiteError";
	}
}

/**
 * A suite declares `configure`, but this entry point cannot deliver it.
 *
 * Not a warning: helix runs a declared `configure`, so carrying on would run the
 * suite in a state its own config does not describe — and a warning is exactly
 * what gets scrolled past in CI.
 */
export class SuiteConfigureUnreachableError extends Error {
	constructor(names: string[]) {
		const plural = names.length > 1;
		super(
			`Suite${plural ? "s" : ""} ${names.map((name) => `"${name}"`).join(", ")} ` +
				`declare${plural ? "" : "s"} \`configure\`, which has to be re-imported in each ` +
				"worker and therefore needs the rc file PATH, not the object it exported. " +
				"Call runTestsFromRcFile(), or pass `configModule`.",
		);
		this.name = "SuiteConfigureUnreachableError";
	}
}

/**
 * The flags the worker processes are spawned with.
 *
 * Split out because it is a decision, not plumbing: the helix alias loader
 * redirects a package specifier, so it goes in only when a project asks. It
 * rides ALONGSIDE whatever loader is already there — the test files still need
 * theirs to read TypeScript.
 */
export function workerNodeArgs(
	tests: TestsConfig | undefined,
	options: RunTestsOptions,
): string[] {
	return [...(options.nodeArgs ?? process.execArgv)];
}

/** The suites to run, in declaration order, for the given selection. */
function select(
	declared: TestSuiteConfig[],
	asked: string[],
): TestSuiteConfig[] {
	if (asked.length === 0) return declared;
	const byName = new Map(declared.map((suite) => [suite.name, suite]));
	return asked.map((name) => {
		const suite = byName.get(name);
		if (suite === undefined) {
			throw new UnknownSuiteError(name, [...byName.keys()]);
		}
		return suite;
	});
}

/**
 * Run the rc file's test suites. Returns the process exit code; the caller
 * decides what to do with it, so this stays usable from a `bin/test.ts`, from a
 * console command, or from a test of its own.
 *
 * `NODE_ENV=test` is set first, then the `.env` files are loaded — so `.env.test`
 * wins over `.env` and `.env.local` is skipped, the AdonisJS test-env rules. It
 * happens HERE, in the process that spawns the workers, so every worker
 * inherits the result: an app gets its test environment without writing a
 * single hook, which is what "loaded automatically" has to mean.
 */
export async function runTests(
	tests: TestsConfig | undefined,
	options: RunTestsOptions = {},
): Promise<number> {
	process.env.NODE_ENV = "test";

	const root = options.root ?? process.cwd();
	// Skipping `.env.local` is deliberate (and what the Ignitor does for the test
	// environment): a developer's local overrides must not decide what CI runs.
	loadEnvFiles(pathToFileURL(`${root}${path.sep}`), { skipEnvLocal: true });
	const declared = tests?.suites ?? [];
	const selected = select(declared, options.suites ?? []);

	const helix = await import("@c9up/helix/runner");

	// The bootstrap module is the app's, not the runner's — helix imports it in
	// every worker, so a plugin's context extensions exist before the first test
	// declares itself.
	const bootstrap = helix.resolveBootstrap(root, tests?.bootstrap);
	process.env.HELIX_BOOTSTRAP = bootstrap ?? "";
	// Assigned either way: a second call in the same process must not inherit
	// the first one's flag. A plugin reads it back off `api.cliArgs.forceExit`.
	const forceExit = tests?.forceExit === true;
	process.env.HELIX_FORCE_EXIT = forceExit ? "1" : "";

	// Only named when a suite actually declares `configure`: pointing at it makes
	// every worker import the rc file, which a project not using the callback
	// should not pay for.
	const configuring = selected.filter(
		(suite) => typeof suite.configure === "function",
	);
	if (configuring.length > 0 && options.configModule === undefined) {
		// In helix a declared `configure` RUNS. It cannot here — the callback needs
		// the module's path to be re-imported in each worker, and this entry was
		// handed the exported object. Running anyway would produce a green suite
		// configured differently from what the rc file says, so the run stops.
		throw new SuiteConfigureUnreachableError(
			configuring.map((suite) => suite.name),
		);
	}
	process.env.HELIX_SUITE_CONFIG =
		configuring.length > 0 && options.configModule !== undefined
			? options.configModule
			: "";
	process.env.HELIX_SUITE_CONFIG_KEY = "tests.suites";

	const base = {
		root,
		nodeArgs: workerNodeArgs(tests, options),
		threads: options.threads,
		timeoutMs: tests?.timeout,
		reporters: options.reporters,
		bail: options.bail,
	};

	// `runnerHooks` run ONCE around the whole run, here, and the workers skip
	// them — helix's semantics, and the difference between migrating once and
	// migrating once per test file.
	const dropGlobalHooks = await helix.runGlobalHooks(bootstrap);

	// No suites declared: run whatever the project's discovery finds, so an app
	// with a plain `tests/` directory works without declaring anything.
	if (selected.length === 0) {
		try {
			const outcome = await helix.run(base);
			return finish(outcome.exitCode, forceExit, helix.armDrainGuard);
		} finally {
			await dropGlobalHooks();
		}
	}

	const steps = [];
	for (const suite of selected) {
		const files = await helix.resolveSuiteFiles(
			{
				name: suite.name,
				files: suite.files,
				timeout: suite.timeout,
				retries: suite.retries,
			},
			root,
			undefined,
		);
		if (files.length === 0) {
			process.stderr.write(`ream: suite "${suite.name}": no test files\n`);
			continue;
		}
		steps.push({
			env: {
				HELIX_SUITE: suite.name,
				// Empty means unset, so a suite that declares no retries does not
				// inherit the previous suite's.
				HELIX_RETRIES: suite.retries === undefined ? "" : String(suite.retries),
			},
			config: { ...base, files, timeoutMs: suite.timeout ?? tests?.timeout },
		});
	}
	if (steps.length === 0) {
		await dropGlobalHooks();
		return finish(0, forceExit, helix.armDrainGuard);
	}

	try {
		const outcome = await helix.runSuites(steps, base);
		return finish(outcome.exitCode, forceExit, helix.armDrainGuard);
	} finally {
		await dropGlobalHooks();
	}
}

/**
 * Apply `tests.forceExit`. helix does this inside its own run — sets the exit
 * code, then `process.exit()` — rather than leaving it to the caller, because
 * the whole point is to not wait for the event loop to drain. A run that
 * force-exits never returns here; the value is for every other run.
 */
function finish(
	code: number,
	forceExit: boolean,
	armDrainGuard: (code: number) => void,
): number {
	if (forceExit) {
		process.exitCode = code;
		process.exit();
	}
	// Without forceExit the loop is left to drain on its own, which is the right
	// default — a leaked handle should be visible, not swallowed. But visible has
	// to mean SAID: `ream test` used to print its summary and then hang with no
	// further output, and under a CI timeout that is a non-zero exit for a run in
	// which every test passed. helix's own CLI already said so; this entry point
	// did not, and it is the one `ream test` goes through.
	armDrainGuard(code);
	return code;
}

/**
 * Load an rc file and run its suites — the one-liner a `bin/test.ts` needs.
 * `rcPath` is resolved against `root`.
 */
export async function runTestsFromRcFile(
	rcPath: string,
	options: RunTestsOptions = {},
): Promise<number> {
	const root = options.root ?? process.cwd();
	const absolute = path.isAbsolute(rcPath)
		? rcPath
		: path.resolve(root, rcPath);
	const imported: unknown = await import(pathToFileURL(absolute).href);
	const rc =
		imported !== null && typeof imported === "object"
			? (Reflect.get(imported, "default") ?? imported)
			: undefined;
	const tests =
		rc !== null && typeof rc === "object"
			? Reflect.get(rc, "tests")
			: undefined;
	return runTests(isTestsConfig(tests) ? tests : undefined, {
		...options,
		root,
		configModule: absolute,
	});
}

/** Narrow an rc file's `tests` value without trusting it. */
function isTestsConfig(value: unknown): value is TestsConfig {
	return value !== null && typeof value === "object";
}
