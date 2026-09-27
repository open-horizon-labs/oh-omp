import type { ProjectionRuntime } from "./projection-runtime";
import type { RpcProjectionCommandStatus, RpcProjectionPublishedEvent } from "./rpc-types";

export const PROJECTION_INTERVENTION_CUSTOM_TYPE = "projection_intervention" as const;

export type ProjectionCommandStatus = RpcProjectionCommandStatus;

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
