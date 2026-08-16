import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { AuthCredentialStore, AuthStorage, type OAuthCredential } from "../src/auth-storage";
import { deleteModelCache, readModelCache, writeModelCache } from "../src/model-cache";
import * as oauthModule from "../src/utils/oauth";
import * as anthropicModule from "../src/utils/oauth/anthropic";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY"] as const;

const CACHE_TTL_MS = 60_000;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function oauthCredential(args: { access: string; expires: number; email: string }): OAuthCredential {
	return {
		type: "oauth",
		refresh: `refresh-${args.access}`,
		access: args.access,
		expires: args.expires,
		email: args.email,
	};
}

describe("AuthStorage.peekApiKey OAuth expiry handling", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
	let refreshSpy: Mock<typeof oauthModule.refreshOAuthToken>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-storage-peek-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await AuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		refreshSpy = vi.spyOn(oauthModule, "refreshOAuthToken");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		savedEnv = {};
		store?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("returns the unexpired sibling token when the selected OAuth credential is expired", async () => {
		// Round-robin selection starts at index 0, so the expired credential is
		// the one peekApiKey would have returned before the sibling walk.
		const expired = oauthCredential({
			access: "expired-token",
			expires: Date.now() - 60_000,
			email: "expired@example.com",
		});
		const valid = oauthCredential({
			access: "valid-token",
			expires: Date.now() + 3_600_000,
			email: "valid@example.com",
		});
		await authStorage!.set("anthropic", [expired, valid]);

		await expect(authStorage!.peekApiKey("anthropic")).resolves.toBe("valid-token");
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("returns undefined when every OAuth credential is expired and no env or fallback key exists", async () => {
		const first = oauthCredential({
			access: "expired-token-1",
			expires: Date.now() - 60_000,
			email: "first@example.com",
		});
		const second = oauthCredential({
			access: "expired-token-2",
			expires: Date.now() - 1_000,
			email: "second@example.com",
		});
		await authStorage!.set("anthropic", [first, second]);

		await expect(authStorage!.peekApiKey("anthropic")).resolves.toBeUndefined();
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("returns the access token of a single unexpired OAuth credential", async () => {
		const valid = oauthCredential({
			access: "only-valid-token",
			expires: Date.now() + 3_600_000,
			email: "only@example.com",
		});
		await authStorage!.set("anthropic", [valid]);

		await expect(authStorage!.peekApiKey("anthropic")).resolves.toBe("only-valid-token");
		expect(refreshSpy).not.toHaveBeenCalled();
	});
});

describe("AuthStorage login/logout model cache invalidation", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let loginAnthropicSpy: Mock<typeof anthropicModule.loginAnthropic>;

	const controller = {
		onAuth: () => {},
		onPrompt: async () => "",
	};

	const readCache = (providerId: string) => readModelCache(providerId, CACHE_TTL_MS, () => Date.now());

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-storage-cache-"));
		setAgentDir(tempDir);
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		loginAnthropicSpy = vi.spyOn(anthropicModule, "loginAnthropic");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		store?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("successful login deletes only that provider's model cache row", async () => {
		loginAnthropicSpy.mockResolvedValue({
			access: "fresh-anthropic-token",
			refresh: "fresh-anthropic-refresh",
			expires: Date.now() + 3_600_000,
			email: "fresh@example.com",
		});
		writeModelCache("anthropic", Date.now(), [], false);
		writeModelCache("openai-codex", Date.now(), [], false);
		expect(readCache("anthropic")).not.toBeNull();
		expect(readCache("openai-codex")).not.toBeNull();

		await authStorage!.login("anthropic", controller);

		expect(readCache("anthropic")).toBeNull();
		expect(readCache("openai-codex")).not.toBeNull();
		expect(store!.listAuthCredentials("anthropic")).toHaveLength(1);
	});

	it("logout deletes only that provider's model cache row", async () => {
		await authStorage!.set(
			"anthropic",
			oauthCredential({
				access: "anthropic-token",
				expires: Date.now() + 3_600_000,
				email: "anthropic@example.com",
			}),
		);
		await authStorage!.set(
			"openai-codex",
			oauthCredential({
				access: "codex-token",
				expires: Date.now() + 3_600_000,
				email: "codex@example.com",
			}),
		);
		writeModelCache("anthropic", Date.now(), [], false);
		writeModelCache("openai-codex", Date.now(), [], false);

		await authStorage!.logout("anthropic");

		expect(readCache("anthropic")).toBeNull();
		expect(readCache("openai-codex")).not.toBeNull();
	});

	it("remove deletes only that provider's model cache row", async () => {
		await authStorage!.set(
			"anthropic",
			oauthCredential({
				access: "anthropic-token",
				expires: Date.now() + 3_600_000,
				email: "anthropic@example.com",
			}),
		);
		writeModelCache("anthropic", Date.now(), [], false);
		writeModelCache("openai-codex", Date.now(), [], false);

		await authStorage!.remove("anthropic");

		expect(readCache("anthropic")).toBeNull();
		expect(readCache("openai-codex")).not.toBeNull();
	});

	it("login still succeeds when the model cache row cannot be deleted", async () => {
		loginAnthropicSpy.mockResolvedValue({
			access: "fresh-anthropic-token",
			refresh: "fresh-anthropic-refresh",
			expires: Date.now() + 3_600_000,
			email: "fresh@example.com",
		});
		// A directory where models.db would live makes the cache delete fail;
		// the failure must be swallowed, not surfaced by login().
		await fs.mkdir(path.join(tempDir, "models.db"));

		await authStorage!.login("anthropic", controller);

		expect(store!.listAuthCredentials("anthropic")).toHaveLength(1);
	});
});

describe("deleteModelCache failure containment", () => {
	it("never throws when the cache database cannot be opened", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-cache-blocked-"));
		try {
			const notADatabase = path.join(tempDir, "models.db");
			await fs.mkdir(notADatabase);
			expect(() => deleteModelCache("anthropic", notADatabase)).not.toThrow();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
