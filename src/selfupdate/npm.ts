import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pick } from "../i18n/index.js";

export const PACKAGE_NAME = "@polyweave/preston";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell; never rejects. Tests replace it. */
export type RunProgram = (
  command: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<ExecResult>;

export const runProgram: RunProgram = (command, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      // On Windows npm is a .cmd file, which needs a shell. The arguments are fixed words and a
      // version number that has been checked, never user text.
      command,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        shell: process.platform === "win32",
        maxBuffer: 5_000_000,
      },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : null
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
      },
    );
  });

/** The folder of this installed package, from both `src/selfupdate` and `dist/selfupdate`. */
export function thisPackageRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

const VERSION = /^\d+\.\d+\.\d+$/;

/** Whether `candidate` is a newer plain release than `current` (pre-releases never count). */
export function isNewer(candidate: string, current: string): boolean {
  if (!VERSION.test(candidate)) return false;
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** The newest published version, asked of npm so the user's own registry settings apply. */
export async function latestVersion(exec: RunProgram): Promise<string | undefined> {
  const result = await exec("npm", ["view", PACKAGE_NAME, "version"], { timeoutMs: 15_000 });
  const version = result.stdout.trim();
  return result.code === 0 && VERSION.test(version) ? version : undefined;
}

export type InstallKind = { kind: "global" } | { kind: "unmanaged"; reason: string };

/**
 * Preston updates only a copy that npm installed globally. A development checkout, a project
 * install, an npx cache or another package manager's copy is left alone.
 */
export async function installKind(exec: RunProgram, packageRoot: string): Promise<InstallKind> {
  const root = safeRealpath(packageRoot);
  if (existsSync(join(root, "tsconfig.json")) || existsSync(join(root, ".git"))) {
    return {
      kind: "unmanaged",
      reason: pick({
        en: "this copy runs from a development checkout",
        "zh-CN": "这份副本运行在开发源码目录中",
      }),
    };
  }
  const global = await exec("npm", ["root", "-g"], { timeoutMs: 15_000 });
  const globalRoot = global.stdout.trim();
  if (global.code === 0 && globalRoot && root === safeRealpath(join(globalRoot, PACKAGE_NAME))) {
    return { kind: "global" };
  }
  return {
    kind: "unmanaged",
    reason: pick({
      en: "this copy was not installed with `npm install -g`",
      "zh-CN": "这份副本不是通过 `npm install -g` 安装的",
    }),
  };
}

export type InstallResult = { ok: true } | { ok: false; detail: string };

/** `npm install -g @polyweave/preston@<version>`, with a plain explanation when it fails. */
export async function installVersion(exec: RunProgram, version: string): Promise<InstallResult> {
  if (!VERSION.test(version)) return { ok: false, detail: `Not a version number: ${version}` };
  const result = await exec("npm", ["install", "-g", `${PACKAGE_NAME}@${version}`], {
    timeoutMs: 5 * 60_000,
  });
  if (result.code === 0) return { ok: true };
  const text = result.stderr;
  if (/EACCES|EPERM/.test(text)) {
    return {
      ok: false,
      detail: pick({
        en: `Preston is installed where this account can't change files. Fix npm's folder permissions (https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally), then run: npm install -g ${PACKAGE_NAME}`,
        "zh-CN": `Preston 安装在当前账号无法修改的位置。请先修复 npm 的文件夹权限（https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally），然后运行：npm install -g ${PACKAGE_NAME}`,
      }),
    };
  }
  const tail = text.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return {
    ok: false,
    detail: pick({
      en: `npm could not install ${version}: ${tail || "no details"}`,
      "zh-CN": `npm 无法安装 ${version}：${tail || "没有详细信息"}`,
    }),
  };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
