import { isAbsolute, relative, resolve } from "node:path";

/**
 * Preston's deterministic approval policy (ADR 0003). It never reads instructions from the
 * action itself: whatever a Worker, a repository or a web page says, only the action's shape
 * and location decide.
 */

export type PolicyAction =
  | { kind: "read"; paths: string[] }
  | { kind: "write"; paths: string[] }
  | { kind: "command"; command: string; cwd?: string | undefined }
  | { kind: "network"; summary: string }
  | { kind: "preston" }
  | { kind: "other"; summary: string };

export type PolicyDecision =
  | { verdict: "allow" }
  /** Needs a Coordinator decision within the Brief's authority, or the user's. */
  | { verdict: "escalate"; reason: string };

export interface PolicyScope {
  /** The Run's working directory (the Project, or its worktree). */
  workdir: string;
}

const ALLOW: PolicyDecision = { verdict: "allow" };

export function evaluate(action: PolicyAction, scope: PolicyScope): PolicyDecision {
  switch (action.kind) {
    case "preston":
    case "network":
      return ALLOW;
    case "read":
    case "write": {
      const outside = action.paths.find((p) => !isInside(scope.workdir, p, scope.workdir));
      return outside
        ? escalate(
            `it ${action.kind === "read" ? "reads" : "changes"} ${outside}, outside the Project`,
          )
        : ALLOW;
    }
    case "command":
      return evaluateCommand(action.command, action.cwd ?? scope.workdir, scope);
    case "other":
      return escalate(`Preston does not recognise this kind of action (${action.summary})`);
  }
}

interface CommandRule {
  pattern: RegExp;
  reason: string;
}

// Matched against the whole command line, case-insensitively.
const COMMAND_RULES: CommandRule[] = [
  { pattern: /\bgit\s+push\b/, reason: "it publishes commits (git push)" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "it discards work (git reset --hard)" },
  { pattern: /\bgit\s+clean\s+-\w*f/, reason: "it deletes untracked files (git clean)" },
  { pattern: /\bgit\s+branch\s+-D\b/i, reason: "it deletes a branch" },
  { pattern: /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/, reason: "it discards uncommitted edits" },
  { pattern: /\bgit\s+restore\s+(\S+\s+)*\.(\s|$)/, reason: "it discards uncommitted edits" },
  {
    pattern: /\bgit\s+(stash\s+(drop|clear)|filter-branch|filter-repo)\b/,
    reason: "it destroys history or stashed work",
  },
  {
    pattern: /\bgh\s+(pr\s+merge|release|repo\s+(create|delete|edit))\b/,
    reason: "it publishes or changes a hosted repository",
  },
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate)\b/,
    reason: "it publishes a package",
  },
  {
    pattern: /\b(cargo|gem|twine|poetry)\s+(publish|push|upload)\b/,
    reason: "it publishes a package",
  },
  { pattern: /\bdocker\s+push\b/, reason: "it publishes an image" },
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(deploy|release)\b/,
    reason: "it deploys or releases",
  },
  {
    pattern:
      /\b(netlify|firebase|wrangler|flyctl|fly|heroku|serverless|sls|eb)\b(\s+\S+)*\s+(deploy|publish|release|--prod)\b/,
    reason: "it deploys",
  },
  { pattern: /\b(vercel)(\s|$)/, reason: "it deploys" },
  {
    pattern: /\b(kubectl|helm)\s+(apply|install|upgrade|delete)\b/,
    reason: "it changes live infrastructure",
  },
  {
    pattern: /\b(terraform|pulumi)\s+(apply|destroy|up)\b/,
    reason: "it changes live infrastructure",
  },
  {
    pattern: /\b(aws|gcloud|az|doctl|stripe)\s/,
    reason: "it uses a cloud or billing account, which can spend money",
  },
  { pattern: /\b(sudo|doas|su)\s/, reason: "it asks for administrator rights" },
  { pattern: /\b(mkfs|fdisk|diskutil|dd)\s/, reason: "it can destroy disks" },
  {
    pattern: /\b(shutdown|reboot|halt|launchctl|systemctl)\b/,
    reason: "it changes the computer's system services",
  },
  {
    pattern:
      /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|zsh|pwsh|powershell|iex|node|python3?)\b/,
    reason: "it runs code downloaded from the internet",
  },
  { pattern: /\b(drop\s+(table|database)|truncate\s+table)\b/, reason: "it deletes data" },
  {
    pattern: /\b(rd|rmdir)\s+\/s\b|\bdel\s+\/s\b|\bremove-item\b.*-recurse/,
    reason: "it deletes files recursively",
  },
  { pattern: /\bchmod\s+-R\b|\bchown\b/, reason: "it changes ownership or permissions broadly" },
];

const SAFE_ABSOLUTE = [
  /^\/dev\/(null|stdout|stderr|stdin|tty)$/,
  /^\/usr\/(local\/)?bin\//,
  /^\/bin\//,
];

function evaluateCommand(command: string, cwd: string, scope: PolicyScope): PolicyDecision {
  if (!isInside(scope.workdir, cwd, scope.workdir)) {
    return escalate(`it runs in ${cwd}, outside the Project`);
  }
  const normalised = command.replace(/\s+/g, " ").trim();
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(normalised.toLowerCase()) || rule.pattern.test(normalised)) {
      return escalate(rule.reason);
    }
  }
  if (/\brm\s+(-\w*[rR]\w*|--recursive)/.test(normalised)) {
    const targets = normalised
      .split(/\s*(?:&&|\|\||;|\|)\s*/)
      .filter((part) => /^rm\s/.test(part))
      .flatMap((part) =>
        part
          .split(" ")
          .slice(1)
          .filter((t) => !t.startsWith("-")),
      );
    const risky = targets.find((t) => /[*~$]/.test(t) || !isInside(scope.workdir, t, cwd));
    if (risky || targets.length === 0) {
      return escalate(`it deletes ${risky ?? "files"} recursively outside a clear Project path`);
    }
  }
  for (const token of pathTokens(normalised)) {
    if (SAFE_ABSOLUTE.some((p) => p.test(token))) continue;
    if (!isInside(scope.workdir, token, cwd)) {
      return escalate(`it touches ${token}, outside the Project`);
    }
  }
  return ALLOW;
}

/** Absolute and home-relative paths mentioned in a command. */
function pathTokens(command: string): string[] {
  const tokens =
    command.match(
      /(?:^|[\s="'=])((?:~|\$HOME|%USERPROFILE%)[\\/][^\s"';|&]*|\/[^\s"';|&]+|[A-Za-z]:\\[^\s"';|&]*|\.\.(?:[\\/][^\s"';|&]*)?)/g,
    ) ?? [];
  return tokens.map((t) => t.replace(/^[\s="']+/, ""));
}

function isInside(workdir: string, target: string, base: string): boolean {
  if (/^(~|\$HOME|%USERPROFILE%)/.test(target)) return false;
  const absolute = isAbsolute(target) ? resolve(target) : resolve(base, target);
  return isWithin(resolve(workdir), absolute);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  const normalised = process.platform === "win32" ? rel.toLowerCase() : rel;
  return normalised === "" || (!normalised.startsWith("..") && !isAbsolute(normalised));
}

function escalate(reason: string): PolicyDecision {
  return { verdict: "escalate", reason };
}
