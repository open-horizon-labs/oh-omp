/**
 * Defines lazy proxy properties on a wrapper so it forwards to the underlying tool.
 */
export function reserveOwnWritableProperties(target: object, source: object, keys: readonly PropertyKey[]): void {
	const record = source as Record<PropertyKey, unknown>;
	for (const key of keys) {
		if (record[key] === undefined || key in target) {
			continue;
		}
		Object.defineProperty(target, key, {
			value: undefined,
			writable: true,
			configurable: true,
			enumerable: true,
		});
	}
}

export function applyToolProxy<TTool extends object>(tool: TTool, wrapper: object): void {
	const visited = new Set<PropertyKey>();
	let current: object | null = tool;

	while (current && current !== Object.prototype) {
		for (const key of Reflect.ownKeys(current)) {
			if (key === "constructor" || visited.has(key) || key in wrapper) {
				continue;
			}
			visited.add(key);
			Object.defineProperty(wrapper, key, {
				get() {
					const value = (tool as Record<PropertyKey, unknown>)[key];
					return typeof value === "function" ? value.bind(tool) : value;
				},
				enumerable: true,
				configurable: true,
			});
		}
		current = Object.getPrototypeOf(current);
	}
}
