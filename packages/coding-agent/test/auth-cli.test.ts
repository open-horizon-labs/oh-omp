import { describe, expect, it } from "bun:test";
import type { ProactiveRefreshOutcome } from "@oh-my-pi/pi-ai";
import { exitCodeForOutcomes, formatAuthRefreshOutput, parseDurationMs } from "../src/cli/auth-cli";

describe("auth cli", () => {
	describe("parseDurationMs", () => {
		it("parses unit suffixes and bare minutes", () => {
			expect(parseDurationMs("12m")).toBe(12 * 60_000);
			expect(parseDurationMs("90s")).toBe(90_000);
			expect(parseDurationMs("1h")).toBe(3_600_000);
			expect(parseDurationMs("1500ms")).toBe(1500);
			expect(parseDurationMs("5")).toBe(5 * 60_000);
			expect(parseDurationMs("1.5m")).toBe(90_000);
		});

		it("rejects invalid input", () => {
			expect(parseDurationMs("abc")).toBeUndefined();
			expect(parseDurationMs("-5m")).toBeUndefined();
			expect(parseDurationMs("")).toBeUndefined();
		});
	});

	describe("formatAuthRefreshOutput", () => {
		it("reports no credentials without a provider filter", () => {
			expect(formatAuthRefreshOutput([], { json: false })).toBe("No OAuth credentials found.");
		});

		it("reports no credentials scoped to a provider", () => {
			expect(formatAuthRefreshOutput([], { json: false, provider: "openai-codex" })).toBe(
				"No OAuth credentials found for openai-codex.",
			);
		});

		it("emits a JSON envelope that never carries credential material", () => {
			const outcomes: ProactiveRefreshOutcome[] = [
				{
					provider: "openai-codex",
					index: 0,
					status: "rotated",
					expires: Date.now() + 55 * 60_000,
				},
			];
			const rendered = formatAuthRefreshOutput(outcomes, { json: true });
			const payload = JSON.parse(rendered) as { outcomes: ProactiveRefreshOutcome[] };
			expect(payload.outcomes).toHaveLength(1);
			expect(payload.outcomes[0]?.provider).toBe("openai-codex");
			expect(payload.outcomes[0]?.status).toBe("rotated");
			expect(typeof payload.outcomes[0]?.expires).toBe("number");
			expect(rendered).not.toContain("access-");
			expect(rendered).not.toContain("refresh-");
		});

		it("describes failed refreshes in human output", () => {
			const outcomes: ProactiveRefreshOutcome[] = [
				{
					provider: "openai-codex",
					index: 0,
					status: "failed",
					expires: Date.now() + 5 * 60_000,
					error: "fetch failed: network unreachable",
				},
			];
			const rendered = formatAuthRefreshOutput(outcomes, { json: false });
			expect(rendered).toContain("openai-codex[0] failed");
			expect(rendered).toContain("network unreachable");
		});
	});

	describe("exitCodeForOutcomes", () => {
		it("is 0 when every credential is fresh or rotated", () => {
			expect(exitCodeForOutcomes([])).toBe(0);
			expect(
				exitCodeForOutcomes([
					{ provider: "p", index: 0, status: "fresh", expires: 1 },
					{ provider: "p", index: 1, status: "rotated", expires: 2 },
				]),
			).toBe(0);
		});

		it("is 1 when any refresh failed", () => {
			expect(
				exitCodeForOutcomes([
					{ provider: "p", index: 0, status: "rotated", expires: 1 },
					{ provider: "p", index: 1, status: "failed", expires: 2, error: "boom" },
				]),
			).toBe(1);
		});
	});
});
