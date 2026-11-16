import { createHash } from "node:crypto";
import { errorMessage } from "../log.js";
import { pathsFor, type ServiceHost, systemServiceHost } from "./host.js";
import { launchdBackend } from "./launchd.js";
import {
  assertPlain,
  type BackendFactory,
  type Mechanism,
  type Registration,
  type ServiceSpec,
} from "./spec.js";
import { systemdBackend } from "./systemd.js";
import { windowsBackend } from "./windows.js";

export type { ServiceFs, ServiceHost } from "./host.js";
export type { Mechanism } from "./spec.js";

/** Bump when the generated definitions change, so existing registrations are rewritten. */
const DEFINITION_VERSION = 1;

const BACKENDS: Partial<Record<NodeJS.Platform, BackendFactory>> = {
  darwin: launchdBackend,
  linux: systemdBackend,
  win32: windowsBackend,
};

export interface ServiceTarget {
  /** Preston's home, already resolved (see `resolveHome`). */
  home: string;
  /** The installed `dist/cli.js`, as an absolute, symlink-free path. */
  cliPath: string;
  /** The Node executable. Defaults to the one running now. */
  nodePath?: string;
}

export interface StartAtLoginResult {
  registered: boolean;
  mechanism?: Mechanism;
  /** Whether this call (re)wrote the registration. */
  changed: boolean;
  /** Something the user should be told, in plain words, if anything. */
  notice?: string;
  /** Technical detail for diagnostics, such as a fallback's reason. */
  detail?: string;
}

interface ServiceState {
  /** Identifies what was registered: definition version, Node, entrypoint and home. */
  key?: string;
  mechanism?: Mechanism;
  /** The last failure explained to the user, so it is not repeated on every run. */
  failure?: string;
}

const NOT_REGISTERED_SUFFIX =
  "Preston is running now, but it won't start by itself the next time you sign in; " +
  "run `preston` then to start it.";

/**
 * Makes sure Preston's daemon is registered to start at login with the Node and entrypoint the
 * user runs now, re-registering when either changed (for example after a Node upgrade through
 * nvm, Volta or fnm). Idempotent and never throws: a failure only means Preston does not start
 * at the next login, so it is explained, not raised.
 */
export async function ensureStartAtLogin(
  target: ServiceTarget,
  host: ServiceHost = systemServiceHost(),
): Promise<StartAtLoginResult> {
  const statePath = pathsFor(host).join(target.home, "service.json");
  const state = readState(host, statePath);
  try {
    const spec = serviceSpec(target, host);
    const backend = backendFor(spec, host);
    const key = specKey(spec, host);
    if (state.key === key && state.mechanism && (await backend.installed(state.mechanism))) {
      return { registered: true, mechanism: state.mechanism, changed: false };
    }
    const result: Registration = await backend.register();
    if (result.registered) {
      writeState(host, statePath, { key, mechanism: result.mechanism });
      const firstTime = !state.mechanism;
      return {
        registered: true,
        mechanism: result.mechanism,
        changed: true,
        detail: result.detail,
        notice: firstTime
          ? result.mechanism === "xdg-autostart"
            ? result.detail
            : "Preston will start by itself when you sign in to this computer."
          : undefined,
      };
    }
    return failed(host, statePath, state, result.detail ?? "Starting at login isn't supported.");
  } catch (err) {
    return failed(
      host,
      statePath,
      state,
      `I couldn't set Preston to start when you sign in: ${errorMessage(err).replace(/\.$/, "")}.`,
    );
  }
}

/** Removes the login registration for this home (for a future uninstall). Never throws. */
export async function removeStartAtLogin(
  target: ServiceTarget,
  host: ServiceHost = systemServiceHost(),
): Promise<void> {
  const attempt = async (step: () => unknown) => {
    try {
      await step();
    } catch {
      // Best effort: nothing to undo, or the service manager is unavailable.
    }
  };
  await attempt(() => backendFor(serviceSpec(target, host), host).unregister());
  await attempt(() => host.fs.remove(pathsFor(host).join(target.home, "service.json")));
}

function failed(
  host: ServiceHost,
  statePath: string,
  state: ServiceState,
  detail: string,
): StartAtLoginResult {
  const notice = `${detail} ${NOT_REGISTERED_SUFFIX}`;
  try {
    writeState(host, statePath, { failure: notice });
  } catch {
    // The notice is still shown; it may just be shown again next time.
  }
  return {
    registered: false,
    changed: false,
    notice: state.failure === notice ? undefined : notice,
  };
}

export function serviceSpec(target: ServiceTarget, host: ServiceHost): ServiceSpec {
  const path = pathsFor(host);
  const nodePath = assertPlain(target.nodePath ?? process.execPath, "Node path");
  const cliPath = assertPlain(target.cliPath, "Preston path");
  const home = assertPlain(target.home, "Preston home");
  const defaultHome = home === path.join(host.userHome, ".preston");
  const suffix = defaultHome
    ? ""
    : `-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
  const env: Record<string, string> = { PRESTON_HOME: home };
  if (host.platform !== "win32") env.PATH = servicePath(host, path.dirname(nodePath));
  return {
    home,
    nodePath,
    cliPath,
    defaultHome,
    ids: {
      label: `ai.polyweave.preston${suffix.replace("-", ".")}`,
      unit: `preston${suffix}.service`,
      task: `Preston${suffix}`,
    },
    env,
    logFile: path.join(home, "logs", "daemon.out"),
  };
}

/**
 * launchd and systemd start services with a minimal PATH, but the daemon runs `claude` and
 * `codex`, whose launchers need `node`. Use the user's PATH with this Node's directory first.
 */
function servicePath(host: ServiceHost, nodeDir: string): string {
  const entries = (host.env.PATH ?? "").split(":").filter((entry) => entry && entry !== nodeDir);
  const fallback = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return assertPlain([nodeDir, ...(entries.length ? entries : fallback)].join(":"), "PATH");
}

/** PATH is left out on purpose: shells differ, and re-registering on each would churn. */
function specKey(spec: ServiceSpec, host: ServiceHost): string {
  return createHash("sha256")
    .update(
      JSON.stringify([DEFINITION_VERSION, host.platform, spec.nodePath, spec.cliPath, spec.home]),
    )
    .digest("hex")
    .slice(0, 16);
}

function backendFor(spec: ServiceSpec, host: ServiceHost) {
  const factory = BACKENDS[host.platform];
  if (!factory) throw new Error(`there is no login service support for ${host.platform}`);
  return factory(spec, host);
}

function readState(host: ServiceHost, path: string): ServiceState {
  try {
    const text = host.fs.read(path);
    return text ? (JSON.parse(text) as ServiceState) : {};
  } catch {
    return {};
  }
}

function writeState(host: ServiceHost, path: string, state: ServiceState): void {
  host.fs.write(path, `${JSON.stringify(state, null, 2)}\n`);
}
