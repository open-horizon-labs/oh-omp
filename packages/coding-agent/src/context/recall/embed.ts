import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { EMBEDDING_DIM } from "./types";

const MEMEX_EMBED_URL = "https://memex-embed.ohlabs.ai/v1/embeddings";
const MEMEX_MODEL = "qwen3-embedding-4b";

interface EmbedResponseItem {
	embedding: number[];
}

interface EmbedResponse {
	data: EmbedResponseItem[];
}

export async function resolveMemexLicense(): Promise<string> {
	const envLicense = process.env.MEMEX_LICENSE;
	if (envLicense) return envLicense;

	const licensePath = path.join(os.homedir(), ".config", "memex", "license");
	try {
		const content = await Bun.file(licensePath).text();
		const trimmed = content.trim();
		if (trimmed) return trimmed;
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	throw new Error("Memex license not found. Set MEMEX_LICENSE env var or create ~/.config/memex/license");
}

export async function embed(texts: string[], license: string): Promise<Float32Array[]> {
	if (texts.length === 0) return [];

	logger.debug("Requesting embeddings", { count: texts.length });

	const res = await fetch(MEMEX_EMBED_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${license}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ input: texts, model: MEMEX_MODEL }),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "<unreadable>");
		throw new Error(`Memex embed request failed (${res.status}): ${body.slice(0, 200)}`);
	}

	const json = (await res.json()) as EmbedResponse;

	if (!json.data || !Array.isArray(json.data)) {
		throw new Error("Memex embed response missing 'data' array");
	}

	if (json.data.length !== texts.length) {
		throw new Error(`Memex embed returned ${json.data.length} embeddings, expected ${texts.length}`);
	}

	return json.data.map((item, i) => {
		if (item.embedding.length !== EMBEDDING_DIM) {
			throw new Error(`Embedding ${i} has dimension ${item.embedding.length}, expected ${EMBEDDING_DIM}`);
		}
		return new Float32Array(item.embedding);
	});
}
