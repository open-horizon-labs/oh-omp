/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead.
 */
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../config/settings-schema";

export interface InterceptionResult {
	/** If true, the bash command should be blocked */
	block: boolean;
	/** Error message to return instead of executing */
	message?: string;
	/** Suggested tool to use instead */
	suggestedTool?: string;
}

/**
 * Blank quoted segments, keeping the quote characters. Quoted content is
 * shell *data*, not syntax — interception rules must never match on it
 * (e.g. `echo "a > b"` is not a redirection, `python -c 'sed -i ...'` is
 * not a sed invocation).
 */
function blankQuotedSegments(command: string): string {
	let out = "";
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\") {
			i++; // Escaped char outside quotes is data — drop both.
			continue;
		}
		if (ch === "'") {
			out += "''";
			const end = command.indexOf("'", i + 1);
			if (end === -1) return out; // Unterminated quote — rest is data.
			i = end;
			continue;
		}
		if (ch === '"') {
			out += '""';
			let j = i + 1;
			while (j < command.length && command[j] !== '"') {
				if (command[j] === "\\") j++;
				j++;
			}
			if (j >= command.length) return out;
			i = j;
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * Composite commands (pipes, chains, substitution) signal shell composition
 * that read-only suggested tools cannot express — e.g. `find … | xargs wc`
 * has no `find`-tool equivalent. Detected on the quote-blanked command so
 * quoted `|`/`;` don't count.
 */
function isCompositeCommand(blankedCommand: string): boolean {
	return /\||&&|;|\$\(|`/.test(blankedCommand);
}

/**
 * Compile bash interceptor rules into regexes, skipping invalid patterns.
 */
function compileRules(rules: BashInterceptorRule[]): Array<{ rule: BashInterceptorRule; regex: RegExp }> {
	const compiled: Array<{ rule: BashInterceptorRule; regex: RegExp }> = [];
	for (const rule of rules) {
		const flags = rule.flags ?? "";
		try {
			compiled.push({ rule, regex: new RegExp(rule.pattern, flags) });
		} catch {
			// Skip invalid regex patterns
		}
	}
	return compiled;
}

/**
 * Check if a bash command should be intercepted.
 *
 * @param command The bash command to check
 * @param availableTools Set of tool names that are available
 * @returns InterceptionResult indicating if the command should be blocked
 */
export function checkBashInterception(
	command: string,
	availableTools: string[],
	rules: BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
): InterceptionResult {
	// Match against the quote-blanked command: quoted content is data.
	const normalizedCommand = command.trim();
	const matchable = blankQuotedSegments(normalizedCommand);
	const composite = isCompositeCommand(matchable);
	const compiled = compileRules(rules);

	for (const { rule, regex } of compiled) {
		// Only block if the suggested tool is actually available
		if (!availableTools.includes(rule.tool)) {
			continue;
		}
		// Rules whose tool cannot express composition skip composite commands.
		if (rule.simpleCommandsOnly && composite) {
			continue;
		}

		if (regex.test(matchable)) {
			return {
				block: true,
				message: `Blocked: ${rule.message}\n\nOriginal command: ${command}`,
				suggestedTool: rule.tool,
			};
		}
	}

	return { block: false };
}
