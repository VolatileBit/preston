/**
 * Deterministic, conservative guess at whether merging into the main branch would also publish
 * something publicly: deploy a site, release a build, publish a package. It only ever reads
 * repository files as data; nothing in them can change the verdict except by being what they
 * are. When it cannot tell, it says so, and Preston asks the user.
 */

export interface RepoSnapshot {
  /** Every file path in the repository (forward slashes). */
  paths: string[];
  /** Contents of the files the heuristic reads, by path. */
  files: Map<string, string>;
  /** Branch names (local and remote) that exist. */
  branches: string[];
}

export type PublishingVerdict =
  | { verdict: "none"; reasons: [] }
  | { verdict: "publishes" | "unsure"; reasons: string[] };

/** Paths whose contents the heuristic needs. */
export function isInterestingPath(path: string): boolean {
  return WORKFLOW.test(path) || path === "firebase.json" || path === "package.json";
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;

interface PlatformRule {
  match: RegExp;
  reason: string;
  /** The platform deploys by itself when the main branch changes. */
  automatic: boolean;
}

// Matched against file paths at the top of the repository or one folder down (monorepos).
const PLATFORM_FILES: PlatformRule[] = [
  {
    match: /(^|\/)vercel\.json$|(^|\/)\.vercel\/project\.json$/,
    reason: "the site is set up on Vercel, which publishes it whenever the main branch changes",
    automatic: true,
  },
  {
    match: /(^|\/)netlify\.toml$/,
    reason: "the site is set up on Netlify, which publishes it whenever the main branch changes",
    automatic: true,
  },
  {
    match: /(^|\/)render\.ya?ml$/,
    reason: "the project is set up on Render, which redeploys when the main branch changes",
    automatic: true,
  },
  {
    match: /(^|\/)amplify\.yml$/,
    reason: "the project is set up on AWS Amplify, which redeploys when the main branch changes",
    automatic: true,
  },
  { match: /(^|\/)fly\.toml$/, reason: "the project has a Fly.io setup", automatic: false },
  {
    match: /(^|\/)(Procfile|heroku\.yml|app\.json)$/,
    reason: "the project looks set up for Heroku",
    automatic: false,
  },
  {
    match: /(^|\/)wrangler\.(toml|jsonc?)$/,
    reason: "the project has a Cloudflare setup",
    automatic: false,
  },
  {
    match: /(^|\/)(app\.yaml|serverless\.ya?ml)$/,
    reason: "the project has a cloud deployment setup",
    automatic: false,
  },
  {
    match: /(^|\/)fastlane\/Fastfile$|(^|\/)Fastfile$/,
    reason: "the project has an app store release setup (fastlane)",
    automatic: false,
  },
  {
    match: /(^|\/)(\.releaserc(\.\w+)?|release\.config\.\w+)$/,
    reason: "the project has an automatic release setup",
    automatic: false,
  },
  {
    match: /(^|\/)\.changeset\/config\.json$/,
    reason: "the project uses automatic package releases (changesets)",
    automatic: false,
  },
];

interface PublishWords {
  match: RegExp;
  what: string;
}

const PUBLISH_WORDS: PublishWords[] = [
  {
    match:
      /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|pypa\/gh-action-pypi-publish|\bgem\s+push\b|\bpoetry\s+publish\b/i,
    what: "publishes a package",
  },
  {
    match:
      /actions\/deploy-pages|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy|\bgh-pages\b/i,
    what: "publishes a website",
  },
  {
    match:
      /\b(vercel|netlify|flyctl|wrangler|firebase|heroku|serverless|surge)\b[^\n]*(?:\bdeploy\b|\bpublish\b|--prod\b)|\bfly\s+deploy\b|amondnet\/vercel-action|nwtgck\/actions-netlify/i,
    what: "deploys the site or app",
  },
  {
    match:
      /softprops\/action-gh-release|\bgh\s+release\s+create\b|actions\/create-release|semantic-release|changesets\/action/i,
    what: "publishes a release",
  },
  {
    match: /\bdocker\s+push\b|docker\/build-push-action|\bghcr\.io\b[^\n]*push/i,
    what: "publishes a container image",
  },
  {
    match:
      /fastlane|testflight|app\s*store\s*connect|upload-to-play-store|r0adkll\/upload-google-play/i,
    what: "releases an app build",
  },
  {
    match:
      /\baws\s+s3\s+(sync|cp)\b|\baws\s+cloudfront\b|\baz\s+webapp\b|\bgcloud\s+(app|run|functions)\s+deploy\b|\bkubectl\s+(apply|set\s+image)\b|\bhelm\s+(upgrade|install)\b|\bterraform\s+apply\b/i,
    what: "deploys to a live server",
  },
  { match: /\b(deploy|deployment)\b/i, what: "deploys something" },
];

/** What a merge into `base` would publish, judged from what the repository contains. */
export function detectPublishing(snapshot: RepoSnapshot, base: string): PublishingVerdict {
  const reasons: string[] = [];
  let definite = false;

  for (const rule of PLATFORM_FILES) {
    if (snapshot.paths.some((p) => p.split("/").length <= 2 && rule.match.test(p))) {
      reasons.push(rule.reason);
      if (rule.automatic) definite = true;
    }
  }

  const firebase = snapshot.files.get("firebase.json");
  if (firebase && /"hosting"/.test(firebase)) {
    reasons.push("the site is set up on Firebase Hosting");
  }

  for (const path of snapshot.paths.filter((p) => WORKFLOW.test(p))) {
    const text = snapshot.files.get(path);
    if (text === undefined) continue;
    const trigger = pushTrigger(text, base);
    if (trigger === "no") continue;
    const found = PUBLISH_WORDS.find((w) => w.match.test(text));
    if (!found) continue;
    const name = path.split("/").pop() ?? path;
    reasons.push(`the automation "${name}" ${found.what} when the main branch changes`);
    if (trigger === "yes" && found.what !== "deploys something") definite = true;
  }

  if (snapshot.branches.some((b) => /(^|\/)gh-pages$/.test(b))) {
    reasons.push("the project has a gh-pages branch, which usually means a published website");
  }

  const unique = [...new Set(reasons)];
  if (unique.length === 0) return { verdict: "none", reasons: [] };
  return { verdict: definite ? "publishes" : "unsure", reasons: unique };
}

/** Whether any automation runs checks on pull requests (so a PR will get CI results). */
export function expectsPullRequestChecks(snapshot: RepoSnapshot): boolean {
  return snapshot.paths
    .filter((p) => WORKFLOW.test(p))
    .some((p) => /\bpull_request(_target)?\b/.test(onBlock(snapshot.files.get(p) ?? "")));
}

/**
 * Does a workflow run when `base` is pushed (which a merge does)? "yes", "no", or "maybe" when
 * the trigger is indirect or cannot be read. A workflow that only runs on tags, releases,
 * schedules, pull requests or by hand is not triggered by a merge.
 */
export function pushTrigger(text: string, base: string): "yes" | "no" | "maybe" {
  const on = onBlock(text);
  if (!on) return "maybe";
  if (/\bworkflow_run\b/.test(on)) return "maybe";
  const lines = on.split("\n");
  const index = lines.findIndex((l) => /^\s*push\s*:/.test(l));
  // Inline or list forms (`on: push`, `on: [push, pull_request]`, `- push`) carry no filters.
  if (index < 0) return /\bpush\b/.test(on) ? "yes" : "no";
  const indent = indentOf(lines[index] ?? "");
  const section = [lines[index] ?? ""];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== "" && !line.trim().startsWith("#") && indentOf(line) <= indent) break;
    section.push(line);
  }
  const body = section.join("\n");
  const listed = (key: string): string[] | undefined => {
    const match = new RegExp(
      `\\b${key}\\s*:\\s*(\\[[^\\]]*\\]|(?:\\n\\s*-\\s*[^\\n]+)+|[^\\n]+)`,
    ).exec(body);
    if (!match) return undefined;
    return [...(match[1] ?? "").matchAll(/['"]?([\w./*@{}!-]+)['"]?/g)]
      .map((m) => m[1] ?? "")
      .filter((n) => n && n !== "-");
  };
  const matches = (names: string[]) =>
    names.some((n) => n === base || n === "**" || n === "*" || globMatches(n, base));
  const branches = listed("branches");
  if (branches) return matches(branches) ? "yes" : "no";
  const ignored = listed("branches-ignore");
  if (ignored) return matches(ignored) ? "no" : "yes";
  return /\btags\s*:/.test(body) ? "no" : "yes";
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function globMatches(glob: string, name: string): boolean {
  if (!glob.includes("*")) return false;
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${pattern}$`).test(name);
}

/** The text of a workflow's top-level `on:` section (quotes and the YAML `true:` quirk allowed). */
function onBlock(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^(?:on|"on"|'on'|true)\s*:/.test(l));
  if (start < 0) return "";
  const block = [lines[start]?.replace(/^[^:]*:/, "") ?? ""];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !/^\s*#/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}
