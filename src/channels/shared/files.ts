import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { errorMessage } from "../../log.js";
import type { OutboundFile } from "../types.js";

/** Files the user sends are kept on this computer only up to this size. */
export const MAX_INBOUND_FILE_BYTES = 100 * 1024 * 1024;

/** A file a chat service says it holds for a message, before it is downloaded. */
export interface IncomingFile {
  name: string;
  url: string;
  size?: number | undefined;
  mimeType?: string | undefined;
}

/** A name that is safe to use in a path: no folders, no control characters. */
export function safeFileName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, "/"))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return (cleaned || "file").slice(0, 120);
}

/** Writes a received file under `<dir>/<date>/<random>-<name>`, readable by the owner only. */
export function saveReceivedFile(dir: string, name: string, data: Uint8Array): string {
  const day = new Date().toISOString().slice(0, 10);
  const folder = join(dir, day);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${randomBytes(3).toString("hex")}-${safeFileName(name)}`);
  writeFileSync(path, data, { mode: 0o600 });
  return path;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Downloads and keeps what a message carries, and describes it for the Coordinator, which cannot
 * open files itself and hands the paths to a Worker. A file that is too big or fails to download
 * is reported rather than dropped silently.
 */
export async function receiveFiles(
  files: readonly IncomingFile[],
  io: {
    download(file: IncomingFile): Promise<Uint8Array>;
    save(name: string, data: Uint8Array): Promise<string>;
    log(message: string, data?: unknown): void;
  },
): Promise<string> {
  const lines: string[] = [];
  for (const file of files) {
    const label = (size: number | undefined) =>
      [file.mimeType, size === undefined ? undefined : formatSize(size)].filter(Boolean).join(", ");
    if (file.size !== undefined && file.size > MAX_INBOUND_FILE_BYTES) {
      lines.push(`- ${file.name} (${label(file.size)}) was too large to keep.`);
      continue;
    }
    try {
      const data = await io.download(file);
      if (data.byteLength > MAX_INBOUND_FILE_BYTES) {
        lines.push(`- ${file.name} (${label(data.byteLength)}) was too large to keep.`);
        continue;
      }
      const path = await io.save(file.name, data);
      lines.push(`- ${path} (${label(data.byteLength)}), sent as "${file.name}"`);
    } catch (error) {
      io.log(`Could not download an attachment: ${errorMessage(error)}`, error);
      lines.push(`- ${file.name} could not be downloaded.`);
    }
  }
  return lines.length
    ? `[Files the user attached, saved on this computer:\n${lines.join("\n")}]`
    : "";
}

/** The message text followed by the attachment description (either may be empty). */
export function withFiles(text: string, filesNote: string): string {
  return [text.trim(), filesNote].filter(Boolean).join("\n\n");
}

export type ReadFiles =
  | { ok: true; files: { name: string; data: Buffer }[] }
  | { ok: false; error: string };

/** Reads outgoing files, refusing any that is missing or over the Channel's limit. */
export function readOutboundFiles(files: readonly OutboundFile[], maxBytes: number): ReadFiles {
  const out: { name: string; data: Buffer }[] = [];
  for (const file of files) {
    try {
      const size = statSync(file.path).size;
      if (size > maxBytes) {
        return {
          ok: false,
          error: `${file.name} is ${formatSize(size)}, over the ${formatSize(maxBytes)} limit.`,
        };
      }
      out.push({ name: file.name, data: readFileSync(file.path) });
    } catch (error) {
      return { ok: false, error: `Can't read ${file.name}: ${errorMessage(error)}` };
    }
  }
  return { ok: true, files: out };
}
