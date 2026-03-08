import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "../../..");
const configuredReleaseVersion = process.env.PI_RELEASE_VERSION?.trim();
const releaseVersion = configuredReleaseVersion ? configuredReleaseVersion.replace(/^v/, "") : undefined;

async function runCommand(args: string[], allowFailure = false): Promise<void> {
	const proc = Bun.spawn(args, {
		cwd: repoRoot,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0 && !allowFailure) {
		throw new Error(`Command failed (${exitCode}): ${args.join(" ")}`);
	}
}

const buildArgs = [
	"bun",
	"build",
	"--compile",
	"--define",
	"PI_COMPILED=true",
	"--root",
	".",
	"./packages/coding-agent/src/cli.ts",
	"--outfile",
	"packages/coding-agent/dist/oh-omp",
];

if (releaseVersion) {
	buildArgs.push("--define", `process.env.PI_RELEASE_VERSION=${JSON.stringify(releaseVersion)}`);
}

let buildError: unknown;
try {
	await runCommand(["bun", "--cwd=packages/stats", "scripts/generate-client-bundle.ts"]);
	await runCommand(["bun", "--cwd=packages/natives", "run", "build:native"]);
	await runCommand(["bun", "--cwd=packages/natives", "run", "embed:native"]);
	await runCommand(buildArgs);
} catch (error) {
	buildError = error;
} finally {
	await runCommand(["bun", "--cwd=packages/natives", "run", "embed:native", "--reset"], true);
	await runCommand(["bun", "--cwd=packages/stats", "scripts/generate-client-bundle.ts", "--reset"], true);
}

if (buildError) throw buildError;
