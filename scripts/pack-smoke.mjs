// Packs Preston, installs the tarball globally into a temporary prefix, and runs the installed
// `preston` with its hidden --version flag. Run after `npm run build`: `npm run test:pack`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const windows = process.platform === "win32";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "preston-pack-"));

/** Runs npm through the npm that started this script, so no shell or `npm.cmd` is needed. */
function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  const [command, fullArgs, shell] = npmCli?.endsWith(".js")
    ? [process.execPath, [npmCli, ...args], false]
    : ["npm", args, windows];
  return run(command, fullArgs, { cwd, shell });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.error?.message}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", work], root).stdout);
  const { filename, files } = packed[0];
  const paths = files.map((f) => f.path);
  check(paths.includes("dist/cli.js"), "the package is missing dist/cli.js");
  check(paths.includes("package.json") && paths.includes("README.md"), "package.json or README");
  check(!paths.some((p) => /^(src|test|scripts)\//.test(p)), "the package includes sources");
  console.log(`packed ${filename} (${files.length} files)`);

  const prefix = join(work, "prefix");
  npm(
    ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", join(work, filename)],
    work,
  );

  // npm puts global bins in <prefix>/bin on POSIX and as <prefix>\preston.cmd on Windows.
  // A .cmd file can only be started through cmd.exe, hence the shell there.
  const bin = windows ? join(prefix, "preston.cmd") : join(prefix, "bin", "preston");
  const version = run(windows ? `"${bin}"` : bin, ["--version"], { cwd: work, shell: windows });
  check(version.stdout.trim() === pkg.version, `expected ${pkg.version}, got ${version.stdout}`);
  check(version.stderr.trim() === "", `unexpected stderr: ${version.stderr}`);
  console.log(`installed preston --version: ${version.stdout.trim()}`);

  const runBin = (args) =>
    spawnSync(windows ? `"${bin}"` : bin, args, { cwd: work, encoding: "utf8", shell: windows });

  // Only `preston` and `preston stop` are commands; `-h` explains them and exits 0.
  const help = runBin(["-h"]);
  check(
    help.status === 0 && /^Usage: preston\b/.test(help.stdout) && help.stderr === "",
    "`preston -h` must print the usage and exit 0",
  );
  const other = runBin(["help"]);
  check(
    other.status === 2 && /unknown command 'help'/.test(other.stderr),
    "`preston help` must be a usage error",
  );
  console.log("pack-install smoke passed");
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
