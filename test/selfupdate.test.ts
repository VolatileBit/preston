import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ManualClock } from "../src/clock.js";
import { homePaths } from "../src/home.js";
import { setLanguage } from "../src/i18n/index.js";
import {
  installKind,
  installVersion,
  isNewer,
  latestVersion,
  PACKAGE_NAME,
  type RunProgram,
} from "../src/selfupdate/npm.js";
import { updateOnStart } from "../src/selfupdate/start.js";
import { readState } from "../src/selfupdate/state.js";
import {
  brief,
  goalCreatingCoordinator,
  reportingWorker,
  startPreston,
  tempDir,
  waitFor,
} from "./support/harness.js";

/** A pretend npm: answers `view`, `root -g` and `install -g`, and records every call. */
function fakeNpm(options: {
  latest?: string;
  globalRoot?: string;
  install?: { code: number; stderr?: string };
}) {
  const calls: string[] = [];
  const run: RunProgram = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    const line = args.join(" ");
    if (line === `view ${PACKAGE_NAME} version`) {
      return options.latest
        ? { code: 0, stdout: `${options.latest}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "offline" };
    }
    if (line === "root -g")
      return { code: 0, stdout: `${options.globalRoot ?? "/nowhere"}\n`, stderr: "" };
    if (line.startsWith("install -g")) {
      const install = options.install ?? { code: 0 };
      return { code: install.code, stdout: "", stderr: install.stderr ?? "" };
    }
    throw new Error(`unexpected npm call: ${line}`);
  };
  return { run, calls, installs: () => calls.filter((c) => c.startsWith("npm install")) };
}

/** A package folder inside a pretend global node_modules, as npm lays it out. */
function globalInstall() {
  const globalRoot = join(tempDir("npm-global"), "lib", "node_modules");
  const root = join(globalRoot, "@polyweave", "preston");
  mkdirSync(join(root, "dist"), { recursive: true });
  return { globalRoot, root };
}

describe("versions", () => {
  test("only a higher plain release counts as newer", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.0.9", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0-beta.1", "0.1.0")).toBe(false);
    expect(isNewer("latest", "0.1.0")).toBe(false);
  });

  test("the newest version comes from npm's answer, and an unusable answer is no answer", async () => {
    expect(await latestVersion(fakeNpm({ latest: "0.3.1" }).run)).toBe("0.3.1");
    expect(await latestVersion(fakeNpm({}).run)).toBeUndefined();
  });
});

describe("what Preston may update", () => {
  test("a copy installed by `npm install -g` is updated, even through a symlink", async () => {
    const { globalRoot, root } = globalInstall();
    const npm = fakeNpm({ globalRoot });
    expect(await installKind(npm.run, root)).toEqual({ kind: "global" });

    const link = join(tempDir("link"), "preston");
    symlinkSync(root, link);
    expect(await installKind(npm.run, link)).toEqual({ kind: "global" });
  });

  test("a development checkout, a project install or another manager's copy is left alone", async () => {
    const { globalRoot, root } = globalInstall();
    const checkout = tempDir("checkout");
    writeFileSync(join(checkout, "tsconfig.json"), "{}");
    expect(await installKind(fakeNpm({ globalRoot }).run, checkout)).toMatchObject({
      kind: "unmanaged",
    });

    const project = join(tempDir("project"), "node_modules", "@polyweave", "preston");
    mkdirSync(project, { recursive: true });
    expect(await installKind(fakeNpm({ globalRoot }).run, project)).toMatchObject({
      kind: "unmanaged",
    });
    expect(await installKind(fakeNpm({ globalRoot: "/somewhere/else" }).run, root)).toMatchObject({
      kind: "unmanaged",
    });
  });

  test("a permissions failure is explained, and only real version numbers are installed", async () => {
    const denied = await installVersion(
      fakeNpm({ install: { code: 243, stderr: "npm error code EACCES" } }).run,
      "0.2.0",
    );
    expect(denied).toMatchObject({ ok: false });
    expect(denied.ok ? "" : denied.detail).toContain("npm install -g @polyweave/preston");

    const npm = fakeNpm({});
    expect(await installVersion(npm.run, "latest; rm -rf ~")).toMatchObject({ ok: false });
    expect(npm.calls).toEqual([]);
  });
});

describe("the background service updates itself", () => {
  async function running(options: {
    latest?: string;
    install?: { code: number; stderr?: string };
    unmanaged?: boolean;
    config?: { enabled: boolean };
  }) {
    const { globalRoot, root } = globalInstall();
    const npm = fakeNpm({
      latest: options.latest,
      globalRoot: options.unmanaged ? "/elsewhere" : globalRoot,
      install: options.install,
    });
    const clock = new ManualClock();
    let restarts = 0;
    const p = await startPreston({
      scenario: {},
      clock,
      config: options.config
        ? {
            agents: { enabled: ["fake"] },
            coordinator: { agent: "fake" },
            setup: { complete: true },
            selfUpdate: options.config,
          }
        : undefined,
      selfUpdate: {
        exec: npm.run,
        packageRoot: root,
        currentVersion: "0.1.0",
        restart: () => {
          restarts++;
        },
      },
    });
    return { p, npm, clock, restarts: () => restarts };
  }

  test("a newer version is installed when nothing is running, the user is told, and it restarts", async () => {
    const { p, npm, clock, restarts } = await running({ latest: "0.2.0" });
    await clock.advance(61_000);
    await waitFor(() => restarts() === 1, { what: "the restart" });

    expect(npm.installs()).toEqual([`npm install -g ${PACKAGE_NAME}@0.2.0`]);
    await waitFor(() => p.owner.texts("notice").length === 1, { what: "the notice" });
    expect(p.owner.texts("notice")[0]).toContain("from Preston 0.1.0 to 0.2.0");
  });

  test("nothing happens when Preston is already current or updates are turned off", async () => {
    const same = await running({ latest: "0.1.0" });
    await same.clock.advance(61_000);
    expect(same.npm.installs()).toEqual([]);
    expect(same.restarts()).toBe(0);

    const off = await running({ latest: "0.2.0", config: { enabled: false } });
    await off.clock.advance(61_000);
    expect(off.npm.calls).toEqual([]);
  });

  test("an update waits while a Goal is running, and goes ahead when it has finished", async () => {
    const { globalRoot, root } = globalInstall();
    const npm = fakeNpm({ latest: "0.2.0", globalRoot });
    const clock = new ManualClock();
    let restarts = 0;
    let finish: (() => void) | undefined;
    const p = await startPreston({
      clock,
      scenario: {
        coordinator: goalCreatingCoordinator(tempDir("project"), brief()),
        worker: async (turn) => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return reportingWorker(turn);
        },
      },
      selfUpdate: {
        exec: npm.run,
        packageRoot: root,
        currentVersion: "0.1.0",
        restart: () => {
          restarts++;
        },
      },
    });
    p.owner.receive("go");
    await waitFor(() => p.rt.goals().some((g) => !g.endedAt), { what: "a running Goal" });
    await waitFor(() => finish !== undefined, { what: "the Worker to start" });

    await clock.advance(61_000);
    expect(npm.installs()).toEqual([]);
    expect(restarts).toBe(0);

    finish?.();
    // Verification runs real commands, so wait for it in real time before moving the clock on.
    await waitFor(() => p.rt.goals().every((g) => g.endedAt), { what: "the Goal to finish" });
    await clock.advance(16 * 60_000);
    await waitFor(() => restarts === 1, { what: "the update" });
    expect(npm.installs()).toEqual([`npm install -g ${PACKAGE_NAME}@0.2.0`]);
  });

  test("a copy npm did not install is not touched; the user is told how to update, once", async () => {
    const { p, npm, clock, restarts } = await running({ latest: "0.2.0", unmanaged: true });
    await clock.advance(61_000);
    await waitFor(() => p.owner.texts("notice").length === 1, { what: "the notice" });
    expect(npm.installs()).toEqual([]);
    expect(restarts()).toBe(0);
    expect(p.owner.texts("notice")[0]).toContain("npm install -g @polyweave/preston");

    await clock.advance(7 * 3_600_000);
    expect(p.owner.texts("notice")).toHaveLength(1);
  });

  test("a failed install is explained, nothing restarts, and the same version is not retried for a day", async () => {
    const { p, npm, clock, restarts } = await running({
      latest: "0.2.0",
      install: { code: 1, stderr: "npm error code EACCES" },
    });
    await clock.advance(61_000);
    await waitFor(() => p.owner.texts("notice").length === 1, { what: "the failure notice" });
    expect(p.owner.texts("notice")[0]).toContain("I couldn't update myself to 0.2.0");
    expect(restarts()).toBe(0);
    expect(npm.installs()).toHaveLength(1);

    await clock.advance(7 * 3_600_000);
    expect(npm.installs()).toHaveLength(1);
    expect(readState(homePaths(p.home)).failedVersion).toBe("0.2.0");

    await clock.advance(24 * 3_600_000);
    expect(npm.installs()).toHaveLength(2);
  });
});

describe("`preston` updates before it starts", () => {
  function start(options: {
    latest?: string;
    install?: { code: number; stderr?: string };
    unmanaged?: boolean;
    env?: NodeJS.ProcessEnv;
    config?: object;
    now?: () => number;
  }) {
    const { globalRoot, root } = globalInstall();
    const paths = homePaths(tempDir("preston-home"));
    mkdirSync(paths.root, { recursive: true });
    if (options.config) writeFileSync(paths.config, JSON.stringify(options.config));
    const npm = fakeNpm({
      latest: options.latest,
      globalRoot: options.unmanaged ? "/elsewhere" : globalRoot,
      install: options.install,
    });
    const printed: string[] = [];
    const events: string[] = [];
    const run = () =>
      updateOnStart({
        paths,
        cliPath: join(root, "dist", "cli.js"),
        print: (t) => printed.push(t),
        env: options.env ?? {},
        now: options.now ?? (() => 1_000_000),
        exec: npm.run,
        packageRoot: root,
        currentVersion: "0.1.0",
        stopDaemon: async () => {
          events.push("stopped the old service");
          return true;
        },
        rerun: async (cliPath) => {
          events.push(`ran ${cliPath.endsWith("cli.js") ? "the new cli" : cliPath}`);
          return 7;
        },
      });
    return { run, npm, printed, events, paths };
  }

  test("installs the newer version, stops the old service, and runs the new Preston in its place", async () => {
    const t = start({ latest: "0.2.0" });
    expect(await t.run()).toBe(7);
    expect(t.npm.installs()).toEqual([`npm install -g ${PACKAGE_NAME}@0.2.0`]);
    expect(t.events).toEqual(["stopped the old service", "ran the new cli"]);
    expect(t.printed[0]).toContain("Updating Preston 0.1.0 → 0.2.0");
  });

  test("carries on with this copy when there is nothing newer, offline, off, or just updated", async () => {
    for (const t of [
      start({ latest: "0.1.0" }),
      start({}),
      start({ latest: "0.2.0", config: { selfUpdate: { enabled: false } } }),
      start({ latest: "0.2.0", env: { PRESTON_JUST_UPDATED: "1" } }),
    ]) {
      expect(await t.run()).toBeUndefined();
      expect(t.npm.installs()).toEqual([]);
      expect(t.events).toEqual([]);
    }
  });

  test("a failed install is explained and `preston` still opens", async () => {
    const t = start({ latest: "0.2.0", install: { code: 1, stderr: "EACCES" } });
    expect(await t.run()).toBeUndefined();
    expect(t.printed.join("\n")).toContain("I couldn't update to 0.2.0");
    expect(t.printed.join("\n")).toContain("Carrying on with 0.1.0");
    expect(t.events).toEqual([]);
  });

  test("an install npm did not make is not touched; the user is told once", async () => {
    const t = start({
      latest: "0.2.0",
      unmanaged: true,
      now: (() => {
        let n = 0;
        return () => (n += 4 * 3_600_000);
      })(),
    });
    expect(await t.run()).toBeUndefined();
    expect(await t.run()).toBeUndefined();
    expect(t.npm.installs()).toEqual([]);
    expect(t.printed).toHaveLength(1);
    expect(t.printed[0]).toContain("npm install -g @polyweave/preston");
  });

  test("starting `preston` again within the hour does not ask npm again", async () => {
    const t = start({ latest: "0.1.0" });
    await t.run();
    const asked = t.npm.calls.length;
    await t.run();
    expect(t.npm.calls).toHaveLength(asked);
  });

  test("speaks the chosen language", async () => {
    const t = start({ latest: "0.2.0", config: { language: "zh-CN" } });
    await t.run();
    setLanguage("en");
    expect(t.printed[0]).toContain("正在把 Preston 从 0.1.0 更新到 0.2.0");
  });
});

test("the config file keeps what it was told about self-updating", () => {
  const file = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  expect(JSON.parse(file).name).toBe(PACKAGE_NAME);
});
