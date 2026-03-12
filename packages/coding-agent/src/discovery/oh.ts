/**
 * Open Horizons (.oh) Provider
 *
 * Loads skills from the project's .oh/skills/ directory.
 * The .oh/ directory is the Open Horizons project metadata convention.
 * Only scans at project root (no walk-up, no user-level).
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { scanSkillsFromDir } from "./helpers";

const PROVIDER_ID = "oh";
const DISPLAY_NAME = "Open Horizons (.oh)";
const PRIORITY = 75;
const OH_DIR = ".oh";

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const dir = path.join(ctx.cwd, OH_DIR, "skills");
	return scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "project" });
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from .oh/skills/ (project root only)",
	priority: PRIORITY,
	load: loadSkills,
});
