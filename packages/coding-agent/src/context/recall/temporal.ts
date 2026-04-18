import type { RecallSearchResult } from "./types";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_LIVE_WINDOW_MS = HOUR_MS;
export const DEFAULT_RECENT_WINDOW_DAYS = 7;
export const DEFAULT_RECENT_WINDOW_MS = DEFAULT_RECENT_WINDOW_DAYS * DAY_MS;

export type RecallBand = "live" | "recent" | "durable";

export function daysToRecallWindowMs(days: number | undefined): number {
	if (!Number.isFinite(days)) return DEFAULT_RECENT_WINDOW_MS;
	const normalizedDays = Math.max(1, Math.floor(days ?? DEFAULT_RECENT_WINDOW_DAYS));
	return normalizedDays * DAY_MS;
}

export function normalizeRecentWindowMs(recentWindowMs: number | undefined): number {
	if (!Number.isFinite(recentWindowMs)) return DEFAULT_RECENT_WINDOW_MS;
	return Math.max(DEFAULT_LIVE_WINDOW_MS, Math.floor(recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS));
}

export function getRecallAgeMs(timestamp: number, now: number = Date.now()): number {
	return Math.max(0, now - timestamp);
}

export function getRecallBand(ageMs: number, recentWindowMs: number = DEFAULT_RECENT_WINDOW_MS): RecallBand {
	const normalizedRecentWindowMs = normalizeRecentWindowMs(recentWindowMs);
	if (ageMs <= DEFAULT_LIVE_WINDOW_MS) return "live";
	if (ageMs <= normalizedRecentWindowMs) return "recent";
	return "durable";
}

export function formatRecallAge(ageMs: number): string {
	if (ageMs < MINUTE_MS) return `${Math.floor(ageMs / SECOND_MS)}s`;
	if (ageMs < HOUR_MS) return `${Math.floor(ageMs / MINUTE_MS)}m`;
	if (ageMs < DAY_MS) return `${Math.floor(ageMs / HOUR_MS)}h`;
	return `${Math.floor(ageMs / DAY_MS)}d`;
}

export function selectHydrationResultIndexToDrop(
	results: RecallSearchResult[],
	options: { now?: number; recentWindowMs?: number } = {},
): number {
	const now = options.now ?? Date.now();
	const recentWindowMs = normalizeRecentWindowMs(options.recentWindowMs);
	let selectedIndex = 0;
	let selectedBandPriority = -1;
	let selectedAgeMs = -1;

	for (const [index, result] of results.entries()) {
		const ageMs = getRecallAgeMs(result.timestamp, now);
		const band = getRecallBand(ageMs, recentWindowMs);
		const bandPriority = band === "durable" ? 2 : band === "recent" ? 1 : 0;
		if (
			bandPriority > selectedBandPriority ||
			(bandPriority === selectedBandPriority && ageMs > selectedAgeMs) ||
			(bandPriority === selectedBandPriority && ageMs === selectedAgeMs && index > selectedIndex)
		) {
			selectedIndex = index;
			selectedBandPriority = bandPriority;
			selectedAgeMs = ageMs;
		}
	}

	return selectedIndex;
}
