import { z } from "zod";
import { ToolError, type ToolRegistry } from "../mcp/tools.js";
import { parseScope, policyFlagsSchema, scopeText, TRIGGERS } from "./model.js";
import { StandingOrderError, type StandingOrders } from "./service.js";

export interface StandingToolDeps {
  standing: StandingOrders;
  /** Throws unless the Coordinator is answering the user. */
  requireOwnerTurn(): void;
}

const orderId = z.string().min(1).describe("Standing order ID, e.g. so-3f9a1c0b2d");
const reason = z.string().min(1).max(200).default("changed in chat");

const fields = {
  title: z.string().min(1).max(80).describe("Short name, e.g. 'Merge routine PRs'"),
  scope: z
    .string()
    .default("global")
    .describe('"global", "project:<absolute folder>" or "schedule:<schedule id>"'),
  trigger: z
    .enum(TRIGGERS)
    .default("always")
    .describe(
      "always: you and every Goal in scope; goal: Workers only; schedule: Goals a schedule starts; message: you, when answering the user",
    ),
  keywords: z
    .array(z.string().min(1))
    .max(10)
    .default([])
    .describe("Only apply to Goals whose objective or scope mentions one of these words"),
  authority: z.string().max(400).default("").describe("What Preston may do without asking"),
  constraints: z.array(z.string().min(1)).max(8).default([]).describe("Rules about how to work"),
  escalation: z
    .array(z.string().min(1))
    .max(8)
    .default([])
    .describe("Situations where Preston must stop and ask the user"),
  policy: policyFlagsSchema
    .default({})
    .describe(
      'Typed flag: "landing.autoMergePublishing" lets a merge that also publishes go ahead without asking. Set only when the user clearly said so.',
    ),
};

/** The Coordinator's tools for persistent policy. */
export function registerStandingTools(registry: ToolRegistry, deps: StandingToolDeps): void {
  const { standing } = deps;
  const roles = ["coordinator"] as const;
  const guarded = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof StandingOrderError) throw new ToolError(err.message);
      throw err;
    }
  };

  registry.add({
    name: "standing_order_create",
    description:
      "Save a standing order: a persistent rule about how Preston works, from the user's own words. Not for one-off outcomes (use a Goal), timed work (use a schedule) or facts about the user (use memory).",
    roles,
    input: z.strictObject(fields),
    handler: (args) => {
      deps.requireOwnerTurn();
      return guarded(() => {
        const order = standing.create(toDefinition(args), "created in chat");
        return summarise(order);
      });
    },
  });

  registry.add({
    name: "standing_order_update",
    description:
      "Change a standing order (recorded as a new version). Only pass the fields that change; set enabled true to turn a disabled order back on.",
    roles,
    input: z.strictObject({
      id: orderId,
      title: fields.title.optional(),
      scope: z.string().optional(),
      trigger: z.enum(TRIGGERS).optional(),
      keywords: fields.keywords.optional(),
      authority: fields.authority.optional(),
      constraints: fields.constraints.optional(),
      escalation: fields.escalation.optional(),
      policy: policyFlagsSchema.optional(),
      enabled: z.boolean().optional(),
      reason,
    }),
    handler: ({ id, enabled, reason: why, ...changes }) => {
      deps.requireOwnerTurn();
      return guarded(() => {
        const current = standing.get(id).definition;
        const patch: Record<string, unknown> = {};
        for (const key of ["title", "authority", "constraints", "escalation", "policy"] as const) {
          if (changes[key] !== undefined) patch[key] = changes[key];
        }
        if (changes.scope !== undefined) patch.scope = parseScopeOrThrow(changes.scope);
        if (changes.trigger !== undefined || changes.keywords !== undefined) {
          patch.trigger = {
            on: changes.trigger ?? current.trigger.on,
            keywords: changes.keywords ?? current.trigger.keywords,
          };
        }
        return summarise(standing.update(id, patch, why, enabled));
      });
    },
  });

  registry.add({
    name: "standing_order_list",
    description:
      "The user's standing orders (the shipped defaults included) and the flags currently in force.",
    roles,
    input: z.strictObject({ includeDisabled: z.boolean().default(false) }),
    handler: ({ includeDisabled }) => ({
      orders: standing.list({ includeDisabled }).map(summarise),
      policy: standing.effectivePolicy(),
    }),
  });

  registry.add({
    name: "standing_order_disable",
    description: "Turn a standing order off without deleting it. It can be turned on again.",
    roles,
    input: z.strictObject({ id: orderId, reason }),
    handler: ({ id, reason: why }) => {
      deps.requireOwnerTurn();
      return guarded(() => summarise(standing.disable(id, why)));
    },
  });

  registry.add({
    name: "standing_order_history",
    description: "Every version of one standing order, newest first.",
    roles,
    input: z.strictObject({ id: orderId }),
    handler: ({ id }) =>
      guarded(() => {
        standing.get(id);
        return {
          versions: standing.versions(id).map((v) => ({
            version: v.version,
            enabled: v.enabled,
            reason: v.reason,
            at: v.createdAt,
            title: v.definition.title,
            scope: scopeText(v.definition.scope),
          })),
        };
      }),
  });

  registry.add({
    name: "standing_order_rollback",
    description: "Restore an earlier version of a standing order (recorded as a new version).",
    roles,
    input: z.strictObject({ id: orderId, version: z.number().int().min(1) }),
    handler: ({ id, version }) => {
      deps.requireOwnerTurn();
      return guarded(() => summarise(standing.rollback(id, version)));
    },
  });
}

function parseScopeOrThrow(text: string) {
  try {
    return parseScope(text);
  } catch (err) {
    throw new ToolError((err as Error).message);
  }
}

function toDefinition(args: {
  title: string;
  scope: string;
  trigger: (typeof TRIGGERS)[number];
  keywords: string[];
  authority: string;
  constraints: string[];
  escalation: string[];
  policy: z.infer<typeof policyFlagsSchema>;
}) {
  return {
    title: args.title,
    scope: parseScopeOrThrow(args.scope),
    trigger: { on: args.trigger, keywords: args.keywords },
    authority: args.authority,
    constraints: args.constraints,
    escalation: args.escalation,
    policy: args.policy,
  };
}

function summarise(order: ReturnType<StandingOrders["get"]>) {
  const d = order.definition;
  return {
    id: order.id,
    version: order.version,
    enabled: order.enabled,
    default: order.origin === "default",
    title: d.title,
    scope: scopeText(d.scope),
    trigger: d.trigger.on,
    keywords: d.trigger.keywords,
    authority: d.authority,
    constraints: d.constraints,
    escalation: d.escalation,
    policy: d.policy,
  };
}
