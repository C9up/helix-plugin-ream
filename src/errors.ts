/**
 * helix-plugin-ream errors, one per code, so a caller can match on
 * `error.code` or on `error instanceof errors.E_…` rather than on the message.
 */
import { createError } from "@c9up/flare";

/** `apiClient()` was given neither `testUtils` nor `boot`. */
export const E_HELIX_PLUGIN_REAM_NO_SERVER = createError(
	"apiClient() needs either `testUtils` (a suite hook starts the server) or " +
		"`boot` (the client starts one on its first request). It was given " +
		"neither, so `ctx.client` would have had nothing to talk to.",
	"E_HELIX_PLUGIN_REAM_NO_SERVER",
);

/** A test read `ctx.client` but no suite hook started the server. */
export const E_HELIX_PLUGIN_REAM_SERVER_NOT_STARTED = createError(
	"No server is running for this suite. Add the hook that starts it:\n" +
		"  configureSuite(suite) {\n" +
		"    if (suite.name === 'functional') {\n" +
		"      return suite.setup(() => testUtils.httpServer().start())\n" +
		"    }\n" +
		"  }",
	"E_HELIX_PLUGIN_REAM_SERVER_NOT_STARTED",
);

/** `testClient()` was called while no `apiClient()` plugin is in play. */
export const E_HELIX_PLUGIN_REAM_NO_TEST_CLIENT = createError(
	"No client is in play. Add `apiClient()` to the plugins in " +
		"tests/bootstrap.ts, and — with the `testUtils` shape — make sure the " +
		"suite's setup hook has started the server. This reads the client of " +
		"the CURRENT process.",
	"E_HELIX_PLUGIN_REAM_NO_TEST_CLIENT",
);

/**
 * A suite name was asked for but the rc file does not declare it. The second
 * value says what it declares.
 */
export const E_HELIX_PLUGIN_REAM_UNKNOWN_SUITE = createError<[string, string]>(
	'Unknown test suite "%s"%s',
	"E_HELIX_PLUGIN_REAM_UNKNOWN_SUITE",
);

/**
 * A suite declares `configure`, but the runner was given no module path to
 * re-import it in each worker. The message names the suites.
 */
export const E_HELIX_PLUGIN_REAM_SUITE_CONFIGURE_UNREACHABLE = createError<
	[string]
>("%s", "E_HELIX_PLUGIN_REAM_SUITE_CONFIGURE_UNREACHABLE");
