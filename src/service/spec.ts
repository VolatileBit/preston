import type { ServiceHost } from "./host.js";

/** What the login service runs: the same Node and `dist/cli.js` the user installed. */
export interface ServiceSpec {
  /** Preston's home (`PRESTON_HOME`). */
  home: string;
  nodePath: string;
  cliPath: string;
  /** Whether `home` is the default `~/.preston`; other homes get their own service names. */
  defaultHome: boolean;
  /** Names that identify this home's service to the OS service manager. */
  ids: {
    /** launchd label. */
    label: string;
    /** systemd user unit file name. */
    unit: string;
    /** Windows scheduled task name and Startup-folder file stem. */
    task: string;
  };
  /** Environment for the daemon: always `PRESTON_HOME`, plus `PATH` on macOS and Linux. */
  env: Record<string, string>;
  /** Where the daemon's stdout and stderr go, under `<home>/logs`. */
  logFile: string;
}

export type Mechanism =
  | "launchd"
  | "systemd"
  | "xdg-autostart"
  | "scheduled-task"
  | "startup-folder";

export interface Registration {
  registered: boolean;
  mechanism?: Mechanism;
  /** Plain explanation, for the user when registration failed or fell back. */
  detail?: string;
}

export interface Backend {
  /** Whether the artifact registered by `mechanism` is still in place. */
  installed(mechanism: Mechanism): Promise<boolean>;
  register(): Promise<Registration>;
  /** Removes every artifact any mechanism may have created. Best effort. */
  unregister(): Promise<void>;
}

export type BackendFactory = (spec: ServiceSpec, host: ServiceHost) => Backend;

/** Rejects values no service definition format can carry safely. */
export function assertPlain(value: string, what: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we reject.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`The ${what} contains characters a login service can't use: ${value}`);
  }
  return value;
}
