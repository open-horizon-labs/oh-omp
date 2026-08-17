import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage, type OAuthCredential } from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

const PROVIDER = "openai-codex";
const HOUR_MS = 60 * 60 * 1000;

function createExhaustedCredential(refresh: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${refresh}`,
		refresh,
		expires: Date.now() - 60_000,
		accountId: `account-${refresh}`,
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

describe("AuthStorage invalid_grant rotation-race recovery", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-invalid-grant-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await AuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
		});
		// The expired-credential prefetch calls refreshOAuthToken directly; rejecting it
		// keeps the in-memory credential stale so the attempt path drives the flow.
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(new Error("prefetch skipped"));
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

	test("recovers silently when another process already rotated the refresh token", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const stale = createExhaustedCredential("refresh-r1");
		await authStorage.set(PROVIDER, [stale]);

		// A second store handle models the canonical writer: it rotates and persists a
		// newer refresh token behind the first instance's stale in-memory cache.
		const canonicalStore = await AuthCredentialStore.open(dbPath);
		try {
			const row = canonicalStore.listAuthCredentials(PROVIDER)[0];
			if (!row) throw new Error("credential row missing");
			canonicalStore.updateAuthCredential(row.id, {
				...stale,
				access: "access-r2",
				refresh: "refresh-r2",
			});

			const getOAuthApiKeySpy = vi
				.spyOn(oauthUtils, "getOAuthApiKey")
				.mockImplementation(async (_provider, credentials) => {
					const credential = credentials[PROVIDER] as OAuthCredentials;
					if (credential.refresh === stale.refresh) {
						throw new Error(`Failed to refresh OAuth token for ${PROVIDER}: invalid_grant`);
					}
					const access = `access-from-${credential.refresh}`;
					return {
						apiKey: access,
						newCredentials: { ...credential, access, expires: Date.now() + HOUR_MS },
					};
				});

			const apiKey = await authStorage.getApiKey(PROVIDER, "session-rotation-race");

			expect(apiKey).toBe("access-from-refresh-r2");
			expect(getOAuthApiKeySpy).toHaveBeenCalledTimes(2);
			expect(readDisabledCauses(dbPath, PROVIDER)).toEqual([]);

			const stored = store.listAuthCredentials(PROVIDER);
			expect(stored).toHaveLength(1);
			expect((stored[0]?.credential as OAuthCredential).refresh).toBe("refresh-r2");
		} finally {
			canonicalStore.close();
		}
	});

	test("recovers when the first invalid_grant is spurious and the stored token is unchanged", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const stale = createExhaustedCredential("refresh-r1");
		await authStorage.set(PROVIDER, [stale]);

		let attempts = 0;
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			attempts++;
			if (attempts === 1) {
				throw new Error(`Failed to refresh OAuth token for ${PROVIDER}: invalid_grant`);
			}
			const credential = credentials[PROVIDER] as OAuthCredentials;
			const access = "access-recovered";
			return {
				apiKey: access,
				newCredentials: { ...credential, access, expires: Date.now() + HOUR_MS },
			};
		});

		const apiKey = await authStorage.getApiKey(PROVIDER, "session-spurious");

		expect(apiKey).toBe("access-recovered");
		expect(attempts).toBe(2);
		expect(readDisabledCauses(dbPath, PROVIDER)).toEqual([]);
	});

	test("disables a genuine dead grant when the fresh-store retry also fails", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set(PROVIDER, [createExhaustedCredential("refresh-r1")]);

		const getOAuthApiKeySpy = vi
			.spyOn(oauthUtils, "getOAuthApiKey")
			.mockRejectedValue(new Error(`Failed to refresh OAuth token for ${PROVIDER}: invalid_grant`));

		const apiKey = await authStorage.getApiKey(PROVIDER, "session-dead-grant");

		expect(apiKey).toBeUndefined();
		expect(getOAuthApiKeySpy).toHaveBeenCalledTimes(2);
		const causes = readDisabledCauses(dbPath, PROVIDER);
		expect(causes).toHaveLength(1);
		expect(causes[0]).toContain("invalid_grant");
	});

	test("keeps existing behavior for non-invalid_grant failures", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const stale = createExhaustedCredential("refresh-r1");
		await authStorage.set(PROVIDER, [stale]);

		// A newer token sits in the store; a transient failure must not trigger the
		// store-reload retry that invalid_grant does, so it is never adopted here.
		const canonicalStore = await AuthCredentialStore.open(dbPath);
		try {
			const row = canonicalStore.listAuthCredentials(PROVIDER)[0];
			if (!row) throw new Error("credential row missing");
			canonicalStore.updateAuthCredential(row.id, { ...stale, refresh: "refresh-r2" });

			vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
				const credential = credentials[PROVIDER] as OAuthCredentials;
				if (credential.refresh === "refresh-r2") {
					return { apiKey: "access-r2", newCredentials: credential };
				}
				throw new Error("fetch failed: network unreachable");
			});

			const apiKey = await authStorage.getApiKey(PROVIDER, "session-transient");

			// The blocked fallback re-attempt reuses the stale credential and fails again:
			// no silent recovery and no permanent disable.
			expect(apiKey).toBeUndefined();
			expect(readDisabledCauses(dbPath, PROVIDER)).toEqual([]);
		} finally {
			canonicalStore.close();
		}
	});
});
