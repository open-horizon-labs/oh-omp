/**
 * Tests that the OH provider discovers skills from .oh/skills/ at project root.
 * No walk-up — .oh/ is project-root only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { scanSkillsFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";

const PROVIDER_ID = "oh";

function writeSkill(dir: string, name: string, description: string): void {
	const skillDir = path.join(dir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill content.\n`,
	);
}

describe("OH provider skill discovery", () => {
	let tempDir!: string;
	let projectRoot!: string;
	let ctx!: LoadContext;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-oh-skills-"));
		projectRoot = path.join(tempDir, "project");
		fs.mkdirSync(projectRoot, { recursive: true });
		fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
		ctx = { cwd: projectRoot, home: tempDir, repoRoot: projectRoot };
	});

	afterEach(() => {
		clearCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("discovers skills from .oh/skills/", async () => {
		const skillsDir = path.join(projectRoot, ".oh", "skills");
		writeSkill(skillsDir, "oh-ship", "Ship a release");
		writeSkill(skillsDir, "oh-deploy", "Deploy to staging");

		const result = await scanSkillsFromDir(ctx, {
			dir: skillsDir,
			providerId: PROVIDER_ID,
			level: "project",
		});

		expect(result.items).toHaveLength(2);
		const names = result.items.map(s => s.name).sort();
		expect(names).toEqual(["oh-deploy", "oh-ship"]);
		expect(result.items[0]._source.provider).toBe("oh");
		expect(result.items[0]._source.level).toBe("project");
	});

	test("returns empty when .oh/skills/ does not exist", async () => {
		const skillsDir = path.join(projectRoot, ".oh", "skills");
		const result = await scanSkillsFromDir(ctx, {
			dir: skillsDir,
			providerId: PROVIDER_ID,
			level: "project",
		});

		expect(result.items).toHaveLength(0);
	});

	test("ignores entries without SKILL.md", async () => {
		const skillsDir = path.join(projectRoot, ".oh", "skills");
		writeSkill(skillsDir, "valid-skill", "Has SKILL.md");
		// Create a dir without SKILL.md
		fs.mkdirSync(path.join(skillsDir, "not-a-skill"), { recursive: true });
		fs.writeFileSync(path.join(skillsDir, "not-a-skill", "README.md"), "# Not a skill\n");

		const result = await scanSkillsFromDir(ctx, {
			dir: skillsDir,
			providerId: PROVIDER_ID,
			level: "project",
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe("valid-skill");
	});
});
