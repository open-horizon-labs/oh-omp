import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthApiKey } from "../src/utils/oauth";
import type { OAuthCredentials } from "../src/utils/oauth/types";

const PROVIDER = "openai-codex";
const MINUTE_MS = 60 * 1000;

function unexpiredCredential(): OAuthCredentials {
	return {
		access: "access-r1",
		refresh: "refresh-r1",
		expires: Date.now() + 30 * MINUTE_MS,
		accountId: "account-force",
	};
}

describe("getOAuthApiKey force refresh", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("does not hit the token endpoint for an unexpired credential by default", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const result = await getOAuthApiKey(PROVIDER, { [PROVIDER]: unexpiredCredential() });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result?.newCredentials.refresh).toBe("refresh-r1");
	});

	test("hits the token endpoint for an unexpired credential when force is set", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: "header.e30.sig",
					refresh_token: "refresh-r2",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const result = await getOAuthApiKey(PROVIDER, { [PROVIDER]: unexpiredCredential() }, { force: true });

		expect(fetchSpy).toHaveBeenCalled();
		expect(result?.newCredentials.refresh).toBe("refresh-r2");
	});
});
