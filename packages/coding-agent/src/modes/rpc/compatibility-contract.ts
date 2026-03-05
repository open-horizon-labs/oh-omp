import type { AgentEvent } from "@oh-my-pi/pi-agent-core";

/**
 * Increment when the external RPC compatibility contract changes in a breaking way.
 */
export const RPC_COMPATIBILITY_VERSION = 1 as const;

/**
 * Agent events that are part of the external RPC compatibility surface.
 * Hosts may depend on this list staying stable across minor changes.
 */
export const RPC_COMPATIBILITY_AGENT_EVENT_TYPES = [
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
] as const satisfies readonly AgentEvent["type"][];

const rpcCompatibilityAgentEventTypeSet = new Set<AgentEvent["type"]>(RPC_COMPATIBILITY_AGENT_EVENT_TYPES);

/**
 * RPC host->agent interactive UI response envelope type.
 */
export const RPC_EXTENSION_UI_RESPONSE_TYPE = "extension_ui_response" as const;

/**
 * RPC agent->host interactive UI request envelope type.
 */
export const RPC_EXTENSION_UI_REQUEST_TYPE = "extension_ui_request" as const;

/**
 * Tool name used by orchestrators to detect terminal completion payloads.
 */
export const RPC_COMPLETION_TOOL_NAME = "signal_completion" as const;

export function isRpcCompatibilityAgentEventType(type: unknown): type is AgentEvent["type"] {
	return typeof type === "string" && rpcCompatibilityAgentEventTypeSet.has(type as AgentEvent["type"]);
}
