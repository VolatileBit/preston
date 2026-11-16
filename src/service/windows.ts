import { describeFailure } from "../util/command.js";
import { pathsFor, type ServiceHost } from "./host.js";
import type { BackendFactory, ServiceSpec } from "./spec.js";

const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A JScript string literal, ASCII-only so the file's encoding never matters. */
const jscriptString = (value: string) =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/**
 * Windows Script Host launcher. Node is a console program, so starting it directly at login
 * would leave a console window open; WScript.Shell.Run with window style 0 starts it hidden.
 * Paths on Windows cannot contain `"`, so quoting them is enough.
 */
export function launcherScript(spec: ServiceSpec): string {
  const command = `"${spec.nodePath}" "${spec.cliPath}" daemon`;
  // PATH comes from the user's own login environment. PRESTON_HOME is set only for a home
  // other than the default, which the daemon finds on its own.
  const env = spec.defaultHome
    ? []
    : [`shell.Environment("Process")("PRESTON_HOME") = ${jscriptString(spec.home)};`];
  return [
    "// Written by Preston: starts its background service, without a window, when you sign in.",
    'var shell = new ActiveXObject("WScript.Shell");',
    ...env,
    `shell.Run(${jscriptString(command)}, 0, false);`,
    "",
  ].join("\r\n");
}

/** `wscript.exe` arguments that run the launcher with no dialogs. */
export const launcherArgs = (launcherPath: string) => `//B //Nologo //E:jscript "${launcherPath}"`;

/**
 * A scheduled task triggered at this user's logon. Scoping the trigger and principal to the user
 * (rather than `/SC ONLOGON`, which means any user and needs administrator rights) lets a
 * standard account create it, and `LeastPrivilege` keeps it unelevated.
 */
export function scheduledTaskXml(spec: ServiceSpec, userId: string, launcherPath: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts Preston's background service when you sign in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>${xml(launcherArgs(launcherPath))}</Arguments>
      <WorkingDirectory>${xml(spec.home)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Startup-folder fallback. `%` is the only character a quoted batch argument must escape. */
export function startupScript(launcherPath: string): string {
  return [
    "@echo off",
    `start "" wscript.exe ${launcherArgs(launcherPath).replace(/%/g, "%%")}`,
    "",
  ].join("\r\n");
}

/** schtasks reads task XML reliably only as UTF-16 with a byte order mark. */
const utf16 = (text: string) =>
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

function userId(host: ServiceHost): string {
  const user = host.env.USERNAME || host.username;
  return host.env.USERDOMAIN ? `${host.env.USERDOMAIN}\\${user}` : user;
}

export const windowsBackend: BackendFactory = (spec, host) => {
  const path = pathsFor(host);
  const serviceDir = path.join(spec.home, "service");
  const launcherPath = path.join(serviceDir, "start-preston.js");
  const taskXmlPath = path.join(serviceDir, "login-task.xml");
  const appData = host.env.APPDATA?.trim() || path.join(host.userHome, "AppData", "Roaming");
  const startupPath = path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    `${spec.ids.task}.cmd`,
  );
  const schtasks = (...args: string[]) => host.run("schtasks", args);

  return {
    async installed(mechanism) {
      if (!host.fs.exists(launcherPath)) return false;
      if (mechanism === "startup-folder") return host.fs.exists(startupPath);
      return (await schtasks("/Query", "/TN", spec.ids.task)).code === 0;
    },
    async register() {
      host.fs.write(launcherPath, launcherScript(spec));
      host.fs.write(taskXmlPath, utf16(scheduledTaskXml(spec, userId(host), launcherPath)));
      const created = await schtasks("/Create", "/TN", spec.ids.task, "/XML", taskXmlPath, "/F");
      if (created.code === 0) {
        host.fs.remove(startupPath);
        return { registered: true, mechanism: "scheduled-task" };
      }
      // Some managed computers forbid scheduled tasks; the Startup folder needs no permission.
      host.fs.write(startupPath, startupScript(launcherPath));
      return {
        registered: true,
        mechanism: "startup-folder",
        detail: `${describeFailure("schtasks", created)}; using the Startup folder instead`,
      };
    },
    async unregister() {
      await schtasks("/Delete", "/TN", spec.ids.task, "/F");
      for (const file of [startupPath, launcherPath, taskXmlPath]) host.fs.remove(file);
    },
  };
};
