import {
	type ProjectionIntervention,
	type ProjectionSnapshot,
	parseProjectionIntervention,
	parseProjectionSnapshot,
} from "./projection-types";

export type ProjectionPublishResult =
	| { status: "accepted"; snapshot: ProjectionSnapshot }
	| { status: "conflict"; reason: string }
	| { status: "invalid"; reason: string };

export type ProjectionInterveneResult =
	| { status: "accepted"; intervention: ProjectionIntervention; snapshot: ProjectionSnapshot }
	| { status: "duplicate"; intervention: ProjectionIntervention; snapshot: ProjectionSnapshot }
	| { status: "conflict"; reason: string }
	| { status: "invalid"; reason: string };

type StoredIntervention = {
	canonical: string;
	intervention: ProjectionIntervention;
};

function invalidReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function canonicalSnapshot(snapshot: ProjectionSnapshot): string {
	return JSON.stringify(snapshot);
}

function canonicalIntervention(intervention: ProjectionIntervention): string {
	const { idempotencyKey: _idempotencyKey, ...rest } = intervention;
	return JSON.stringify(rest);
}

function declaredOperationIds(snapshot: ProjectionSnapshot): Set<string> {
	return new Set(snapshot.operations.map(operation => operation.id));
}

/**
 * In-memory projection store for the #776 experiment.
 *
 * Latest snapshot is keyed by projectionId. Intervention idempotency keys are
 * also keyed by projectionId and are not reset when a later revision is
 * published. Process restart loses both maps; that is accepted for day-1.
 */
export class ProjectionRuntime {
	#snapshots = new Map<string, ProjectionSnapshot>();
	#interventions = new Map<string, Map<string, StoredIntervention>>();

	get(projectionId: string): ProjectionSnapshot | undefined {
		return this.#snapshots.get(projectionId);
	}

	publish(value: unknown): ProjectionPublishResult {
		let snapshot: ProjectionSnapshot;
		try {
			snapshot = parseProjectionSnapshot(value);
		} catch (error) {
			return { status: "invalid", reason: invalidReason(error) };
		}

		const existing = this.#snapshots.get(snapshot.projectionId);
		if (existing === undefined || snapshot.revision > existing.revision) {
			this.#snapshots.set(snapshot.projectionId, snapshot);
			return { status: "accepted", snapshot };
		}

		if (snapshot.revision < existing.revision) {
			return { status: "conflict", reason: "stale-revision" };
		}

		if (canonicalSnapshot(snapshot) === canonicalSnapshot(existing)) {
			return { status: "accepted", snapshot: existing };
		}

		return { status: "conflict", reason: "content-conflict" };
	}

	intervene(value: unknown): ProjectionInterveneResult {
		let intervention: ProjectionIntervention;
		try {
			intervention = parseProjectionIntervention(value);
		} catch (error) {
			return { status: "invalid", reason: invalidReason(error) };
		}

		const storedByKey = this.#interventions.get(intervention.projectionId);
		const stored = storedByKey?.get(intervention.idempotencyKey);
		if (stored) {
			if (stored.canonical !== canonicalIntervention(intervention)) {
				return { status: "conflict", reason: "idempotency-conflict" };
			}
			const snapshot = this.#snapshots.get(intervention.projectionId);
			if (snapshot === undefined) {
				return { status: "conflict", reason: "unknown-projection" };
			}
			return {
				status: "duplicate",
				intervention: stored.intervention,
				snapshot,
			};
		}

		const snapshot = this.#snapshots.get(intervention.projectionId);
		if (snapshot === undefined) {
			return { status: "conflict", reason: "unknown-projection" };
		}
		if (intervention.observedRevision !== snapshot.revision) {
			return { status: "conflict", reason: "revision-mismatch" };
		}
		if (!declaredOperationIds(snapshot).has(intervention.operationId)) {
			return { status: "conflict", reason: "undeclared-operation" };
		}

		const nextStored: StoredIntervention = {
			canonical: canonicalIntervention(intervention),
			intervention,
		};
		const nextByKey = storedByKey ?? new Map<string, StoredIntervention>();
		nextByKey.set(intervention.idempotencyKey, nextStored);
		this.#interventions.set(intervention.projectionId, nextByKey);

		return { status: "accepted", intervention, snapshot };
	}
}
