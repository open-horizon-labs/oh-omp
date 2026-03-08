/**
 * Locator retrievers for the bridge.
 *
 * Two retriever implementations:
 * - artifactRetriever: reads artifact files via ArtifactManager.getPath()
 * - reReadRetriever: re-reads files for non-artifact-backed entries
 */

import * as os from "node:os";

import type { LocatorRetriever } from "../assembler/types";
import type { MemoryLocatorEntry } from "../memory-contract";

// ═══════════════════════════════════════════════════════════════════════════
// Artifact retriever
// ═══════════════════════════════════════════════════════════════════════════

/** Interface for artifact path resolution. Subset of ArtifactManager. */
export interface ArtifactResolver {
	getPath(id: string): Promise<string | null>;
}

/**
 * Create a retriever that reads artifact files.
 *
 * For entries whose `how.params.artifactId` is set, reads the artifact
 * content via ArtifactManager. Returns null for missing artifacts.
 */
export function createArtifactRetriever(resolver: ArtifactResolver): LocatorRetriever {
	return async (entry: MemoryLocatorEntry): Promise<string | null> => {
		const artifactId = entry.how.params?.artifactId;
		if (typeof artifactId !== "string") return null;

		const filePath = await resolver.getPath(artifactId);
		if (!filePath) return null;

		try {
			return await Bun.file(filePath).text();
		} catch {
			return null;
		}
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Re-read retriever
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a retriever that re-reads files for non-artifact-backed entries.
 *
 * For entries whose method is "read" and `how.params.filePath` is set,
 * reads the file directly. This handles small `read` results that were
 * not truncated into artifacts.
 */
export function createReReadRetriever(): LocatorRetriever {
	return async (entry: MemoryLocatorEntry): Promise<string | null> => {
		const rawPath = entry.how.params?.filePath;
		if (typeof rawPath !== "string") return null;
		const filePath = rawPath.startsWith("~/") ? rawPath.replace("~", os.homedir()) : rawPath;

		try {
			return await Bun.file(filePath).text();
		} catch {
			return null;
		}
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Composite retriever
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a composite retriever that tries artifact retrieval first,
 * then falls back to re-reading the file.
 */
export function createCompositeRetriever(resolver: ArtifactResolver): LocatorRetriever {
	const artifactRetriever = createArtifactRetriever(resolver);
	const reReadRetriever = createReReadRetriever();

	return async (entry: MemoryLocatorEntry): Promise<string | null> => {
		// Try artifact retrieval first (for truncated outputs)
		if (entry.how.params?.artifactId) {
			const content = await artifactRetriever(entry);
			if (content !== null) return content;
		}

		// Fall back to re-reading the file
		if (entry.how.params?.filePath) {
			return reReadRetriever(entry);
		}

		return null;
	};
}
