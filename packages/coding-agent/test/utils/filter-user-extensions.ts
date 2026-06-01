import * as path from "node:path";
import { getAgentDir, getPluginsDir } from "@oh-my-pi/pi-utils";

export function filterUserExtensions<T extends { path: string }>(extensions: T[]): T[] {
	const userExtensionsDir = path.join(getAgentDir(), "extensions");
	const pluginsDir = getPluginsDir();
	return extensions.filter(ext => !ext.path.startsWith(userExtensionsDir) && !ext.path.startsWith(pluginsDir));
}

export function filterUserExtensionErrors<T extends { path: string }>(errors: T[]): T[] {
	const userExtensionsDir = path.join(getAgentDir(), "extensions");
	const pluginsDir = getPluginsDir();
	return errors.filter(err => !err.path.startsWith(userExtensionsDir) && !err.path.startsWith(pluginsDir));
}
