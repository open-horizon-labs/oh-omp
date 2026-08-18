import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage, type OAuthCredential } from "../src/auth-storage";

const PROVIDER = "openai-codex";
const MINUTE_MS = 60 * 1000;

function createCredential(args: { refresh: string; expires: number }): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${args.refresh}`,
		refresh: args.refresh,
		expires: args.expires,
		accountId: "account-lease",
	};
}

function tokenResponse(refresh: string, expiresIn = 3600): Response {
	return new Response(
		JSON.stringify({
			access_token: "header.e30.sig",
			refresh_token: refresh,
			expires_in: expiresIn,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("AuthStorage cross-process refresh lease", () => {
	let tempDir = "";
	let dbPath = "";
	let storeA: AuthCredentialStore | null = null;
	let storeB: AuthCredentialStore | null = null;
	let storeC: AuthCredentialStore | null = null;
	let storageA: AuthStorage | null = null;
	let storageB: AuthStorage | null = null;
	let storageC: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-lease-"));
		dbPath = path.join(tempDir, "agent.db");
		storeA = await AuthCredentialStore.open(dbPath);
		storeB = await AuthCredentialStore.open(dbPath);
		storeC = await AuthCredentialStore.open(dbPath);
		storageA = new AuthStorage(storeA, { usageProviderResolver: () => undefined });
		storageB = new AuthStorage(storeB, { usageProviderResolver: () => undefined });
		storageC = new AuthStorage(storeC, { usageProviderResolver: () => undefined });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storeA?.close();
		storeB?.close();
		storeC?.close();
		storeA = null;
		storeB = null;
		storeC = null;
		storageA = null;
		storageB = null;
		storageC = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("two concurrent refreshers produce one token-endpoint call and both observe the rotation", async () => {
		if (!storageA || !storageB || !storeA || !storeB) throw new Error("test setup failed");

		const expires = Date.now() + 5 * MINUTE_MS;
		await storageA.set(PROVIDER, [createCredential({ refresh: "refresh-r1", expires })]);

		let calls = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
			calls += 1;
			await Bun.sleep(80);
			return tokenResponse("refresh-r2");
		}) as unknown as typeof fetch);

		const [outcomesA, outcomesB] = await Promise.all([
			storageA.refreshExpiring({ provider: PROVIDER, expiringWithinMs: 10 * MINUTE_MS }),
			storageB.refreshExpiring({ provider: PROVIDER, expiringWithinMs: 10 * MINUTE_MS }),
		]);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(calls).toBe(1);
		expect(outcomesA[0]?.status).toBe("rotated");
		expect(outcomesB[0]?.status).toBe("rotated");

		const storedA = storeA.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		const storedB = storeB.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		expect(storedA.refresh).toBe("refresh-r2");
		expect(storedB.refresh).toBe("refresh-r2");
	});

	test("an expired lease does not deadlock refresh", async () => {
		if (!storageA || !storeA) throw new Error("test setup failed");

		const expires = Date.now() + 5 * MINUTE_MS;
		await storageA.set(PROVIDER, [createCredential({ refresh: "refresh-r1", expires })]);
		const row = storeA.listAuthCredentials(PROVIDER)[0];
		if (!row) throw new Error("missing credential");

		const db = new Database(dbPath);
		try {
			db.prepare("INSERT INTO auth_refresh_leases (credential_id, holder, expires_at) VALUES (?, ?, ?)").run(
				row.id,
				"dead-holder",
				Date.now() - 1_000,
			);
		} finally {
			db.close();
		}

		vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse("refresh-r2"));

		const outcomes = await storageA.refreshExpiring({
			provider: PROVIDER,
			expiringWithinMs: 10 * MINUTE_MS,
		});

		expect(outcomes[0]?.status).toBe("rotated");
		const stored = storeA.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		expect(stored.refresh).toBe("refresh-r2");
	});

	test("a live lease from a dead holder expires and the waiter takes over", async () => {
		if (!storageA || !storeA) throw new Error("test setup failed");

		const expires = Date.now() + 5 * MINUTE_MS;
		await storageA.set(PROVIDER, [createCredential({ refresh: "refresh-r1", expires })]);
		const row = storeA.listAuthCredentials(PROVIDER)[0];
		if (!row) throw new Error("missing credential");

		const db = new Database(dbPath);
		try {
			db.prepare("INSERT INTO auth_refresh_leases (credential_id, holder, expires_at) VALUES (?, ?, ?)").run(
				row.id,
				"dead-holder",
				Date.now() + 150,
			);
		} finally {
			db.close();
		}

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse("refresh-r2"));

		const outcomes = await storageA.refreshExpiring({
			provider: PROVIDER,
			expiringWithinMs: 10 * MINUTE_MS,
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(outcomes[0]?.status).toBe("rotated");
		const stored = storeA.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		expect(stored.refresh).toBe("refresh-r2");
	});

	test("a failed holder does not stampede leftover waiters into an unleased refresh", async () => {
		if (!storageA || !storageB || !storageC || !storeA) throw new Error("test setup failed");

		const expires = Date.now() + 5 * MINUTE_MS;
		await storageA.set(PROVIDER, [createCredential({ refresh: "refresh-r1", expires })]);

		let calls = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
			calls += 1;
			await Bun.sleep(80);
			if (calls === 1) return new Response("upstream unavailable", { status: 503 });
			return tokenResponse("refresh-r2");
		}) as unknown as typeof fetch);

		const [outcomesA, outcomesB, outcomesC] = await Promise.all([
			storageA.refreshExpiring({ provider: PROVIDER, expiringWithinMs: 10 * MINUTE_MS }),
			storageB.refreshExpiring({ provider: PROVIDER, expiringWithinMs: 10 * MINUTE_MS }),
			storageC.refreshExpiring({ provider: PROVIDER, expiringWithinMs: 10 * MINUTE_MS }),
		]);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(calls).toBe(2);
		const statuses = [outcomesA[0]?.status, outcomesB[0]?.status, outcomesC[0]?.status];
		expect(statuses.filter(status => status === "rotated")).toHaveLength(2);
		expect(statuses.filter(status => status === "failed")).toHaveLength(1);
		const stored = storeA.listAuthCredentials(PROVIDER)[0]?.credential as OAuthCredential;
		expect(stored.refresh).toBe("refresh-r2");
	});
});
