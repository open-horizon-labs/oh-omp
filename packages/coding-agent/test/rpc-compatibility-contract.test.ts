import { describe, expect, test } from "bun:test";
import {
	isRpcCompatibilityAgentEventType,
	RPC_COMPATIBILITY_AGENT_EVENT_TYPES,
	RPC_COMPATIBILITY_VERSION,
	RPC_COMPLETION_TOOL_NAME,
	RPC_EXTENSION_UI_REQUEST_TYPE,
	RPC_EXTENSION_UI_RESPONSE_TYPE,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/compatibility-contract";

describe("RPC compatibility contract", () => {
	test("pins contract version and envelope markers", () => {
		expect(RPC_COMPATIBILITY_VERSION).toBe(1);
		expect(RPC_EXTENSION_UI_REQUEST_TYPE).toBe("extension_ui_request");
		expect(RPC_EXTENSION_UI_RESPONSE_TYPE).toBe("extension_ui_response");
		expect(RPC_COMPLETION_TOOL_NAME).toBe("signal_completion");
	});

	test("pins agent event compatibility set", () => {
		expect(RPC_COMPATIBILITY_AGENT_EVENT_TYPES).toEqual([
			"agent_start",
			"agent_end",
			"turn_start",
			"turn_end",
			"message_start",
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]);
		expect(new Set(RPC_COMPATIBILITY_AGENT_EVENT_TYPES).size).toBe(RPC_COMPATIBILITY_AGENT_EVENT_TYPES.length);
	});

	test("classifies compatibility event types", () => {
		for (const eventType of RPC_COMPATIBILITY_AGENT_EVENT_TYPES) {
			expect(isRpcCompatibilityAgentEventType(eventType)).toBe(true);
		}

		const nonContractEventTypes: unknown[] = [
			"extension_ui_request",
			"extension_ui_response",
			"ready",
			"response",
			"unknown",
			42,
			null,
			{},
		];

		for (const eventType of nonContractEventTypes) {
			expect(isRpcCompatibilityAgentEventType(eventType)).toBe(false);
		}
	});
});
