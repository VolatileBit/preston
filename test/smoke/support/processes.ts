import { execFileSync } from "node:child_process";

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** A snapshot of the machine's process table (`ps`). */
export function processTable(): ProcessRow[] {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match)
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
  }
  return rows;
}

/** `root` and every process below it in `table`. */
export function treeOf(root: number, table: ProcessRow[] = processTable()): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of table) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const found: ProcessRow[] = [];
  const seen = new Set<number>();
  const visit = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const self = table.find((r) => r.pid === pid);
    if (self) found.push(self);
    for (const child of byParent.get(pid) ?? []) visit(child.pid);
  };
  visit(root);
  return found;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers signal 0; the process table shows its state.
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return state !== "" && !state.startsWith("Z");
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
