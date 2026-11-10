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
import type { RunConfig } from "@c9up/helix/runner";
import type { TestSuiteConfig, TestsConfig } from "@c9up/ream";
import { loadEnvFiles } from "@c9up/ream/env";

/**
 * helix's coverage options, read off the run config rather than imported by
 * name: this bridge builds against every helix in its peer range, and the named
 * export is newer than the range's floor.
 */
type CoverageOptions = NonNullable<RunConfig["coverage"]>;

/** What a caller may override on top of the rc file. */
export interface RunTestsOptions {
	/** Project root the suites resolve against. Defaults to `process.cwd()`. */
	root?: string;
	/**
	 * Watch for a run that finishes but leaves the process alive, and after a
	 * grace period say what is still open — then exit with the run's code.
	 *
	 * OFF by default, because it ends the process and this function is a
	 * library: it is called from a `bin/test.ts`, from a console command, and
	 * from tests of its own, and the documented contract is that the caller
	 * decides what to do with the returned code. Arming it unconditionally
	 * broke that — a caller's own runner was killed mid-run by an exit it never
	 * asked for.
	 *
	 * `ream test` turns it on: there the process IS the run, and a summary
	 * followed by an unexplained hang is worse than an exit that names what is
	 * still open.
	 */
	drainGuard?: boolean;
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
	 * Collect V8 coverage for the run. Passed to helix untouched — coverage is
	 * the runner's, and this entry point only carries it across, the way it
	 * carries `threads` and `reporters`.
	 */
	coverage?: CoverageOptions;
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
	/**
	 * Exit 0 when the selection finds no test file, or a file declares no test.
	 * Off by default: a glob with a typo, or files that moved, would otherwise
	 * turn the run green with nothing executed.
	 */
	passWithNoTests?: boolean;
	/**
	 * What to run, narrowed — the console's `test` filters: test files
	 * (helix's `--files` rule), tags (`~@tag` excludes), parent group titles,
	 * test titles. Each list is used whole: a title is never split on its
	 * commas. `suites` adds to {@link RunTestsOptions.suites}.
	 */
	filters?: TestFilters;
	/** Timeout for every test, in ms — beats a suite's own and the rc file's. */
	timeout?: number;
	/** Extra attempts for every test of a suite that declares none. */
	retries?: number;
	/** Run only the tests that failed during the last run. */
	failed?: boolean;
	/** Watch the files and re-run the tests on a change. */
	watch?: boolean;
	/** With `watch`: detect changes by polling (network shares, containers). */
	poll?: boolean;
	/** With `watch`: clear the terminal before each re-run. Default true. */
	clear?: boolean;
}

/** The filters `ream test` forwards, in the console's `filters` shape. */
export interface TestFilters {
	suites?: string[];
	files?: string[];
	tags?: string[];
	groups?: string[];
	tests?: string[];
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
 * A project's own flags win; otherwise the workers inherit this process's, so
 * the loader that lets the test files be read as TypeScript carries over.
 */
export function workerNodeArgs(options: RunTestsOptions): string[] {
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
	const root = options.root ?? process.cwd();
	enterTestEnvironment(root);
	const declared = tests?.suites ?? [];
	const filters = options.filters ?? {};
	const asked = [
		...new Set([...(options.suites ?? []), ...(filters.suites ?? [])]),
	];
	const selected = select(declared, asked);

	const helix = await import("@c9up/helix/runner");

	// The bootstrap module is the app's, not the runner's — helix imports it in
	// every worker, so a plugin's context extensions exist before the first test
	// declares itself.
	const bootstrap = helix.resolveBootstrap(root, tests?.bootstrap);
	process.env.HELIX_BOOTSTRAP = bootstrap ?? "";
	// Assigned either way: a second call in the same process must not inherit
	// the first one's flag. A plugin reads it back off `api.cliArgs.forceExit`.
	const forceExit = tests?.forceExit === true;
	// Opt-in: this is a library, and the guard ends the process.
	const drainGuard = options.drainGuard === true;
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

	// The per-test filters reach the workers through the environment, as with
	// `helix test`. Encoded rather than comma-joined, and written every time so
	// a value left by an earlier run in this process cannot narrow this one.
	let testTitles = filters.tests ?? [];
	if (options.failed === true) {
		const failedTests = await helix.readFailedCache(root);
		if (failedTests.length === 0) {
			process.stdout.write(
				"ream: no failing tests cached — running all of them\n",
			);
		} else {
			testTitles = failedTests;
		}
	}
	const list = (values: readonly string[] | undefined): string =>
		values === undefined || values.length === 0
			? ""
			: helix.encodeEnvList(values);
	process.env.HELIX_TESTS = list(testTitles);
	process.env.HELIX_TAGS = list(filters.tags);
	process.env.HELIX_GROUPS = list(filters.groups);
	process.env.HELIX_FILES = list(filters.files);
	process.env.HELIX_FAILED = options.failed === true ? "1" : "";
	// Read by a plugin off `api.cliArgs.timeout`; the run itself carries the
	// timeout in its config below.
	process.env.HELIX_TIMEOUT =
		options.timeout === undefined ? "" : String(options.timeout);
	process.env.HELIX_RETRIES =
		options.retries === undefined ? "" : String(options.retries);

	const passWithNoTests = options.passWithNoTests === true;
	const base = {
		root,
		nodeArgs: workerNodeArgs(options),
		threads: options.threads,
		// The rc file's `timeout` is the run-wide DEFAULT: `configure({ timeout })`
		// and a plugin editing `api.config.timeout` beat it, a suite's own
		// `timeout` beats them all.
		defaultTimeoutMs: tests?.timeout,
		reporters: options.reporters,
		bail: options.bail,
		coverage: options.coverage,
		passWithNoTests,
		// `--timeout` beats every configured value.
		timeoutMs: options.timeout,
		watch:
			options.watch === true
				? {
						enabled: true,
						poll: options.poll === true,
						// The console clears by default; `--no-clear` keeps the output.
						clearScreen: options.clear !== false,
					}
				: undefined,
	};

	// The suites' files resolve BEFORE the global setup: a `files` callback that
	// throws, or a glob that cannot be walked, must fail the run while nothing
	// has been set up yet, instead of leaving a migrated database behind.
	const steps = [];
	// A suite asked for by name that matches nothing is a configuration error,
	// even when the others have files; with every suite running it is only
	// worth a warning, unless nothing at all is left to run.
	// A file filter narrowing a named suite to nothing is the filter at work,
	// not a broken suite.
	const fileFilters = filters.files ?? [];
	const named = asked.length > 0 && fileFilters.length === 0;
	let namedSuiteEmpty = false;
	for (const suite of selected) {
		const files = helix.filterByFileFilters(
			await helix.resolveSuiteFiles(
				{
					name: suite.name,
					files: suite.files,
					timeout: suite.timeout,
					retries: suite.retries,
				},
				root,
				undefined,
			),
			fileFilters,
		);
		if (files.length === 0) {
			process.stderr.write(`ream: suite "${suite.name}": no test files\n`);
			if (named) namedSuiteEmpty = true;
			continue;
		}
		steps.push({
			env: {
				HELIX_SUITE: suite.name,
				// Empty means unset, so a suite that declares no retries does not
				// inherit the previous suite's.
				HELIX_RETRIES: String(suite.retries ?? options.retries ?? ""),
			},
			config: { ...base, files, timeoutMs: options.timeout ?? suite.timeout },
		});
	}
	// No suite declared and a file filter given: discover here, so the filter
	// narrows what discovery finds instead of being lost.
	const discovered =
		selected.length === 0 && fileFilters.length > 0
			? helix.filterByFileFilters(await helix.discover(root), fileFilters)
			: undefined;
	if ((selected.length > 0 && steps.length === 0) || discovered?.length === 0) {
		const code = passWithNoTests ? 0 : 1;
		process.stderr.write(
			`ream: No test files found, exiting with code ${code}\n`,
		);
		return finish(
			code,
			forceExit,
			drainGuard ? helix.armDrainGuard : undefined,
		);
	}

	// `runnerHooks` run ONCE around the whole run, here, and the workers skip
	// them — helix's semantics, and the difference between migrating once and
	// migrating once per test file.
	const dropGlobalHooks = await helix.runGlobalHooks(bootstrap);

	// No suites declared: run whatever the project's discovery finds, so an app
	// with a plain `tests/` directory works without declaring anything.
	if (selected.length === 0) {
		try {
			const outcome = await helix.run(
				discovered === undefined ? base : { ...base, files: discovered },
			);
			return finish(
				outcome.exitCode,
				forceExit,
				drainGuard ? helix.armDrainGuard : undefined,
			);
		} finally {
			await dropGlobalHooks();
		}
	}

	try {
		const outcome = await helix.runSuites(steps, base);
		const code =
			namedSuiteEmpty && !passWithNoTests
				? Math.max(outcome.exitCode, 1)
				: outcome.exitCode;
		return finish(
			code,
			forceExit,
			drainGuard ? helix.armDrainGuard : undefined,
		);
	} finally {
		await dropGlobalHooks();
	}
}

/**
 * `NODE_ENV=test`, then the `.env` files of `root` — `.env.test` over `.env`.
 * Idempotent: an existing key is never overwritten, so a second call changes
 * nothing.
 */
function enterTestEnvironment(root: string): void {
	process.env.NODE_ENV = "test";
	// Skipping `.env.local` is deliberate (and what the Ignitor does for the test
	// environment): a developer's local overrides must not decide what CI runs.
	loadEnvFiles(pathToFileURL(`${root}${path.sep}`), { skipEnvLocal: true });
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
	armDrainGuard: ((code: number) => void) | undefined,
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
	armDrainGuard?.(code);
	return code;
}

/**
 * Load an rc file and run its suites — the one-liner a `bin/test.ts` needs.
 * `rcPath` is resolved against `root`. The test environment is entered before
 * the rc file is imported.
 */
export async function runTestsFromRcFile(
	rcPath: string,
	options: RunTestsOptions = {},
): Promise<number> {
	const root = options.root ?? process.cwd();
	// Before the rc file is imported: whatever it evaluates eagerly — a provider
	// import, an env read — runs in the test environment, as AdonisJS
	// `bin/test.ts` sets it before importing anything.
	enterTestEnvironment(root);
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
