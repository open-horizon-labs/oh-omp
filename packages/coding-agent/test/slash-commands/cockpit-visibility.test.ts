import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const toggleContextCockpitVisibility = vi.fn();
	const setText = vi.fn();

	return {
		toggleContextCockpitVisibility,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				toggleContextCockpitVisibility,
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/v slash command", () => {
	it("toggles cockpit visibility and clears the editor", async () => {
		const harness = createRuntime();
		const handled = await executeBuiltinSlashCommand("/v", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.toggleContextCockpitVisibility).toHaveBeenCalledTimes(1);
	});
});
