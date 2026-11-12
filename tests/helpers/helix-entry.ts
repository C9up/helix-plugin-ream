/**
 * Where `@c9up/helix` resolves for this package: the file its manifest's
 * `exports["."].import` names. That is the sources in the workspace and the
 * build once installed from npm, whose published manifest points the entry
 * at `dist/`. A fixture must import helix through this same file, or it gets
 * a second module instance the plugin never registers with.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `import` target of the root export, or `undefined` when none is named. */
function rootImport(manifest: unknown): string | undefined {
	if (!isRecord(manifest)) return undefined;
	const exports = manifest.exports;
	if (typeof exports === "string") return exports;
	if (!isRecord(exports)) return undefined;
	const root = exports["."];
	if (typeof root === "string") return root;
	if (!isRecord(root)) return undefined;
	const target = root.import ?? root.default;
	return typeof target === "string" ? target : undefined;
}

/**
 * The real path of helix's root entry as installed under `pluginRoot`, or
 * `undefined` when helix is not installed there.
 */
export function helixEntryPath(pluginRoot: string): string | undefined {
	const packageDir = path.join(pluginRoot, "node_modules/@c9up/helix");
	const manifestPath = path.join(packageDir, "package.json");
	if (!existsSync(manifestPath)) return undefined;
	const target = rootImport(JSON.parse(readFileSync(manifestPath, "utf8")));
	if (target === undefined) return undefined;
	const entry = path.resolve(packageDir, target);
	return existsSync(entry) ? realpathSync(entry) : undefined;
}
