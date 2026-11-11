/**
 * `@c9up/helix-plugin-ream` — the bridge between Ream and its test runner.
 *
 * Ream knows nothing about helix, helix knows nothing about Ream: the plugin
 * that joins them lives here, and declares both sides as peers. The HTTP test
 * client itself (`TestClient`, `createTestClient`) stays in `@c9up/ream/testing`
 * — it drives a Ream server and owes nothing to the runner.
 *
 * The split: the plugin puts a CLIENT on the test context, and
 * the SERVER is started by a suite hook, so a suite that does not declare the
 * hook never starts one.
 *
 * The bootstrap module exports its hooks and never calls `configure()`:
 * helix imports it and configures each run with these exports and the name of
 * the suite being run.
 *
 *   // tests/bootstrap.ts
 *   import type { ConfigureOptions, Plugin, RunnerHook } from '@c9up/helix'
 *   import { apiClient } from '@c9up/helix-plugin-ream'
 *   import { createTestUtils } from '@c9up/ream/testing/utils'
 *
 *   export const testUtils = createTestUtils((port) => bootApp(port))
 *
 *   export const plugins: Plugin[] = [apiClient({ testUtils })]
 *
 *   export const runnerHooks: { setup: RunnerHook[]; teardown: RunnerHook[] } = {
 *     setup: [],
 *     teardown: [],
 *   }
 *
 *   export const configureSuite: ConfigureOptions['configureSuite'] = (suite) => {
 *     if (['functional', 'e2e'].includes(suite.name)) {
 *       return suite.setup(() => testUtils.httpServer().start())
 *     }
 *   }
 *
 *   // a test
 *   test('health', async ({ client }) => {
 *     await client.get('/health').assertOk()
 *   })
 */

import { getActiveTest, type Plugin, type PluginApi } from "@c9up/helix";
import type { AuthStrategy, RouteManifest } from "@c9up/ream/testing";
import { TestClient } from "@c9up/ream/testing";
import type { BootServer, TestUtils } from "@c9up/ream/testing/utils";

/** The slice of helix's `PluginApi` this plugin actually uses. */
export type ClientHost = Pick<PluginApi, "context" | "cleanup">;

export interface ApiClientConfig {
	/**
	 * The utilities whose `httpServer()` a suite hook starts. The plugin reads
	 * the client of the server that hook started, so both point at one server.
	 */
	testUtils?: TestUtils;
	/**
	 * Boot the app directly, for a project that does not split its suites.
	 *
	 * Otherwise starting the server is always the suite hook's job. This
	 * exists because the server then starts on the client's FIRST
	 * REQUEST rather than at plugin time, so a file that issues none pays
	 * nothing — the same saving `testUtils` obtains by scoping, without having
	 * to split the suites first. Prefer `testUtils`; reach for this when the
	 * files are not separated.
	 */
	boot?: BootServer;
	/** Warden auth strategy for `client.withAuth()`/`asUser()`. */
	auth?: AuthStrategy;
	/** Named-route manifest (`router.namedManifest()`) for `client.visit()`. */
	routes?: RouteManifest;
}

/**
 * One test's client over the file's server.
 *
 * Its request state — default headers set with `withHeader()` — is its own, so
 * it ends with the test; the server is the shared one, booted once per file.
 * `booted` and `port` report that server.
 */
class TestClientView extends TestClient {
	readonly #shared: TestClient;

	constructor(
		shared: TestClient,
		options: { auth?: AuthStrategy; routes?: RouteManifest },
	) {
		// Booting the view boots the shared server (once) and points at it;
		// closing the view releases nothing, since the server is not its own.
		super(async () => {
			await shared.boot();
			return { port: shared.port, close: () => {} };
		}, options);
		this.#shared = shared;
	}

	override get booted(): boolean {
		return this.#shared.booted;
	}

	override get port(): number {
		return this.#shared.port;
	}
}

/**
 * Injects a {@link TestClient} on the test context as `ctx.client` — a fresh
 * one per test, over the server the file booted, so a header one test sets
 * (an `authorization` it logs in with) never reaches the next.
 *
 * With `testUtils`, the server is the one the suite hook started — so nothing
 * is booted here, and a suite without the hook has no server at all. With
 * `boot`, the plugin owns its server and starts it on the first request.
 *
 * Either way `api.cleanup` closes what this plugin started, which is nothing in
 * the `testUtils` case — the hook's own teardown owns that server.
 */
export function apiClient(config: ApiClientConfig) {
	const plugin = async (api: ClientHost): Promise<void> => {
		if (!config.testUtils && !config.boot) {
			throw new Error(
				"[E_NO_SERVER] apiClient() needs either `testUtils` (" +
					"a suite hook starts the server) or `boot` (the client starts one on its " +
					"first request). It was given neither, so `ctx.client` would have had " +
					"nothing to talk to.",
			);
		}

		// Resolved per access, not once: with `testUtils` the server does not
		// exist yet when the plugin runs — the suite's setup hook starts it.
		const owned = config.boot
			? new TestClient(config.boot, {
					auth: config.auth,
					routes: config.routes,
				})
			: undefined;

		const read = (): TestClient => {
			const client = owned ?? config.testUtils?.client();
			if (!client) {
				throw new Error(
					"[E_SERVER_NOT_STARTED] No server is running for this suite. Add the " +
						"hook that starts it:\n" +
						"  configureSuite(suite) {\n" +
						"    if (suite.name === 'functional') {\n" +
						"      return suite.setup(() => testUtils.httpServer().start())\n" +
						"    }\n" +
						"  }",
				);
			}
			return client;
		};

		// The resolver, not a client: with `testUtils` there is nothing to record
		// yet, and `testClient()` must not depend on someone having read
		// `ctx.client` first — a fixture or a runner hook has no context to read
		// it from, which is the reason the accessor exists.
		setResolver(read);
		// helix caches a getter's value per test context: one view per test.
		api.context.getter(
			"client",
			() =>
				new TestClientView(read(), {
					auth: config.auth,
					routes: config.routes,
				}),
		);
		api.cleanup(async () => {
			if (owned) await owned.close();
			clearResolver(read);
		});
	};
	// A wider parameter than `PluginApi` stays assignable to `Plugin`, so the
	// plugin declares exactly what it touches and a caller can drive it with
	// nothing more than that.
	return plugin satisfies Plugin;
}

let resolve: (() => TestClient) | undefined;

/** @internal Record how to reach the client in play. */
function setResolver(read: () => TestClient): void {
	resolve = read;
}

/**
 * @internal Forget it IF it is still the one recorded — a second `configure()`
 * in the same process must not have the first one's teardown clear its client.
 */
function clearResolver(read: () => TestClient): void {
	if (resolve === read) resolve = undefined;
}

/**
 * The client this run is using, reachable without a test context.
 *
 * `ctx.client` covers a test body. A helper module, a fixture, or a
 * `runnerHooks` setup has no context to read it from and had to be handed one
 * through a parameter every call site then had to thread. While a test runs it
 * is that test's `ctx.client`; outside one, the client of the file's server —
 * the way a `services/test_utils` module is reached from anywhere.
 *
 * Throws when no client is in play, which is a wiring mistake rather than a
 * state to handle.
 */
export function testClient(): TestClient {
	if (!resolve) {
		throw new Error(
			"[E_NO_TEST_CLIENT] No client is in play. Add `apiClient()` to the plugins " +
				"in tests/bootstrap.ts, and — with the `testUtils` shape — make sure the " +
				"suite's setup hook has started the server. This reads the client of the " +
				"CURRENT process.",
		);
	}
	const context = getActiveTest()?.context;
	const current =
		context === undefined ? undefined : Reflect.get(context, "client");
	if (current instanceof TestClient) return current;
	return resolve();
}

// Typing side of the plugin — importing it augments the helix test context.
declare module "@c9up/helix" {
	interface TestContext {
		client: TestClient;
	}
}
