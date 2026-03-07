/**
 * Builds consolidated introspection snapshots for the get_introspection RPC command.
 *
 * Extracted into a standalone module for testability — the snapshot builder is
 * a pure function over settings + bridge state.
 */

import type { Settings } from "../../config/settings";
import type { ToolResultBridge } from "../../context/bridge";
import { type ContextManagerState, getContextManagerState } from "../../context-manager";
import type { RpcIntrospectionSnapshot, RpcProvenanceSummaryEntry } from "./rpc-types";

/**
 * Build a consolidated introspection snapshot from context-manager state and
 * assembler bridge (if active).
 */
export function buildIntrospectionSnapshot(
	settings: Settings,
	bridge: ToolResultBridge | undefined,
): RpcIntrospectionSnapshot {
	const cmState: ContextManagerState = getContextManagerState(settings);
	const contract = bridge?.contract ?? null;

	let contractSummary: RpcIntrospectionSnapshot["contract"] = null;
	const provenance: RpcProvenanceSummaryEntry[] = [];

	if (contract) {
		const locatorsByTier = { long_term: 0, short_term: 0, working: 0 };
		const locatorsByTrust = { authoritative: 0, derived: 0, heuristic: 0 };
		const provenanceMap = new Map<string, { total: number; sumConfidence: number }>();

		for (const entry of contract.locatorMap) {
			locatorsByTier[entry.tier]++;
			locatorsByTrust[entry.trust]++;

			const src = entry.provenance.source;
			const agg = provenanceMap.get(src);
			if (agg) {
				agg.total++;
				agg.sumConfidence += entry.provenance.confidence;
			} else {
				provenanceMap.set(src, { total: 1, sumConfidence: entry.provenance.confidence });
			}
		}

		// Aggregate unresolved loops from all STM records
		const unresolvedLoops: string[] = [];
		for (const stm of contract.shortTerm) {
			for (const loop of stm.unresolvedLoops) {
				if (!unresolvedLoops.includes(loop)) {
					unresolvedLoops.push(loop);
				}
			}
		}

		for (const [source, agg] of provenanceMap) {
			provenance.push({
				source,
				count: agg.total,
				avgConfidence: agg.sumConfidence / agg.total,
			});
		}

		contractSummary = {
			version: contract.version,
			locatorCount: contract.locatorMap.length,
			locatorsByTier,
			locatorsByTrust,
			shortTermRecordCount: contract.shortTerm.length,
			unresolvedLoops,
		};
	}

	return {
		mode: cmState.mode,
		assemblerActive: cmState.assemblerActive,
		contract: contractSummary,
		provenance,
		budget: contract?.working?.budget ?? null,
	};
}
