// Device authorization and token refresh adapted from NousResearch/hermes-agent (MIT)
// through the original upstream oh-my-pi release.

import { type OAuthDeviceCodePollResult, pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController, OAuthCredentials } from "./types";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

interface XAIOAuthDiscovery {
	tokenEndpoint: string;
}

interface XAIDeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Pin discovered OAuth endpoints to HTTPS x.ai hosts. */
export function validateXAIEndpoint(url: string, field: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid xAI ${field}: ${url}`);
	}
	const host = parsed.hostname.toLowerCase();
	if (parsed.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new Error(`Invalid xAI ${field}: ${url}`);
	}
	return url;
}

async function discoverXAIOAuth(): Promise<XAIOAuthDiscovery> {
	let response: Response;
	try {
		response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`xAI OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`xAI OIDC discovery returned status ${response.status}.`);

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`xAI OIDC discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const tokenEndpoint =
		isRecord(payload) && typeof payload.token_endpoint === "string" ? payload.token_endpoint.trim() : "";
	if (!tokenEndpoint) throw new Error("xAI OIDC discovery response was missing token_endpoint.");
	return { tokenEndpoint: validateXAIEndpoint(tokenEndpoint, "token_endpoint") };
}

function parseDeviceAuthorization(payload: unknown): XAIDeviceAuthorization {
	if (!isRecord(payload)) throw new Error("xAI device-code response was not a JSON object.");
	const deviceCode = typeof payload.device_code === "string" ? payload.device_code.trim() : "";
	const userCode = typeof payload.user_code === "string" ? payload.user_code.trim() : "";
	const verificationUri = typeof payload.verification_uri === "string" ? payload.verification_uri.trim() : "";
	const verificationUriComplete =
		typeof payload.verification_uri_complete === "string" ? payload.verification_uri_complete.trim() : "";
	const expiresInSeconds = payload.expires_in;
	const intervalSeconds = payload.interval;
	if (
		!deviceCode ||
		!userCode ||
		!verificationUri ||
		!verificationUriComplete ||
		typeof expiresInSeconds !== "number" ||
		!Number.isFinite(expiresInSeconds) ||
		expiresInSeconds <= 0 ||
		typeof intervalSeconds !== "number" ||
		!Number.isFinite(intervalSeconds) ||
		intervalSeconds <= 0
	) {
		throw new Error("xAI device-code response missing or invalid required fields.");
	}
	validateXAIEndpoint(verificationUri, "verification_uri");
	validateXAIEndpoint(verificationUriComplete, "verification_uri_complete");
	return { deviceCode, userCode, verificationUriComplete, expiresInSeconds, intervalSeconds };
}

function parseTokenResponse(payload: unknown, label: string, refreshFallback?: string): OAuthCredentials {
	if (!isRecord(payload)) throw new Error(`${label} was not a JSON object`);
	const access = typeof payload.access_token === "string" ? payload.access_token : "";
	const refresh =
		typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : refreshFallback;
	const expiresIn = payload.expires_in;
	if (!access) throw new Error(`${label} missing access_token`);
	if (!refresh) throw new Error(`${label} missing refresh_token`);
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) throw new Error(`${label} missing expires_in`);
	return { access, refresh, expires: Date.now() + expiresIn * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS };
}

async function requestDeviceAuthorization(signal: AbortSignal | undefined): Promise<XAIDeviceAuthorization> {
	const response = await fetch(XAI_OAUTH_DEVICE_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }),
		redirect: "error",
		signal: requestSignal(signal, TOKEN_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const detail = (await response.text()).trim();
		throw new Error(`xAI device-code request failed: ${response.status}${detail ? ` ${detail}` : ""}`);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`xAI device-code response returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseDeviceAuthorization(payload);
}

async function pollDeviceToken(
	tokenEndpoint: string,
	deviceCode: string,
	signal: AbortSignal | undefined,
): Promise<OAuthDeviceCodePollResult<OAuthCredentials>> {
	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: XAI_OAUTH_CLIENT_ID,
			device_code: deviceCode,
		}),
		redirect: "error",
		signal: requestSignal(signal, TOKEN_REQUEST_TIMEOUT_MS),
	});
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`xAI device-code token polling returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (response.ok) return { status: "complete", value: parseTokenResponse(payload, "xAI device-code token response") };
	if (!isRecord(payload)) throw new Error(`xAI device-code token polling failed: ${response.status}`);
	const code = typeof payload.error === "string" ? payload.error : "";
	if (code === "authorization_pending") return { status: "pending" };
	if (code === "slow_down") return { status: "slow_down" };
	const description = typeof payload.error_description === "string" ? payload.error_description : "";
	throw new Error(`xAI device-code token polling failed: ${description || code || response.status}`);
}

export async function loginXAIOAuth(ctrl: OAuthController): Promise<OAuthCredentials> {
	const discovery = await discoverXAIOAuth();
	const device = await requestDeviceAuthorization(ctrl.signal);
	ctrl.onAuth?.({ url: device.verificationUriComplete, instructions: `Enter code: ${device.userCode}` });
	ctrl.onProgress?.("Waiting for xAI device authorization...");
	return pollOAuthDeviceCodeFlow({
		poll: () => pollDeviceToken(discovery.tokenEndpoint, device.deviceCode, ctrl.signal),
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal: ctrl.signal,
	});
}

export async function refreshXAIOAuthToken(refreshToken: string): Promise<OAuthCredentials> {
	if (!refreshToken.trim()) throw new Error("missing refresh_token");
	const { tokenEndpoint } = await discoverXAIOAuth();
	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: XAI_OAUTH_CLIENT_ID,
			refresh_token: refreshToken,
		}),
		redirect: "error",
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const detail = (await response.text()).trim();
		throw new Error(`xAI token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`xAI token refresh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseTokenResponse(payload, "xAI token refresh response", refreshToken);
}
