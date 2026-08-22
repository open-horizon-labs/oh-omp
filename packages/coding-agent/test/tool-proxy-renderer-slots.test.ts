import { describe, expect, it } from "bun:test";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { RegisteredTool, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { RegisteredToolAdapter } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { applyToolProxy, reserveOwnWritableProperties } from "@oh-my-pi/pi-coding-agent/extensibility/tool-proxy";
import { Type } from "@sinclair/typebox";

function definition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: "probe",
		label: "Probe",
		description: "Renderer slot probe",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
		...overrides,
	};
}

describe("reserveOwnWritableProperties", () => {
	it("keeps later assignment writable when the target has no field slot", () => {
		const wrapper: { renderCall?: () => string } = {};
		const tool = { name: "probe", renderCall: () => "from-def" };
		reserveOwnWritableProperties(wrapper, tool, ["renderCall", "renderResult"]);
		applyToolProxy(tool, wrapper);
		wrapper.renderCall = () => "from-wrapper";
		expect(wrapper.renderCall()).toBe("from-wrapper");
	});

	it("does not install a slot when the source has no renderer", () => {
		const wrapper: Record<string, unknown> = {};
		reserveOwnWritableProperties(wrapper, { name: "probe" }, ["renderCall", "renderResult"]);
		expect(Object.hasOwn(wrapper, "renderCall")).toBe(false);
		expect(Object.hasOwn(wrapper, "renderResult")).toBe(false);
	});
});

describe("RegisteredToolAdapter renderers", () => {
	const runner = {} as ExtensionRunner;

	it("adapts a registered tool that defines both renderers", () => {
		const tool: RegisteredTool = {
			extensionPath: "/tmp/probe.ts",
			definition: definition({
				renderCall: (() => "call") as unknown as ToolDefinition["renderCall"],
				renderResult: (() => "result") as unknown as ToolDefinition["renderResult"],
			}),
		};
		const adapter = new RegisteredToolAdapter(tool, runner);
		expect(typeof adapter.renderCall).toBe("function");
		expect(typeof adapter.renderResult).toBe("function");
	});

	it("does not expose render methods when the definition has none", () => {
		const adapter = new RegisteredToolAdapter({ extensionPath: "/tmp/probe.ts", definition: definition() }, runner);
		expect(adapter.renderCall).toBeUndefined();
		expect(adapter.renderResult).toBeUndefined();
	});
});
