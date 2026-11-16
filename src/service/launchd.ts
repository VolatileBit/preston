import { describeFailure } from "../util/command.js";
import { pathsFor } from "./host.js";
import type { BackendFactory, ServiceSpec } from "./spec.js";

const xml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * A per-user LaunchAgent. It runs at login (`RunAtLoad`) and is restarted only if it crashes, so
 * a daemon that exits because another instance already holds the lock stays stopped.
 */
export function launchAgentPlist(spec: ServiceSpec): string {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  const env = Object.entries(spec.env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    ${string(value)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(spec.ids.label)}
  <key>ProgramArguments</key>
  <array>
    ${[spec.nodePath, spec.cliPath, "daemon"].map(string).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>WorkingDirectory</key>
  ${string(spec.home)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  ${string(spec.logFile)}
  <key>StandardErrorPath</key>
  ${string(spec.logFile)}
</dict>
</plist>
`;
}

export const launchdBackend: BackendFactory = (spec, host) => {
  const plistPath = pathsFor(host).join(
    host.userHome,
    "Library",
    "LaunchAgents",
    `${spec.ids.label}.plist`,
  );
  const domain = `gui/${host.uid ?? ""}`;
  const target = `${domain}/${spec.ids.label}`;
  const launchctl = (...args: string[]) => host.run("launchctl", args);

  return {
    installed: async () => host.fs.exists(plistPath),
    async register() {
      const previous = host.fs.exists(plistPath);
      host.fs.write(plistPath, launchAgentPlist(spec));
      // Reload so launchd runs the new definition now (stopping a daemon it started from the
      // old one); the plist alone is what makes it start at the next login.
      if (previous) await launchctl("bootout", target);
      await launchctl("enable", target);
      let loaded = await launchctl("bootstrap", domain, plistPath);
      if (loaded.code !== 0) {
        // bootout finishes asynchronously; a quick retry covers "operation in progress".
        await host.sleep(1_000);
        loaded = await launchctl("bootstrap", domain, plistPath);
      }
      return {
        registered: true,
        mechanism: "launchd",
        // Without a graphical session (for example over SSH) loading fails, but the agent is in
        // place and launchd loads it at the next login.
        detail: loaded.code === 0 ? undefined : describeFailure("launchctl bootstrap", loaded),
      };
    },
    async unregister() {
      await launchctl("bootout", target);
      host.fs.remove(plistPath);
    },
  };
};
