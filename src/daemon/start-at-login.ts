/**
 * Seam for registering the daemon to start at login (spec: launchd on macOS, a systemd user
 * unit on Linux, a per-user scheduled task on Windows). Not implemented in this slice: running
 * `preston` starts the daemon on demand instead.
 */
export async function ensureStartAtLogin(): Promise<{ registered: boolean; detail: string }> {
  return { registered: false, detail: "Starting at login is not set up yet." };
}
