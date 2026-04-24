import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { type FactsAction, parseFactsArgv, runFactsCommand } from "../cli/facts-cli";

const ACTIONS: FactsAction[] = ["add", "view", "search", "explain", "retract", "erase", "path", "prompt"];

export default class Facts extends Command {
	static description = "Manage local fact assertions";
	static strict = false;

	static args = {
		action: Args.string({
			description: "Facts action",
			required: false,
			options: ACTIONS,
		}),
		values: Args.string({
			description: "Action values",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		all: Flags.boolean({ description: "Include non-active facts" }),
		"include-personal": Flags.boolean({ description: "Allow personal facts in prompt output" }),
		scope: Flags.string({ description: "Fact scope", options: ["global", "project", "session", "task", "external"] }),
		sensitivity: Flags.string({
			description: "Fact sensitivity",
			options: ["normal", "personal", "sensitive", "secret"],
		}),
		canonical: Flags.string({ description: "Canonical human-readable fact text" }),
		limit: Flags.string({ description: "Maximum facts to return" }),
		db: Flags.string({ description: "Override facts database path" }),
	};

	static examples = [
		`oh-omp facts add project_decision project:oh-omp storage "SQLite for the manual Fact Store MVP"`,
		`oh-omp facts view`,
		`oh-omp facts search storage`,
		`oh-omp facts explain fact_123`,
		`oh-omp facts retract fact_123 "superseded by a later decision"`,
		`oh-omp facts erase fact_123 "privacy request"`,
	];

	async run(): Promise<void> {
		if (this.argv.length === 0) {
			renderCommandHelp("oh-omp", "facts", Facts);
			return;
		}
		const cmd = parseFactsArgv(this.argv);
		await runFactsCommand(cmd, { write: text => process.stdout.write(`${text}\n`) });
	}
}
