const DEVICE_FLOW_CANCEL_MESSAGE = "Login cancelled";
const DEVICE_FLOW_TIMEOUT_MESSAGE = "Device flow timed out";
const MINIMUM_DEVICE_FLOW_INTERVAL_MS = 1000;
const DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

export type OAuthDeviceCodePollResult<T> =
	| { status: "complete"; value: T }
	| { status: "pending" }
	| { status: "slow_down" };

export interface OAuthDeviceCodeFlowOptions<T> {
	poll(): OAuthDeviceCodePollResult<T> | Promise<OAuthDeviceCodePollResult<T>>;
	intervalSeconds?: number;
	expiresInSeconds?: number;
	signal?: AbortSignal;
}

async function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) {
		await Bun.sleep(ms);
		return;
	}
	if (signal.aborted) throw new Error(DEVICE_FLOW_CANCEL_MESSAGE);

	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let timer: Timer | undefined;
	const onAbort = () => {
		clearTimeout(timer);
		reject(new Error(DEVICE_FLOW_CANCEL_MESSAGE));
	};
	timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal.addEventListener("abort", onAbort, { once: true });
	await promise;
}

/** Poll an RFC 8628 device authorization flow until completion or expiry. */
export async function pollOAuthDeviceCodeFlow<T>(options: OAuthDeviceCodeFlowOptions<T>): Promise<T> {
	const deadline =
		typeof options.expiresInSeconds === "number"
			? Date.now() + options.expiresInSeconds * 1000
			: Number.POSITIVE_INFINITY;
	let intervalMs = Math.max(
		MINIMUM_DEVICE_FLOW_INTERVAL_MS,
		Math.floor((options.intervalSeconds ?? DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS) * 1000),
	);

	while (Date.now() < deadline) {
		if (options.signal?.aborted) throw new Error(DEVICE_FLOW_CANCEL_MESSAGE);
		const result = await options.poll();
		if (result.status === "complete") return result.value;
		if (result.status === "slow_down") intervalMs += SLOW_DOWN_INTERVAL_INCREMENT_MS;

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await abortableSleep(Math.min(intervalMs, remainingMs), options.signal);
	}

	throw new Error(DEVICE_FLOW_TIMEOUT_MESSAGE);
}
