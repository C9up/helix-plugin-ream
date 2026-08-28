/**
 * `@c9up/helix-plugin-ream` — the bridge between Ream and its test runner.
 *
 * Ream knows nothing about helix, helix knows nothing about Ream: the plugin
 * that joins them lives here, and declares both sides as peers. The HTTP test
 * client itself (`TestClient`, `createTestClient`) stays in `@c9up/ream/testing`
 * — it drives a Ream server and owes nothing to the runner.
 *
 *   // tests/bootstrap.ts
 *   import { configure } from '@c9up/helix'
 *   import { apiClient } from '@c9up/helix-plugin-ream'
 *   await configure({ plugins: [apiClient({ boot: () => bootApp() })] })
 *
 *   // a test
 *   test('health', async ({ client }) => {
 *     await client.get('/health').assertOk()
 *   })
 */

import type { Plugin, PluginApi } from "@c9up/helix";
import type { AuthStrategy, RouteManifest } from "@c9up/ream/testing";
import { TestClient } from "@c9up/ream/testing";

/** The slice of helix's `PluginApi` this plugin actually uses. */
export type ClientHost = Pick<PluginApi, "context" | "cleanup">;

export interface ApiClientConfig {
	/** Boot the app under test on the given port; return the port + a close fn. */
	boot: (
		port: number,
	) => Promise<{ port: number; close: () => Promise<void> | void }>;
	/** Warden auth strategy for `client.withAuth()`/`asUser()`. */
	auth?: AuthStrategy;
	/** Named-route manifest (`router.namedManifest()`) for `client.visit()`. */
	routes?: RouteManifest;
}

/**
 * Injects a {@link TestClient} on the test context as `ctx.client`.
 *
 * The server starts on the FIRST REQUEST, not at `configure()` time. helix runs
 * one process per file, so a bootstrap that boots eagerly boots once per file —
 * including every file that never issues a request. Measured on a real project:
 * ~400ms per file, and on a campaign where three quarters of the files are unit
 * tests that is most of its runtime, spent on a server nobody talks to.
 *
 * Booting late also keeps a diagnostic that eager booting costs. A file with no
 * server has nothing holding the event loop open, so it does not need
 * `forceExit` — and `forceExit` is global, so turning it on for the few files
 * that do would silence "a test left something running" for all of them.
 *
 * The client is closed via `api.cleanup` after the run — a no-op for a file
 * that never started one, so the teardown stays unconditional.
 */
export function apiClient(config: ApiClientConfig) {
	const plugin = async (api: ClientHost): Promise<void> => {
		const client = new TestClient(config.boot, {
			auth: config.auth,
			routes: config.routes,
		});
		setTestClient(client);
		api.context.macro("client", client);
		api.cleanup(async () => {
			await client.close();
			clearTestClient(client);
		});
	};
	// A wider parameter than `PluginApi` stays assignable to `Plugin`, so the
	// plugin declares exactly what it touches and a caller can drive it with
	// nothing more than that.
	return plugin satisfies Plugin;
}

let current: TestClient | undefined;

/** @internal Record the client the plugin installed. */
function setTestClient(client: TestClient): void {
	current = client;
}

/**
 * @internal Forget it IF it is still the one recorded — a second `configure()`
 * in the same process must not have the first one's teardown clear its client.
 */
function clearTestClient(client: TestClient): void {
	if (current === client) current = undefined;
}

/**
 * The client this run installed, reachable without a test context.
 *
 * `ctx.client` covers a test body. A helper module, a fixture, or a
 * `runnerHooks` setup has no context to read it from and had to be handed one
 * through a parameter every call site then had to thread. This is the same
 * instance — booting it here boots the one the tests use.
 *
 * Throws when no `apiClient()` plugin has run, which is a wiring mistake rather
 * than a state to handle.
 */
export function testClient(): TestClient {
	if (!current) {
		throw new Error(
			"[E_NO_TEST_CLIENT] No client is installed. Add `apiClient({ boot })` to " +
				"the plugins in tests/bootstrap.ts — and note this reads the client of " +
				"the CURRENT process, so it is only available once that bootstrap has run.",
		);
	}
	return current;
}

// Typing side of the plugin — importing it augments the helix test context.
declare module "@c9up/helix" {
	interface TestContext {
		client: TestClient;
	}
}
