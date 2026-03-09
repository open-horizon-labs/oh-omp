/**
 * DetailPanel - Detail view for a selected prompt inspector section.
 *
 * Shows the full drill-down content for whichever section the operator
 * has selected in the section list. Delegates rendering to the section's
 * own `renderDetail()` callback.
 */

import type { Component } from "@oh-my-pi/pi-tui";

import { theme } from "../../theme/theme";
import type { InspectorSection } from "./types";

export class DetailPanel implements Component {
	#section: InspectorSection | null = null;

	setSection(section: InspectorSection | null): void {
		this.#section = section;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.#section) {
			return [theme.fg("muted", "No snapshot available"), theme.fg("dim", "Run a prompt to capture data")];
		}

		return this.#section.renderDetail(width);
	}
}
