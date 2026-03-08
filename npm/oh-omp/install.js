"use strict";

const os = require("os");

const PLATFORMS = {
	"darwin-arm64": "@oh-labs/oh-omp-darwin-arm64",
	"linux-x64": "@oh-labs/oh-omp-linux-x64",
};

const platform = os.platform();
const arch = os.arch();
const key = `${platform}-${arch}`;
const pkg = PLATFORMS[key];

if (!pkg) {
	console.warn(
		`oh-omp: no prebuilt binary for ${key}. ` +
			`Supported: ${Object.keys(PLATFORMS).join(", ")}`,
	);
	process.exit(0);
}

try {
	require.resolve(`${pkg}/oh-omp`);
} catch {
	console.warn(
		`oh-omp: platform package "${pkg}" not found. ` +
			"The optional dependency may not have been installed by your package manager. " +
			"The oh-omp command will not work until it is available.",
	);
}

process.exit(0);
