import type { ProjectionRuntime } from "./projection-runtime";
import type { ProjectionSnapshot } from "./projection-types";
import type { RpcCommand, RpcProjectionCommandStatus, RpcProjectionPublishedEvent, RpcResponse } from "./rpc-types";

export const PROJECTION_INTERVENTION_CUSTOM_TYPE = "projection_intervention" as const;

export type ProjectionCommandStatus = RpcProjectionCommandStatus;

const MAX_PROJECTION_ID_BYTES = 128;
const textEncoder = new TextEncoder();

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function parseProjectionId(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("projectionId must be a non-empty string");
	}
	if (hasUnpairedSurrogate(value)) {
		throw new Error("projectionId must not contain unpaired surrogates");
	}
	if (textEncoder.encode(value).byteLength > MAX_PROJECTION_ID_BYTES) {
		throw new Error(`projectionId exceeds ${MAX_PROJECTION_ID_BYTES} bytes`);
	}
	return value;
}

export interface ProjectionInterventionMessage {
	customType: typeof PROJECTION_INTERVENTION_CUSTOM_TYPE;
	content: string;
	display: false;
	details: {
		projectionId: string;
		observedRevision: number;
		operationId: string;
		idempotencyKey: string;
		input?: unknown;
	};
	attribution: "user";
}

export interface ProjectionContextSink {
	sendCustomMessage(
		message: ProjectionInterventionMessage,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;
}

function interventionMessage(details: ProjectionInterventionMessage["details"]): ProjectionInterventionMessage {
	return {
		customType: PROJECTION_INTERVENTION_CUSTOM_TYPE,
		content: `projection_intervention ${details.projectionId}#${details.observedRevision} ${details.operationId}`,
		display: false,
		details,
		attribution: "user",
	};
}

export function handlePublishProjection(
	runtime: ProjectionRuntime,
	command: { snapshot?: unknown },
): { data: ProjectionCommandStatus; event?: RpcProjectionPublishedEvent } {
	const result = runtime.publish(command.snapshot);
	if (result.status === "accepted") {
		return {
			data: {
				status: "accepted",
				projectionId: result.snapshot.projectionId,
				revision: result.snapshot.revision,
			},
			event: {
				type: "projection_published",
				projectionId: result.snapshot.projectionId,
				revision: result.snapshot.revision,
				operationCount: result.snapshot.operations.length,
			},
		};
	}
	return { data: result };
}

export function handleGetProjection(
	runtime: ProjectionRuntime,
	command: { projectionId?: unknown },
): { data: ProjectionSnapshot | null } {
	const projectionId = parseProjectionId(command.projectionId);
	const snapshot = runtime.get(projectionId);
	return { data: snapshot === undefined ? null : structuredClone(snapshot) };
}

export async function handleSubmitProjectionIntervention(
	runtime: ProjectionRuntime,
	command: { intervention?: unknown },
	sink?: ProjectionContextSink,
): Promise<{ data: ProjectionCommandStatus }> {
	const result = runtime.intervene(command.intervention);
	if (result.status === "accepted") {
		if (sink) {
			try {
				const details: ProjectionInterventionMessage["details"] = {
					projectionId: result.intervention.projectionId,
					observedRevision: result.intervention.observedRevision,
					operationId: result.intervention.operationId,
					idempotencyKey: result.intervention.idempotencyKey,
				};
				if ("input" in result.intervention) {
					details.input = result.intervention.input;
				}
				await sink.sendCustomMessage(interventionMessage(details), {
					triggerTurn: false,
					deliverAs: "nextTurn",
				});
			} catch {
				// Recorded first; ACK accepted even if context emit fails.
			}
		}
		return {
			data: {
				status: "accepted",
				projectionId: result.intervention.projectionId,
				revision: result.snapshot.revision,
			},
		};
	}
	if (result.status === "duplicate") {
		return {
			data: {
				status: "duplicate",
				projectionId: result.intervention.projectionId,
				revision: result.snapshot.revision,
			},
		};
	}
	return { data: result };
}

const PROJECTION_RPC_COMMANDS = new Set(["publish_projection", "get_projection", "submit_projection_intervention"]);

export function getProjectionRpcDisabledResponse(
	command: Pick<RpcCommand, "id" | "type">,
	experimentalProjections: boolean,
): RpcResponse | undefined {
	if (experimentalProjections || !PROJECTION_RPC_COMMANDS.has(command.type)) return undefined;

	return {
		id: command.id,
		type: "response",
		command: command.type,
		success: false,
		error: "Projection RPC commands are disabled; pass --experimental-projections to enable them",
	};
}
