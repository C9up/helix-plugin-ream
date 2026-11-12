/**
 * Where an installed package's export resolves for this package: the file
 * its manifest's `exports[subpath].import` names. That is the sources in
 * the workspace and the build once installed from npm, whose published
 * manifest points every export at `dist/`. A fixture must import helix and
 * ream through these same files, or it gets a second module instance the
 * plugin never registers with.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `import` target of one export, or `undefined` when none is named. */
function exportTarget(manifest: unknown, subpath: string): string | undefined {
	if (!isRecord(manifest)) return undefined;
	const exports = manifest.exports;
	if (subpath === "." && typeof exports === "string") return exports;
	if (!isRecord(exports)) return undefined;
	const entry = exports[subpath];
	if (typeof entry === "string") return entry;
	if (!isRecord(entry)) return undefined;
	const target = entry.import ?? entry.default;
	return typeof target === "string" ? target : undefined;
}

/**
 * The real path of `name`'s `subpath` export as installed under
 * `pluginRoot`, or `undefined` when the package or that export is absent.
 */
export function installedEntry(
	pluginRoot: string,
	name: string,
	subpath = ".",
): string | undefined {
	const packageDir = path.join(pluginRoot, "node_modules", name);
	const manifestPath = path.join(packageDir, "package.json");
	if (!existsSync(manifestPath)) return undefined;
	const target = exportTarget(
		JSON.parse(readFileSync(manifestPath, "utf8")),
		subpath,
	);
	if (target === undefined) return undefined;
	const entry = path.resolve(packageDir, target);
	return existsSync(entry) ? realpathSync(entry) : undefined;
}
