type JSONPrimitive = null | boolean | number | string;
type JSONObject = { [key: string]: JSONValue };
type JSONValue = JSONPrimitive | JSONValue[] | JSONObject;

export interface ProjectionSnapshot {
	version: 1;
	projectionId: string;
	revision: number;
	view: {
		kind: "isolated-html";
		html: string;
		css?: string;
		js?: string;
	};
	state?: JSONValue;
	operations: Array<{
		id: string;
		label: string;
	}>;
}

export interface ProjectionIntervention {
	version: 1;
	projectionId: string;
	observedRevision: number;
	operationId: string;
	input?: JSONValue;
	idempotencyKey: string;
}

const MAX_JSON_DEPTH = 32;
const MAX_PROJECTION_ID_BYTES = 128;
const MAX_OPERATION_ID_BYTES = 64;
const MAX_LABEL_BYTES = 128;
const MAX_HTML_BYTES = 96 * 1024;
const MAX_CSS_BYTES = 48 * 1024;
const MAX_JS_BYTES = 96 * 1024;
const MAX_STATE_BYTES = 32 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_OPERATIONS = 16;

const textEncoder = new TextEncoder();

function invalid(message: string): never {
	throw new Error(`Invalid projection ${message}`);
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!isObject(value) || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function readRecordProperties(value: unknown, label: string, allowed?: ReadonlySet<string>): Map<string, unknown> {
	if (!isPlainRecord(value)) invalid(`${label} must be a plain object`);

	const properties = new Map<string, unknown>();
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") invalid(`${label} contains a symbol property`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor)) {
			invalid(`${label}.${key} must be a data property`);
		}
		if (!descriptor.enumerable) invalid(`${label}.${key} must be enumerable`);
		if (allowed !== undefined && !allowed.has(key)) invalid(`${label}.${key} is not recognized`);
		properties.set(key, descriptor.value);
	}
	return properties;
}

function requireProperty(properties: ReadonlyMap<string, unknown>, key: string, label: string): unknown {
	if (!properties.has(key)) invalid(`${label}.${key} is required`);
	return properties.get(key);
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function utf8ByteLength(value: string, label: string): number {
	if (hasUnpairedSurrogate(value)) invalid(`${label} is not valid UTF-8 text`);
	return textEncoder.encode(value).byteLength;
}

function requireBoundedString(value: unknown, label: string, maxBytes: number, allowEmpty = true): string {
	if (typeof value !== "string") invalid(`${label} must be a string`);
	const byteLength = utf8ByteLength(value, label);
	if ((!allowEmpty && byteLength === 0) || byteLength > maxBytes) {
		invalid(`${label} must be ${allowEmpty ? "at most" : "between 1 and"} ${maxBytes} UTF-8 bytes`);
	}
	return value;
}

function requireIdentifier(value: unknown, label: string, maxBytes: number): string {
	return requireBoundedString(value, label, maxBytes, false);
}

function requireRevision(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		invalid(`${label} must be a positive safe integer`);
	}
	return value;
}

function serializedByteLength(value: JSONValue | ProjectionSnapshot | ProjectionIntervention): number {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) invalid("contains a value that cannot be serialized as JSON");
	return textEncoder.encode(serialized).byteLength;
}

interface JsonBudget {
	used: number;
	limit: number;
}

function reserve(budget: JsonBudget, bytes: number): void {
	budget.used += bytes;
	if (budget.used > budget.limit) invalid("JSON content exceeds its byte limit");
}

function serializedPrimitiveBytes(value: null | boolean | number | string): number {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) invalid("contains a value that cannot be serialized as JSON");
	return textEncoder.encode(serialized).byteLength;
}

function readArrayValues(value: unknown, label: string, maxLength: number): unknown[] {
	if (!Array.isArray(value)) invalid(`${label} must be an array`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Array.prototype && prototype !== null) invalid(`${label} must be a plain array`);

	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (
		lengthDescriptor === undefined ||
		!("value" in lengthDescriptor) ||
		lengthDescriptor.enumerable ||
		typeof lengthDescriptor.value !== "number" ||
		!Number.isSafeInteger(lengthDescriptor.value) ||
		lengthDescriptor.value < 0 ||
		lengthDescriptor.value > maxLength
	) {
		invalid(`${label} has an invalid length`);
	}
	const length = lengthDescriptor.value;
	const values = new Array<unknown>(length);
	const seenIndexes = new Set<number>();

	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") invalid(`${label} contains a symbol property`);
		if (key === "length") continue;
		const index = Number(key);
		if (
			!Number.isSafeInteger(index) ||
			index < 0 ||
			index >= 2 ** 32 - 1 ||
			String(index) !== key ||
			index >= length
		) {
			invalid(`${label} contains a non-index property`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
			invalid(`${label}[${index}] must be an enumerable data property`);
		}
		seenIndexes.add(index);
		values[index] = descriptor.value;
	}

	if (seenIndexes.size !== length) invalid(`${label} must not contain holes`);
	return values;
}

function cloneJson(value: unknown, depth: number, active: WeakSet<object>, budget: JsonBudget): JSONValue {
	if (value === null) {
		reserve(budget, serializedPrimitiveBytes(null));
		return null;
	}
	if (typeof value === "boolean") {
		reserve(budget, serializedPrimitiveBytes(value));
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalid("JSON numbers must be finite");
		reserve(budget, serializedPrimitiveBytes(value));
		return value;
	}
	if (typeof value === "string") {
		utf8ByteLength(value, "JSON string");
		reserve(budget, serializedPrimitiveBytes(value));
		return value;
	}
	if (!isObject(value)) invalid("JSON content contains a non-JSON value");
	if (depth > MAX_JSON_DEPTH) invalid("JSON content is too deeply nested");
	if (active.has(value)) invalid("JSON content contains a cycle");
	active.add(value);

	try {
		if (Array.isArray(value)) {
			const values = readArrayValues(value, "JSON array", budget.limit);
			reserve(budget, 1);
			const cloned: JSONValue[] = [];
			for (let index = 0; index < values.length; index++) {
				if (index > 0) reserve(budget, 1);
				cloned.push(cloneJson(values[index], depth + 1, active, budget));
			}
			reserve(budget, 1);
			return cloned;
		}

		const properties = readRecordProperties(value, "JSON object");
		reserve(budget, 1);
		const cloned: JSONObject = {};
		let index = 0;
		for (const [key, child] of properties) {
			if (index > 0) reserve(budget, 1);
			utf8ByteLength(key, "JSON object key");
			reserve(budget, serializedPrimitiveBytes(key));
			reserve(budget, 1);
			const clonedChild = cloneJson(child, depth + 1, active, budget);
			Object.defineProperty(cloned, key, {
				configurable: true,
				enumerable: true,
				value: clonedChild,
				writable: true,
			});
			index++;
		}
		reserve(budget, 1);
		return cloned;
	} finally {
		active.delete(value);
	}
}

function cloneBoundedJson(value: unknown, label: string, maxBytes: number): JSONValue {
	try {
		return cloneJson(value, 0, new WeakSet<object>(), { limit: maxBytes, used: 0 });
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Invalid projection")) {
			throw error;
		}
		invalid(`${label} is not valid JSON`);
	}
}

function hasField(properties: ReadonlyMap<string, unknown>, key: string): boolean {
	return properties.has(key);
}

const snapshotFields = new Set(["version", "projectionId", "revision", "view", "state", "operations"]);
const viewFields = new Set(["kind", "html", "css", "js"]);
const operationFields = new Set(["id", "label"]);
const interventionFields = new Set([
	"version",
	"projectionId",
	"observedRevision",
	"operationId",
	"input",
	"idempotencyKey",
]);

export function parseProjectionSnapshot(value: unknown): ProjectionSnapshot {
	const properties = readRecordProperties(value, "snapshot", snapshotFields);
	if (requireProperty(properties, "version", "snapshot") !== 1) invalid("snapshot.version must be 1");

	const projectionId = requireIdentifier(
		requireProperty(properties, "projectionId", "snapshot"),
		"snapshot.projectionId",
		MAX_PROJECTION_ID_BYTES,
	);
	const revision = requireRevision(requireProperty(properties, "revision", "snapshot"), "snapshot.revision");
	const viewProperties = readRecordProperties(
		requireProperty(properties, "view", "snapshot"),
		"snapshot.view",
		viewFields,
	);
	if (requireProperty(viewProperties, "kind", "snapshot.view") !== "isolated-html") {
		invalid("snapshot.view.kind must be isolated-html");
	}
	const view: ProjectionSnapshot["view"] = {
		kind: "isolated-html",
		html: requireBoundedString(
			requireProperty(viewProperties, "html", "snapshot.view"),
			"snapshot.view.html",
			MAX_HTML_BYTES,
		),
	};
	if (hasField(viewProperties, "css")) {
		view.css = requireBoundedString(viewProperties.get("css"), "snapshot.view.css", MAX_CSS_BYTES);
	}
	if (hasField(viewProperties, "js")) {
		view.js = requireBoundedString(viewProperties.get("js"), "snapshot.view.js", MAX_JS_BYTES);
	}

	const operationValues = readArrayValues(
		requireProperty(properties, "operations", "snapshot"),
		"snapshot.operations",
		MAX_OPERATIONS,
	);
	const operations: ProjectionSnapshot["operations"] = [];
	const operationIds = new Set<string>();
	for (const [index, operationValue] of operationValues.entries()) {
		const operationProperties = readRecordProperties(
			operationValue,
			`snapshot.operations[${index}]`,
			operationFields,
		);
		const id = requireIdentifier(
			requireProperty(operationProperties, "id", `snapshot.operations[${index}]`),
			`snapshot.operations[${index}].id`,
			MAX_OPERATION_ID_BYTES,
		);
		if (operationIds.has(id)) invalid(`snapshot.operations contains duplicate id ${id}`);
		operationIds.add(id);
		operations.push({
			id,
			label: requireIdentifier(
				requireProperty(operationProperties, "label", `snapshot.operations[${index}]`),
				`snapshot.operations[${index}].label`,
				MAX_LABEL_BYTES,
			),
		});
	}

	const parsed: ProjectionSnapshot = {
		version: 1,
		projectionId,
		revision,
		view,
		operations,
	};
	if (hasField(properties, "state")) {
		parsed.state = cloneBoundedJson(properties.get("state"), "snapshot.state", MAX_STATE_BYTES);
	}
	if (serializedByteLength(parsed) > MAX_SNAPSHOT_BYTES) invalid("snapshot exceeds its serialized byte limit");
	return parsed;
}

export function parseProjectionIntervention(value: unknown): ProjectionIntervention {
	const properties = readRecordProperties(value, "intervention", interventionFields);
	if (requireProperty(properties, "version", "intervention") !== 1) invalid("intervention.version must be 1");

	const parsed: ProjectionIntervention = {
		version: 1,
		projectionId: requireIdentifier(
			requireProperty(properties, "projectionId", "intervention"),
			"intervention.projectionId",
			MAX_PROJECTION_ID_BYTES,
		),
		observedRevision: requireRevision(
			requireProperty(properties, "observedRevision", "intervention"),
			"intervention.observedRevision",
		),
		operationId: requireIdentifier(
			requireProperty(properties, "operationId", "intervention"),
			"intervention.operationId",
			MAX_OPERATION_ID_BYTES,
		),
		idempotencyKey: requireIdentifier(
			requireProperty(properties, "idempotencyKey", "intervention"),
			"intervention.idempotencyKey",
			MAX_PROJECTION_ID_BYTES,
		),
	};
	if (hasField(properties, "input")) {
		parsed.input = cloneBoundedJson(properties.get("input"), "intervention.input", MAX_INPUT_BYTES);
	}
	return parsed;
}
