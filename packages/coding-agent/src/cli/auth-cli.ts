/**
 * Auth CLI helpers.
 *
 * Pure logic for the `omp auth` subcommand; the command class in
 * `commands/auth.ts` owns storage discovery and console output.
 */
import type { ProactiveRefreshOutcome } from "@oh-my-pi/pi-ai";

export interface AuthRefreshCommandArgs {
	provider?: string;
	expiringWithinMs?: number;
	json: boolean;
}

/**
 * Parse a duration ("<n>", "<n>ms", "<n>s", "<n>m", "<n>h") into milliseconds.
 * A bare number is minutes, matching the "expiring within N minutes" phrasing.
 */
export function parseDurationMs(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
	if (!match) return undefined;
	const factor = match[2] === "ms" ? 1 : match[2] === "s" ? 1000 : match[2] === "h" ? 3_600_000 : 60_000;
	return Math.round(Number.parseFloat(match[1]) * factor);
}

/**
 * Process exit code for a refresh run: 1 when any refresh failed, 0 otherwise.
 */
export function exitCodeForOutcomes(outcomes: ProactiveRefreshOutcome[]): number {
	return outcomes.some(outcome => outcome.status === "failed") ? 1 : 0;
}

/**
 * Render refresh outcomes. Never includes token material — only provider, index,
 * status, expiry, and error descriptions.
 */
export function formatAuthRefreshOutput(
	outcomes: ProactiveRefreshOutcome[],
	args: { json: boolean; provider?: string },
): string {
	if (args.json) {
		return JSON.stringify({ outcomes }, null, 2);
	}
	if (outcomes.length === 0) {
		return args.provider ? `No OAuth credentials found for ${args.provider}.` : "No OAuth credentials found.";
	}
	return outcomes
		.map(outcome => {
			const expiresInMin = Math.max(0, Math.round((outcome.expires - Date.now()) / 60_000));
			const suffix = outcome.status === "failed" ? `: ${outcome.error ?? "unknown error"}` : "";
			return `${outcome.provider}[${outcome.index}] ${outcome.status} — expires in ~${expiresInMin}m${suffix}`;
		})
		.join("\n");
}
