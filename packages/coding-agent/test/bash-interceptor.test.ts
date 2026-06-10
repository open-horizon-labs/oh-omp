import { describe, expect, test } from "bun:test";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";

const ALL_TOOLS = ["read", "grep", "find", "write", "edit"];

describe("bash interceptor false positives", () => {
	test("echo with redirection characters inside quotes passes", () => {
		expect(checkBashInterception('echo "a > b"', ALL_TOOLS).block).toBe(false);
		expect(checkBashInterception("echo '>>> marker <<<'", ALL_TOOLS).block).toBe(false);
	});

	test("real echo redirection still blocks", () => {
		const result = checkBashInterception('echo "content" > file.txt', ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("write");
	});

	test("quoted tool names inside other commands pass", () => {
		expect(checkBashInterception(`python3 -c 'print("sed -i is a string")'`, ALL_TOOLS).block).toBe(false);
	});

	test("find in a pipeline passes (find tool cannot express it)", () => {
		expect(checkBashInterception("find . -name '*.ts' -mtime -2 | xargs wc -l", ALL_TOOLS).block).toBe(false);
	});

	test("bare find with -name still blocks", () => {
		const result = checkBashInterception("find . -name '*.ts'", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("find");
	});

	test("rg in a pipeline passes; bare rg blocks", () => {
		expect(checkBashInterception("rg pattern src | head -5", ALL_TOOLS).block).toBe(false);
		expect(checkBashInterception("rg pattern src", ALL_TOOLS).block).toBe(true);
	});

	test("quoted pipe does not count as composite", () => {
		// The pipe is data, so this is a simple command and still blocks.
		expect(checkBashInterception(`grep "a|b" src/`, ALL_TOOLS).block).toBe(true);
	});

	test("leading mutation rules still apply in composite commands", () => {
		// sed has no simpleCommandsOnly: a leading sed -i in a chain still blocks.
		const result = checkBashInterception("sed -i 's/a/b/' file.ts && bun test", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	test("cat still blocks as a simple command", () => {
		const result = checkBashInterception("cat package.json", ALL_TOOLS);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("read");
	});
});
