import { describe, expect, test } from "vitest";
import {
  ensureStartAtLogin,
  removeStartAtLogin,
  type ServiceHost,
  type ServiceTarget,
  serviceSpec,
} from "../src/service/index.js";
import type { CommandResult } from "../src/util/command.js";

/** An in-memory OS: files in a map, commands recorded and answered by `respond`. */
function fakeHost(
  platform: NodeJS.Platform,
  overrides: Partial<ServiceHost> & {
    respond?: (command: string, args: readonly string[]) => Partial<CommandResult>;
  } = {},
) {
  const files = new Map<string, string | Uint8Array>();
  const calls: string[][] = [];
  const { respond, ...rest } = overrides;
  const host: ServiceHost = {
    platform,
    env: {},
    userHome:
      platform === "win32" ? "C:\\Users\\Ada" : platform === "darwin" ? "/Users/ada" : "/home/ada",
    uid: platform === "win32" ? undefined : 501,
    username: "ada",
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: "", stderr: "", ...respond?.(command, args) };
    },
    fs: {
      read: (path) => {
        const data = files.get(path);
        return typeof data === "string" ? data : data && Buffer.from(data).toString("utf8");
      },
      write: (path, data) => void files.set(path, data),
      exists: (path) => files.has(path),
      remove: (path) => void files.delete(path),
    },
    sleep: async () => {},
    ...rest,
  };
  const text = (path: string) => {
    const data = files.get(path);
    if (data === undefined) throw new Error(`no file at ${path}; have ${[...files.keys()]}`);
    return typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  };
  return { host, files, calls, text };
}

const macTarget: ServiceTarget = {
  home: "/Users/ada/.preston",
  nodePath: "/Users/ada/.nvm/versions/node/v22.13.0/bin/node",
  cliPath: "/Users/ada/.nvm/versions/node/v22.13.0/lib/node_modules/@polyweave/preston/dist/cli.js",
};
const PLIST = "/Users/ada/Library/LaunchAgents/ai.polyweave.preston.plist";

describe("macOS LaunchAgent", () => {
  test("writes a per-user agent running this Node and entrypoint, and loads it", async () => {
    const { host, calls, text } = fakeHost("darwin", {
      env: { PATH: "/opt/homebrew/bin:/usr/bin" },
    });

    const result = await ensureStartAtLogin(macTarget, host);

    expect(result).toMatchObject({ registered: true, mechanism: "launchd", changed: true });
    expect(result.notice).toBe("Preston will start by itself when you sign in to this computer.");
    const plist = text(PLIST);
    expect(plist).toContain("<key>Label</key>\n  <string>ai.polyweave.preston</string>");
    expect(plist).toContain(
      `<array>\n    <string>${macTarget.nodePath}</string>\n    <string>${macTarget.cliPath}</string>\n    <string>daemon</string>\n  </array>`,
    );
    expect(plist).toContain("<key>PRESTON_HOME</key>\n    <string>/Users/ada/.preston</string>");
    // `claude` and `codex` need `node` on PATH, which launchd does not provide.
    expect(plist).toContain(
      "<key>PATH</key>\n    <string>/Users/ada/.nvm/versions/node/v22.13.0/bin:/opt/homebrew/bin:/usr/bin</string>",
    );
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<string>/Users/ada/.preston/logs/daemon.out</string>");
    expect(calls).toEqual([
      ["launchctl", "enable", "gui/501/ai.polyweave.preston"],
      ["launchctl", "bootstrap", "gui/501", PLIST],
    ]);
  });

  test("is idempotent: an unchanged registration touches nothing", async () => {
    const { host, calls } = fakeHost("darwin");
    await ensureStartAtLogin(macTarget, host);
    calls.length = 0;

    const again = await ensureStartAtLogin(macTarget, host);

    expect(again).toEqual({ registered: true, mechanism: "launchd", changed: false });
    expect(calls).toEqual([]);
  });

  test("re-registers quietly when Node moved, for example after an nvm upgrade", async () => {
    const { host, calls, text } = fakeHost("darwin");
    await ensureStartAtLogin(macTarget, host);
    calls.length = 0;
    const upgraded = { ...macTarget, nodePath: "/Users/ada/.nvm/versions/node/v24.1.0/bin/node" };

    const result = await ensureStartAtLogin(upgraded, host);

    expect(result).toMatchObject({ registered: true, changed: true });
    expect(result.notice).toBeUndefined();
    expect(text(PLIST)).toContain(
      "<string>/Users/ada/.nvm/versions/node/v24.1.0/bin/node</string>",
    );
    expect(text(PLIST)).not.toContain("v22.13.0/bin/node");
    expect(calls).toEqual([
      ["launchctl", "bootout", "gui/501/ai.polyweave.preston"],
      ["launchctl", "enable", "gui/501/ai.polyweave.preston"],
      ["launchctl", "bootstrap", "gui/501", PLIST],
    ]);
  });

  test("re-registers when the agent file was deleted", async () => {
    const { host, files } = fakeHost("darwin");
    await ensureStartAtLogin(macTarget, host);
    files.delete(PLIST);

    expect(await ensureStartAtLogin(macTarget, host)).toMatchObject({ changed: true });
    expect(files.has(PLIST)).toBe(true);
  });

  test("escapes XML and gives another PRESTON_HOME its own label", async () => {
    const { host, files, text } = fakeHost("darwin");
    const home = "/Users/ada/Preston & <Co>";

    await ensureStartAtLogin({ ...macTarget, home }, host);

    const [path] = [...files.keys()].filter((p) => p.endsWith(".plist"));
    expect(path).toMatch(/\/ai\.polyweave\.preston\.[0-9a-f]{8}\.plist$/);
    expect(text(path as string)).toContain("<string>/Users/ada/Preston &amp; &lt;Co&gt;</string>");
  });

  test("keeps the agent for the next login when launchd cannot load it now", async () => {
    const { host, calls } = fakeHost("darwin", {
      respond: (_command, args) =>
        args[0] === "bootstrap"
          ? { code: 125, stderr: "Domain does not support specified action" }
          : {},
    });

    const result = await ensureStartAtLogin(macTarget, host);

    expect(result).toMatchObject({ registered: true, mechanism: "launchd" });
    expect(result.detail).toContain("Domain does not support specified action");
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(2);
  });
});

const linuxTarget: ServiceTarget = {
  home: "/home/ada/.preston",
  nodePath: "/home/ada/.local/share/fnm/node-versions/v22.13.0/installation/bin/node",
  cliPath: "/home/ada/.local/lib/node_modules/@polyweave/preston/dist/cli.js",
};

describe("Linux systemd user unit", () => {
  test("writes the unit, reloads systemd and enables it now", async () => {
    const { host, calls, text } = fakeHost("linux", {
      env: { XDG_CONFIG_HOME: "/home/ada/.cfg", PATH: "/usr/bin" },
    });

    const result = await ensureStartAtLogin(linuxTarget, host);

    expect(result).toMatchObject({ registered: true, mechanism: "systemd", changed: true });
    const unit = text("/home/ada/.cfg/systemd/user/preston.service");
    expect(unit).toContain(`ExecStart="${linuxTarget.nodePath}" "${linuxTarget.cliPath}" "daemon"`);
    expect(unit).toContain('Environment="PRESTON_HOME=/home/ada/.preston"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StandardOutput=append:/home/ada/.preston/logs/daemon.out");
    expect(unit).toContain("WantedBy=default.target");
    expect(calls).toEqual([
      ["systemctl", "--user", "show-environment"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "preston.service"],
    ]);
  });

  test("escapes specifiers, variables and quotes in paths", async () => {
    const { host, text } = fakeHost("linux");
    const home = '/home/ada/50% "off" $HOME';

    await ensureStartAtLogin({ ...linuxTarget, home }, host);

    const { unit: name } = serviceSpec({ ...linuxTarget, home }, host).ids;
    const unit = text(`/home/ada/.config/systemd/user/${name}`);
    expect(unit).toContain('Environment="PRESTON_HOME=/home/ada/50%% \\"off\\" $$HOME"');
    expect(unit).toContain('WorkingDirectory=/home/ada/50%% "off" $HOME');
  });

  test("falls back to XDG autostart on a desktop without a systemd user manager", async () => {
    const { host, text } = fakeHost("linux", {
      env: { DISPLAY: ":0" },
      respond: (command) =>
        command === "systemctl" ? { code: 1, stderr: "Failed to connect to bus" } : {},
    });

    const result = await ensureStartAtLogin(linuxTarget, host);

    expect(result).toMatchObject({ registered: true, mechanism: "xdg-autostart" });
    expect(result.notice).toContain("if your desktop supports autostart");
    const entry = text("/home/ada/.config/autostart/preston.desktop");
    expect(entry).toContain(
      `Exec=env "PRESTON_HOME=/home/ada/.preston" "PATH=/home/ada/.local/share/fnm/node-versions/v22.13.0/installation/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "${linuxTarget.nodePath}" "${linuxTarget.cliPath}" daemon`,
    );
  });

  test("explains once, without failing, when there is no service manager (WSL, containers)", async () => {
    const { host, calls } = fakeHost("linux", {
      env: { WSL_DISTRO_NAME: "Ubuntu", DISPLAY: ":0" },
      respond: (command) => (command === "systemctl" ? { code: null, error: "ENOENT" } : {}),
    });

    const first = await ensureStartAtLogin(linuxTarget, host);
    const second = await ensureStartAtLogin(linuxTarget, host);

    expect(first.registered).toBe(false);
    expect(first.notice).toContain("systemd user services aren't available");
    expect(first.notice).toContain("Preston is running now, but it won't start by itself");
    expect(second).toEqual({ registered: false, changed: false, notice: undefined });
    // It still tries again each time, in case systemd became available.
    expect(calls).toHaveLength(2);
  });

  test("a failing systemctl is explained, not thrown", async () => {
    const { host } = fakeHost("linux", {
      respond: (_command, args) =>
        args.includes("enable") ? { code: 1, stderr: "Access denied" } : {},
    });

    const result = await ensureStartAtLogin(linuxTarget, host);

    expect(result.registered).toBe(false);
    expect(result.notice).toMatch(
      /^I couldn't set Preston to start when you sign in: .*Access denied/,
    );
  });
});

const winTarget: ServiceTarget = {
  home: "C:\\Users\\Ada\\.preston",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  cliPath: "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@polyweave\\preston\\dist\\cli.js",
};
const TASK_XML = "C:\\Users\\Ada\\.preston\\service\\login-task.xml";
const LAUNCHER = "C:\\Users\\Ada\\.preston\\service\\start-preston.js";

describe("Windows scheduled task", () => {
  test("creates a per-user logon task without administrator rights", async () => {
    const { host, calls, files, text } = fakeHost("win32", {
      env: {
        USERDOMAIN: "DESKTOP-1",
        USERNAME: "Ada",
        APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
      },
    });

    const result = await ensureStartAtLogin(winTarget, host);

    expect(result).toMatchObject({ registered: true, mechanism: "scheduled-task", changed: true });
    expect(calls).toEqual([["schtasks", "/Create", "/TN", "Preston", "/XML", TASK_XML, "/F"]]);
    const raw = files.get(TASK_XML) as Uint8Array;
    expect([...raw.slice(0, 2)]).toEqual([0xff, 0xfe]);
    const xml = Buffer.from(raw.slice(2)).toString("utf16le");
    expect(xml).toContain(
      "<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>DESKTOP-1\\Ada</UserId>",
    );
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain(
      `<Arguments>//B //Nologo //E:jscript &quot;${LAUNCHER}&quot;</Arguments>`,
    );

    const launcher = text(LAUNCHER);
    expect(launcher).toContain(
      'shell.Run("\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" \\"C:\\\\Users\\\\Ada\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\@polyweave\\\\preston\\\\dist\\\\cli.js\\" daemon", 0, false);',
    );
    // The default home needs no environment; the daemon finds it on its own.
    expect(launcher).not.toContain("PRESTON_HOME");
  });

  test("checks the task still exists before calling an unchanged registration current", async () => {
    let exists = true;
    const { host, calls } = fakeHost("win32", {
      respond: (_command, args) => (args[0] === "/Query" && !exists ? { code: 1 } : {}),
    });
    await ensureStartAtLogin(winTarget, host);
    calls.length = 0;

    expect(await ensureStartAtLogin(winTarget, host)).toMatchObject({ changed: false });
    exists = false;
    expect(await ensureStartAtLogin(winTarget, host)).toMatchObject({ changed: true });
    expect(calls.map((c) => c[1])).toEqual(["/Query", "/Query", "/Create"]);
  });

  test("another PRESTON_HOME gets its own task, and the launcher sets the home", async () => {
    const { host, calls, text } = fakeHost("win32");
    const home = "D:\\Données\\preston";

    await ensureStartAtLogin({ ...winTarget, home }, host);

    expect(calls[0]?.[3]).toMatch(/^Preston-[0-9a-f]{8}$/);
    expect(text("D:\\Données\\preston\\service\\start-preston.js")).toContain(
      'shell.Environment("Process")("PRESTON_HOME") = "D:\\\\Donn\\u00e9es\\\\preston";',
    );
  });

  test("falls back to the Startup folder when scheduled tasks are not allowed", async () => {
    const { host, text } = fakeHost("win32", {
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
      respond: () => ({ code: 1, stderr: "ERROR: Access is denied." }),
    });

    const target = { ...winTarget, home: "C:\\100%\\.preston" };

    const result = await ensureStartAtLogin(target, host);

    expect(result).toMatchObject({ registered: true, mechanism: "startup-folder" });
    const startup =
      "C:\\Users\\Ada\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup";
    const script = text(`${startup}\\${serviceSpec(target, host).ids.task}.cmd`);
    expect(script).toBe(
      '@echo off\r\nstart "" wscript.exe //B //Nologo //E:jscript "C:\\100%%\\.preston\\service\\start-preston.js"\r\n',
    );
  });

  test("unregistering removes the task and generated files", async () => {
    const { host, calls, files } = fakeHost("win32");
    await ensureStartAtLogin(winTarget, host);
    calls.length = 0;

    await removeStartAtLogin(winTarget, host);

    expect(calls).toEqual([["schtasks", "/Delete", "/TN", "Preston", "/F"]]);
    expect([...files.keys()]).toEqual([]);
  });
});

describe("registration never breaks starting Preston", () => {
  test("a file system error becomes a plain notice", async () => {
    const { host } = fakeHost("darwin");
    host.fs.write = () => {
      throw new Error("EACCES: permission denied");
    };

    const result = await ensureStartAtLogin(macTarget, host);

    expect(result.registered).toBe(false);
    expect(result.notice).toContain("permission denied");
    expect(result.notice).toContain("Preston is running now");
  });

  test("an unsupported OS is explained", async () => {
    const { host } = fakeHost("freebsd");

    const result = await ensureStartAtLogin(macTarget, host);

    expect(result).toMatchObject({ registered: false });
    expect(result.notice).toContain("no login service support for freebsd");
  });

  test("macOS and Linux unregister stop the service and remove their files", async () => {
    const mac = fakeHost("darwin");
    await ensureStartAtLogin(macTarget, mac.host);
    mac.calls.length = 0;
    await removeStartAtLogin(macTarget, mac.host);
    expect(mac.calls).toEqual([["launchctl", "bootout", "gui/501/ai.polyweave.preston"]]);
    expect([...mac.files.keys()]).toEqual([]);

    const linux = fakeHost("linux");
    await ensureStartAtLogin(linuxTarget, linux.host);
    linux.calls.length = 0;
    await removeStartAtLogin(linuxTarget, linux.host);
    expect(linux.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "preston.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect([...linux.files.keys()]).toEqual([]);
  });
});
