import { describeFailure } from "../util/command.js";
import { pathsFor } from "./host.js";
import type { BackendFactory, ServiceSpec } from "./spec.js";

/** `%` starts a systemd specifier and `$` an environment variable reference. */
const systemdEscape = (value: string) => value.replace(/%/g, "%%");
const systemdQuote = (value: string) =>
  `"${systemdEscape(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$")}"`;

/** A systemd user unit; `Restart=on-failure` leaves a daemon that lost the lock race stopped. */
export function systemdUnit(spec: ServiceSpec): string {
  const exec = [spec.nodePath, spec.cliPath, "daemon"].map(systemdQuote).join(" ");
  const env = Object.entries(spec.env)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Preston, a chief of staff for your coding agents

[Service]
Type=simple
ExecStart=${exec}
${env}
WorkingDirectory=${systemdEscape(spec.home)}
Restart=on-failure
RestartSec=30
StandardOutput=append:${systemdEscape(spec.logFile)}
StandardError=append:${systemdEscape(spec.logFile)}

[Install]
WantedBy=default.target
`;
}

/** Desktop Entry `Exec` quoting, then the `\` escaping of the string value itself. */
const desktopQuote = (value: string) =>
  `"${value.replace(/["`$\\]/g, "\\$&").replace(/%/g, "%%")}"`.replace(/\\/g, "\\\\");

/** XDG autostart entry, the fallback for graphical sessions without a systemd user manager. */
export function autostartEntry(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([key, value]) => desktopQuote(`${key}=${value}`));
  const exec = ["env", ...env, ...[spec.nodePath, spec.cliPath].map(desktopQuote), "daemon"];
  return `[Desktop Entry]
Type=Application
Name=Preston
Comment=Starts Preston's background service when you sign in
Exec=${exec.join(" ")}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

export const NO_SERVICE_MANAGER =
  "This system has no service manager Preston can use: systemd user services aren't " +
  "available here, as in WSL or a container.";

export const systemdBackend: BackendFactory = (spec, host) => {
  const path = pathsFor(host);
  const config = host.env.XDG_CONFIG_HOME?.trim() || path.join(host.userHome, ".config");
  const unitPath = path.join(config, "systemd", "user", spec.ids.unit);
  const autostartPath = path.join(
    config,
    "autostart",
    `${spec.ids.unit.replace(/\.service$/, "")}.desktop`,
  );
  const systemctl = (...args: string[]) => host.run("systemctl", ["--user", ...args]);
  const graphical =
    !host.env.WSL_DISTRO_NAME && Boolean(host.env.WAYLAND_DISPLAY || host.env.DISPLAY);

  return {
    installed: async (mechanism) =>
      host.fs.exists(mechanism === "xdg-autostart" ? autostartPath : unitPath),
    async register() {
      const manager = await systemctl("show-environment");
      if (manager.code === 0) {
        host.fs.write(unitPath, systemdUnit(spec));
        const reload = await systemctl("daemon-reload");
        if (reload.code !== 0)
          throw new Error(describeFailure("systemctl --user daemon-reload", reload));
        const enable = await systemctl("enable", "--now", spec.ids.unit);
        if (enable.code !== 0) throw new Error(describeFailure("systemctl --user enable", enable));
        host.fs.remove(autostartPath);
        return { registered: true, mechanism: "systemd" };
      }
      if (graphical) {
        host.fs.write(autostartPath, autostartEntry(spec));
        return {
          registered: true,
          mechanism: "xdg-autostart",
          detail:
            "systemd user services aren't available, so Preston will start when your desktop " +
            "session starts, if your desktop supports autostart.",
        };
      }
      return { registered: false, detail: NO_SERVICE_MANAGER };
    },
    async unregister() {
      if (host.fs.exists(unitPath)) {
        await systemctl("disable", "--now", spec.ids.unit);
        host.fs.remove(unitPath);
        await systemctl("daemon-reload");
      }
      host.fs.remove(autostartPath);
    },
  };
};
