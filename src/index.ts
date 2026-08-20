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
 * Injects a booted {@link TestClient} on the test context as `ctx.client`.
 *
 * The server is booted once at `configure()` time, shared across the run, and
 * closed via `api.cleanup` after the run finishes — a proper lifecycle, with no
 * reliance on process exit.
 */
export function apiClient(config: ApiClientConfig) {
	const plugin = async (api: ClientHost): Promise<void> => {
		const client = new TestClient(config.boot, {
			auth: config.auth,
			routes: config.routes,
		});
		await client.boot();
		api.context.macro("client", client);
		api.cleanup(() => client.close());
	};
	// A wider parameter than `PluginApi` stays assignable to `Plugin`, so the
	// plugin declares exactly what it touches and a caller can drive it with
	// nothing more than that.
	return plugin satisfies Plugin;
}

// Typing side of the plugin — importing it augments the helix test context.
declare module "@c9up/helix" {
	interface TestContext {
		client: TestClient;
	}
}
