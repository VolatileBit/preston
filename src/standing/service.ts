import { isAbsolute, relative, resolve } from "node:path";
import { type Clock, isoNow } from "../clock.js";
import { all, type Db, one, run, transaction } from "../store/db.js";
import { newId } from "../util/ids.js";
import { looksLikeSecret } from "../util/secrets.js";
import { DEFAULT_ORDERS } from "./defaults.js";
import {
  type Definition,
  definitionSchema,
  type EffectivePolicy,
  type OrderContext,
  type OrderVersion,
  type Scope,
  type StandingOrder,
} from "./model.js";

export class StandingOrderError extends Error {}

interface VersionRow {
  order_id: string;
  version: number;
  origin: "default" | "user";
  enabled: number;
  definition: string;
  reason: string;
  created_at: string;
}

const LATEST = `SELECT v.* FROM standing_order_versions v
  WHERE v.version = (SELECT MAX(version) FROM standing_order_versions WHERE order_id = v.order_id)`;

const SPECIFICITY: Record<Scope["kind"], number> = { global: 1, project: 2, schedule: 3 };

/**
 * Persistent policy: small versioned records in SQLite, with history and rollback like config.
 * Orders only govern behaviour. They are rendered as text into the Coordinator's context and
 * Worker guidance when scope matching says they are relevant (no model picks them), and a few
 * typed flags are read by other modules. Nothing here runs a model.
 */
export class StandingOrders {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly settings: () => { tokenBudget: number },
  ) {}

  /** Adds any shipped default that has no record yet. Existing records are never touched. */
  seedDefaults(): void {
    transaction(this.db, () => {
      for (const { id, definition } of DEFAULT_ORDERS) {
        if (this.versions(id).length) continue;
        this.insert(id, 1, "default", true, definition, "shipped default");
      }
    });
  }

  create(input: unknown, reason: string): StandingOrder {
    const definition = this.parse(input);
    const id = newId("so");
    this.insert(id, 1, "user", true, definition, reason);
    return this.get(id);
  }

  /** Applies `patch` over the current definition as a new version. */
  update(
    id: string,
    patch: Record<string, unknown>,
    reason: string,
    enabled?: boolean,
  ): StandingOrder {
    const current = this.get(id);
    const definition = this.parse({ ...current.definition, ...patch });
    this.insert(
      id,
      current.version + 1,
      current.origin,
      enabled ?? current.enabled,
      definition,
      reason,
    );
    return this.get(id);
  }

  disable(id: string, reason: string): StandingOrder {
    const current = this.get(id);
    this.insert(id, current.version + 1, current.origin, false, current.definition, reason);
    return this.get(id);
  }

  /** Restores an earlier version by recording it again as the newest. */
  rollback(id: string, version: number): StandingOrder {
    const current = this.get(id);
    const target = this.versions(id).find((v) => v.version === version);
    if (!target) throw new StandingOrderError(`Standing order ${id} has no version ${version}.`);
    this.insert(
      id,
      current.version + 1,
      current.origin,
      target.enabled,
      target.definition,
      `rolled back to version ${version}`,
    );
    return this.get(id);
  }

  find(id: string): StandingOrder | undefined {
    const row = one<VersionRow>(this.db, `${LATEST} AND v.order_id = :id`, { id });
    return row ? toOrder(row) : undefined;
  }

  get(id: string): StandingOrder {
    const order = this.find(id);
    if (!order) throw new StandingOrderError(`There is no standing order ${id}.`);
    return order;
  }

  list(options: { includeDisabled?: boolean } = {}): StandingOrder[] {
    const rows = all<VersionRow>(this.db, `${LATEST} ORDER BY v.created_at, v.rowid`);
    return rows.map(toOrder).filter((o) => options.includeDisabled || o.enabled);
  }

  versions(id: string): OrderVersion[] {
    return all<VersionRow>(
      this.db,
      "SELECT * FROM standing_order_versions WHERE order_id = :id ORDER BY version DESC",
      { id },
    ).map((r) => ({
      version: r.version,
      enabled: r.enabled === 1,
      reason: r.reason,
      createdAt: r.created_at,
      definition: JSON.parse(r.definition) as Definition,
    }));
  }

  /** Enabled orders that apply in `context`, most specific first. Deterministic. */
  applicable(context: OrderContext): StandingOrder[] {
    const text = (context.text ?? "").toLowerCase();
    return this.list()
      .filter((order) => {
        const { scope, trigger } = order.definition;
        if (!scopeMatches(scope, context)) return false;
        if (context.audience === "coordinator") {
          if (trigger.on !== "always" && trigger.on !== "message") return false;
          return trigger.keywords.length === 0;
        }
        if (trigger.on === "message") return false;
        if (trigger.on === "schedule" && !context.scheduleId) return false;
        if (trigger.keywords.length === 0) return true;
        return trigger.keywords.some((k) => text.includes(k.toLowerCase()));
      })
      .sort(
        (a, b) =>
          SPECIFICITY[b.definition.scope.kind] - SPECIFICITY[a.definition.scope.kind] ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
  }

  /**
   * The applicable orders as compact text, within the token budget (about four characters per
   * token). Most specific orders are kept first; the result lists global ones first so the
   * specific ones read as the last word. Empty when nothing applies.
   */
  render(context: OrderContext): string {
    const budget = Math.max(0, this.settings().tokenBudget) * 4;
    const kept: string[] = [];
    let used = 0;
    let dropped = 0;
    for (const order of this.applicable(context)) {
      const text = renderOrder(order);
      if (used + text.length > budget) {
        dropped++;
        continue;
      }
      kept.push(text);
      used += text.length;
    }
    if (!kept.length) return "";
    kept.reverse();
    const heading =
      "Standing orders from the user (how they want you to work; the Brief still sets this Goal's scope):";
    const more = dropped ? `\n(${dropped} more not shown; use standing_order_list.)` : "";
    return `${heading}\n${kept.join("\n")}${more}`;
  }

  /** The flags in force for a Goal or Project: the most specific enabled order that sets each. */
  effectivePolicy(scope: { projectPath?: string; scheduleId?: string } = {}): EffectivePolicy {
    const policy: EffectivePolicy = { landing: { autoMergePublishing: false } };
    const orders = this.list()
      .filter((o) => scopeMatches(o.definition.scope, scope))
      .sort(
        (a, b) =>
          SPECIFICITY[a.definition.scope.kind] - SPECIFICITY[b.definition.scope.kind] ||
          a.updatedAt.localeCompare(b.updatedAt),
      );
    for (const order of orders) {
      const flag = order.definition.policy["landing.autoMergePublishing"];
      if (flag !== undefined) policy.landing.autoMergePublishing = flag;
    }
    return policy;
  }

  private parse(input: unknown): Definition {
    const parsed = definitionSchema.safeParse(input);
    if (!parsed.success) {
      throw new StandingOrderError(
        parsed.error.issues.map((i) => `${i.path.join(".") || "order"}: ${i.message}`).join("; "),
      );
    }
    const def = parsed.data;
    if (def.scope.kind === "project") {
      if (!isAbsolute(def.scope.path)) {
        throw new StandingOrderError("A project scope needs an absolute folder path.");
      }
      def.scope = { kind: "project", path: resolve(def.scope.path) };
    }
    const everything = [def.title, def.authority, ...def.constraints, ...def.escalation].join("\n");
    if (looksLikeSecret(everything)) {
      throw new StandingOrderError(
        "That looks like it contains a password or access key, so I did not save it. Credentials never go into standing orders.",
      );
    }
    return def;
  }

  private insert(
    id: string,
    version: number,
    origin: "default" | "user",
    enabled: boolean,
    definition: Definition,
    reason: string,
  ): void {
    run(
      this.db,
      `INSERT INTO standing_order_versions (order_id, version, origin, enabled, definition, reason, created_at)
       VALUES (:id, :version, :origin, :enabled, :definition, :reason, :at)`,
      {
        id,
        version,
        origin,
        enabled: enabled ? 1 : 0,
        definition: JSON.stringify(definition),
        reason,
        at: isoNow(this.clock),
      },
    );
  }
}

function toOrder(row: VersionRow): StandingOrder {
  return {
    id: row.order_id,
    version: row.version,
    enabled: row.enabled === 1,
    origin: row.origin,
    definition: JSON.parse(row.definition) as Definition,
    reason: row.reason,
    updatedAt: row.created_at,
  };
}

function scopeMatches(
  scope: Scope,
  context: { projectPath?: string | undefined; scheduleId?: string | undefined },
): boolean {
  switch (scope.kind) {
    case "global":
      return true;
    case "schedule":
      return context.scheduleId === scope.scheduleId;
    case "project": {
      if (!context.projectPath) return false;
      const rel = relative(resolve(scope.path), resolve(context.projectPath));
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    }
  }
}

/** One short paragraph per order. */
export function renderOrder(order: StandingOrder): string {
  const d = order.definition;
  const where =
    d.scope.kind === "project"
      ? ` [${d.scope.path}]`
      : d.scope.kind === "schedule"
        ? ` [schedule ${d.scope.scheduleId}]`
        : "";
  const parts = [`- ${d.title}${where}.`];
  if (d.authority) parts.push(`May do without asking: ${d.authority}`);
  if (d.constraints.length) parts.push(d.constraints.join(" "));
  if (d.escalation.length) parts.push(`Ask the user only for: ${d.escalation.join("; ")}.`);
  const flags = Object.entries(d.policy).filter(([, v]) => v !== undefined);
  if (flags.length) parts.push(`(${flags.map(([k, v]) => `${k}=${v}`).join(", ")})`);
  return parts.join(" ");
}
