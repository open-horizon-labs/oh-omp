/**
 * Format assembled context packets for prompt injection.
 *
 * Converts WorkingContextPacketV1 fragments into a text block suitable
 * for injection as a developer message in the LLM context.
 */

import type { WorkingContextPacketV1 } from "../memory-contract";

/**
 * Format assembled context fragments into injectable prompt text.
 *
 * Returns `null` when the packet contains no fragments (nothing to inject).
 */
export function formatAssembledContext(packet: WorkingContextPacketV1): string | null {
	if (packet.fragments.length === 0) return null;

	const parts: string[] = ["<assembled-context>"];

	for (const fragment of packet.fragments) {
		parts.push(`<fragment key="${fragment.locatorKey ?? fragment.id}" tier="${fragment.tier}">`);
		parts.push(fragment.content);
		parts.push("</fragment>");
	}

	parts.push("</assembled-context>");
	return parts.join("\n");
}
