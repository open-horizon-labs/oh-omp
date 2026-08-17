/**
 * Manage OAuth credentials.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { exitCodeForOutcomes, formatAuthRefreshOutput, parseDurationMs } from "../cli/auth-cli";
import { discoverAuthStorage } from "../sdk";

const ACTIONS = ["refresh"] as const;

export default class Auth extends Command {
	static description = "Manage OAuth credentials";

	static args = {
		action: Args.string({
			description: "Auth action",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		provider: Flags.string({ description: "Limit to one provider" }),
		"expiring-within": Flags.string({
			description:
				"Refresh when the access token expires within this window (e.g. 12m, 90s, 1h; bare number = minutes). Default: ~20% of the token TTL",
		}),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Auth);
		const action = args.action ?? "refresh";
		if (action !== "refresh") {
			console.error(`Unknown auth action: ${action}`);
			process.exit(1);
		}

		let expiringWithinMs: number | undefined;
		if (flags["expiring-within"] !== undefined) {
			expiringWithinMs = parseDurationMs(flags["expiring-within"]);
			if (expiringWithinMs === undefined) {
				console.error(`Invalid --expiring-within value: ${flags["expiring-within"]}`);
				process.exit(1);
			}
		}

		const storage = await discoverAuthStorage();
		const outcomes = await storage.refreshExpiring({
			provider: flags.provider,
			expiringWithinMs,
		});
		console.log(
			formatAuthRefreshOutput(outcomes, {
				json: flags.json === true,
				provider: flags.provider,
			}),
		);
		const exitCode = exitCodeForOutcomes(outcomes);
		if (exitCode !== 0) {
			process.exit(exitCode);
		}
	}
}
