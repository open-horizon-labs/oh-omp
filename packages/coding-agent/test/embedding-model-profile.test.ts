import { describe, expect, test } from "bun:test";
import { qwen3EmbeddingProfile } from "@oh-my-pi/pi-coding-agent/context/recall/model-profile";

describe("Qwen3 embedding model profile", () => {
	test("matches the live llama.cpp tokenizer convention", () => {
		expect(qwen3EmbeddingProfile.id).toBe("qwen3-embedding-4b");
		expect(qwen3EmbeddingProfile.dimension).toBe(2_560);
		expect(qwen3EmbeddingProfile.maxSequenceTokens).toBe(32_768);
		expect(qwen3EmbeddingProfile.documentChunkTokens).toBe(2_048);
		expect(qwen3EmbeddingProfile.queryTokens).toBe(1_024);
		expect(qwen3EmbeddingProfile.countTokens("hello world")).toBe(2);
		expect(qwen3EmbeddingProfile.countTokens("Hello World — 你好 🌍\nnext line")).toBe(11);
	});

	test("chunks normalized document text on exact token bounds", () => {
		const text = `${"e\u0301"} ${Array.from({ length: 1_500 }, (_, index) => `Sentence ${index}.`).join(" ")}`;
		const chunks = qwen3EmbeddingProfile.chunkDocument(text);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every(chunk => chunk.tokenCount <= qwen3EmbeddingProfile.documentChunkTokens)).toBe(true);
		expect(chunks.map(chunk => chunk.text).join("")).toBe(text.normalize("NFC"));
		expect(chunks.every(chunk => !chunk.text.includes("�"))).toBe(true);

		const denseUnicode = "🌍".repeat(1_500);
		const unicodeChunks = qwen3EmbeddingProfile.chunkDocument(denseUnicode);
		expect(unicodeChunks.map(chunk => chunk.text).join("")).toBe(denseUnicode);
		expect(unicodeChunks.every(chunk => chunk.tokenCount <= qwen3EmbeddingProfile.documentChunkTokens)).toBe(true);
		expect(unicodeChunks.every(chunk => !chunk.text.includes("�"))).toBe(true);
	});

	test("bounds passive-style queries from the recent tail", () => {
		const text = `${"old context ".repeat(2_000)}RECENT_DECISION_MARKER`;
		const prepared = qwen3EmbeddingProfile.prepareQuery(text, "tail");

		expect(prepared.truncated).toBe(true);
		expect(prepared.originalTokenCount).toBeGreaterThan(qwen3EmbeddingProfile.queryTokens);
		expect(prepared.tokenCount).toBeLessThanOrEqual(qwen3EmbeddingProfile.queryTokens);
		expect(prepared.text).toContain("RECENT_DECISION_MARKER");
	});
});
