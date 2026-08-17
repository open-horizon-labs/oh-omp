import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage, type OAuthCredential } from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

const PROVIDER = "openai-codex";
const MINUTE_MS = 60 * 1000;

function createCredential(args: { refresh: string; expires: number; obtainedAt?: number }): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${args.refresh}`,
		refresh: args.refresh,
		expires: args.expires,
		obtainedAt: args.obtainedAt,
		accountId: "account-proactive",
	};
}

function readDisabledCauses(dbPath: string, provider: string): string[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.prepare(
				"SELECT disabled_cause FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
			)
			.all(provider) as Array<{ disabled_cause?: string | null }>;
		return rows.flatMap(row => (typeof row.disabled_cause === "string" ? [row.disabled_cause] : []));
	} finally {
		db.close();
	}
}

describe("AuthStorage.refreshExpiring", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-proactive-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await AuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("rotates and persists a credential expiring within an explicit window", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() + 5 * MINUTE_MS;
		await authStorage.set(PROVIDER, [createCredential({ refresh: "refresh-r1", expires })]);
		const newExpires = Date.now() + 60 * MINUTE_MS;
		const getOAuthApiKeySpy = vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => ({
			apiKey: "access-r2",
			newCredentials: {
				access: "access-r2",
				refresh: "refresh-r2",
				expires: newExpires,
				accountId: "account-proactive",
			} satisfies OAuthCredentials,
		}));

		const outcomes = await authStorage.refreshExpiring({
			provider: PROVIDER,
			expiringWithinMs: 10 * MINUTE_MS,
		});

		expect(outcomes).toEqual([{ provider: PROVIDER, index: 0, status: "rotated", expires: newExpires }]);
		expect(getOAuthApiKeySpy).toHaveBeenCalledTimes(1);

		const stored = store.listAuthCredentials(PROVIDER);
		expect(stored).toHaveLength(1);
		const credential = stored[0]?.credential as OAuthCredential;
		expect(credential.refresh).toBe("refresh-r2");
		expect(credential.access).toBe("access-r2");
		expect(credential.obtainedAt).toBeGreaterThan(0);
	});

	test("leaves credentials outside the window untouched without a provider call", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() + 50 * MINUTE_MS;
		await authStorage.set(PROVIDER, [createCredential({ refresh: "refresh-r1", expires })]);
		const getOAuthApiKeySpy = vi.spyOn(oauthUtils, "getOAuthApiKey");

		const outcomes = await authStorage.refreshExpiring({
			provider: PROVIDER,
			expiringWithinMs: 10 * MINUTE_MS,
		});

		expect(outcomes).toEqual([{ provider: PROVIDER, index: 0, status: "fresh", expires }]);
		expect(getOAuthApiKeySpy).not.toHaveBeenCalled();
		const credential = store.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		expect(credential.refresh).toBe("refresh-r1");
	});

	test("default window rotates at ~20% of the token TTL", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// 6 minutes remain of a 60-minute TTL: within the 12-minute (20%) window.
		const now = Date.now();
		await authStorage.set(PROVIDER, [
			createCredential({
				refresh: "refresh-r1",
				expires: now + 6 * MINUTE_MS,
				obtainedAt: now - 54 * MINUTE_MS,
			}),
		]);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => ({
			apiKey: "access-r2",
			newCredentials: {
				access: "access-r2",
				refresh: "refresh-r2",
				expires: now + 60 * MINUTE_MS,
				accountId: "account-proactive",
			} satisfies OAuthCredentials,
		}));

		const outcomes = await authStorage.refreshExpiring({ provider: PROVIDER });

		expect(outcomes[0]?.status).toBe("rotated");
		expect((store.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential).refresh).toBe("refresh-r2");
	});

	test("default window leaves a token with most of its TTL untouched", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const now = Date.now();
		await authStorage.set(PROVIDER, [
			createCredential({
				refresh: "refresh-r1",
				expires: now + 50 * MINUTE_MS,
				obtainedAt: now - 10 * MINUTE_MS,
			}),
		]);
		const getOAuthApiKeySpy = vi.spyOn(oauthUtils, "getOAuthApiKey");

		const outcomes = await authStorage.refreshExpiring({ provider: PROVIDER });

		expect(outcomes[0]?.status).toBe("fresh");
		expect(getOAuthApiKeySpy).not.toHaveBeenCalled();
	});

	test("falls back to a 12-minute window when obtainedAt is missing", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// Pre-existing credential without obtainedAt bookkeeping.
		await authStorage.set(PROVIDER, [
			createCredential({ refresh: "refresh-r1", expires: Date.now() + 6 * MINUTE_MS }),
		]);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => ({
			apiKey: "access-r2",
			newCredentials: {
				access: "access-r2",
				refresh: "refresh-r2",
				expires: Date.now() + 60 * MINUTE_MS,
				accountId: "account-proactive",
			} satisfies OAuthCredentials,
		}));

		const outcomes = await authStorage.refreshExpiring({ provider: PROVIDER });

		expect(outcomes[0]?.status).toBe("rotated");
		expect((store.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential).refresh).toBe("refresh-r2");
	});

	test("records a failed refresh without disabling or mutating the credential", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set(PROVIDER, [
			createCredential({ refresh: "refresh-r1", expires: Date.now() + 5 * MINUTE_MS }),
		]);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockRejectedValue(new Error("fetch failed: network unreachable"));

		const outcomes = await authStorage.refreshExpiring({
			provider: PROVIDER,
			expiringWithinMs: 10 * MINUTE_MS,
		});

		expect(outcomes[0]?.status).toBe("failed");
		expect(outcomes[0]?.error).toContain("network unreachable");
		expect(readDisabledCauses(dbPath, PROVIDER)).toEqual([]);
		const credential = store.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		expect(credential.refresh).toBe("refresh-r1");
	});

	test("does not disable on invalid_grant — the reactive path owns that decision", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set(PROVIDER, [
			createCredential({ refresh: "refresh-r1", expires: Date.now() + 5 * MINUTE_MS }),
		]);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockRejectedValue(
			new Error(`Failed to refresh OAuth token for ${PROVIDER}: invalid_grant`),
		);

		const outcomes = await authStorage.refreshExpiring({
			provider: PROVIDER,
			expiringWithinMs: 10 * MINUTE_MS,
		});

		// One initial attempt plus the store-reload retry (#101 semantics), then failure.
		expect(outcomes[0]?.status).toBe("failed");
		expect(readDisabledCauses(dbPath, PROVIDER)).toEqual([]);
		const credential = store.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		expect(credential.refresh).toBe("refresh-r1");
	});

	test("reloads the store first, so a credential rotated by another process is not rotated again", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		// In-memory state is stale: the other process rotated and persisted a long-lived token.
		await authStorage.set(PROVIDER, [
			createCredential({ refresh: "refresh-r1", expires: Date.now() + 5 * MINUTE_MS }),
		]);
		const canonicalStore = await AuthCredentialStore.open(dbPath);
		try {
			const row = canonicalStore.listAuthCredentials(PROVIDER)[0];
			if (!row) throw new Error("credential row missing");
			const now = Date.now();
			canonicalStore.updateAuthCredential(
				row.id,
				createCredential({ refresh: "refresh-r2", expires: now + 55 * MINUTE_MS, obtainedAt: now }),
			);
		} finally {
			canonicalStore.close();
		}
		const getOAuthApiKeySpy = vi.spyOn(oauthUtils, "getOAuthApiKey");

		const outcomes = await authStorage.refreshExpiring({
			provider: PROVIDER,
			expiringWithinMs: 10 * MINUTE_MS,
		});

		expect(outcomes[0]?.status).toBe("fresh");
		expect(getOAuthApiKeySpy).not.toHaveBeenCalled();
		const credential = store.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		expect(credential.refresh).toBe("refresh-r2");
	});

	test("forces a token-endpoint call for an unexpired in-window credential", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() + 5 * MINUTE_MS;
		await authStorage.set(PROVIDER, [createCredential({ refresh: "refresh-r1", expires })]);

		const newExpiresIn = 3600;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: "header.e30.sig",
					refresh_token: "refresh-r2",
					expires_in: newExpiresIn,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const before = Date.now();
		const outcomes = await authStorage.refreshExpiring({
			provider: PROVIDER,
			expiringWithinMs: 10 * MINUTE_MS,
		});

		expect(fetchSpy).toHaveBeenCalled();
		expect(outcomes[0]?.status).toBe("rotated");
		const credential = store.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		expect(credential.refresh).toBe("refresh-r2");
		expect(credential.expires).toBeGreaterThanOrEqual(before + newExpiresIn * 1000);
		expect(credential.obtainedAt).toBeGreaterThanOrEqual(before);
	});

	test("reports fresh and leaves obtainedAt alone when the token endpoint returns the same credential", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const expires = Date.now() + 5 * MINUTE_MS;
		await authStorage.set(PROVIDER, [createCredential({ refresh: "refresh-r1", expires })]);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const current = credentials[PROVIDER];
			if (!current) throw new Error("missing credential");
			return { apiKey: current.access, newCredentials: current };
		});

		const outcomes = await authStorage.refreshExpiring({
			provider: PROVIDER,
			expiringWithinMs: 10 * MINUTE_MS,
		});

		expect(outcomes[0]?.status).toBe("fresh");
		const credential = store.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		expect(credential.refresh).toBe("refresh-r1");
		expect(credential.expires).toBe(expires);
		expect(credential.obtainedAt).toBeUndefined();
	});
});
