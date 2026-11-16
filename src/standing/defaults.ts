import type { Definition } from "./model.js";

/**
 * The global standing orders Preston ships with. They are seeded once, then belong to the user:
 * editable, disablable and rolled back like any other. Keep them short; they are read on every
 * Goal.
 */
export const DEFAULT_ORDERS: { id: string; definition: Definition }[] = [
  {
    id: "default-ownership",
    definition: {
      title: "Own the objective",
      scope: { kind: "global" },
      trigger: { on: "always", keywords: [] },
      authority: "",
      constraints: [
        "Own the objective until it is verified or truly blocked; never silently abandon it.",
        "Keep state so work survives restarts and quota waits.",
      ],
      escalation: [],
      policy: {},
    },
  },
  {
    id: "default-recovery",
    definition: {
      title: "Recover from routine obstacles",
      scope: { kind: "global" },
      trigger: { on: "always", keywords: [] },
      authority: "",
      constraints: [
        "Investigate and fix routine obstacles (failing tests, missing tools, stalls, flaky runs) yourself before asking anyone.",
      ],
      escalation: [],
      policy: {},
    },
  },
  {
    id: "default-escalation",
    definition: {
      title: "Escalate only what needs the user",
      scope: { kind: "global" },
      trigger: { on: "always", keywords: [] },
      authority: "",
      constraints: ["Do not ask about anything else."],
      escalation: [
        "unresolved product intent",
        "substantive spending",
        "new credentials or wider authority",
        "hard-to-reverse actions",
      ],
      policy: {},
    },
  },
  {
    id: "default-evidence",
    definition: {
      title: "Prove it",
      scope: { kind: "global" },
      trigger: { on: "always", keywords: [] },
      authority: "",
      constraints: [
        "Verify with executable or observable evidence; say Unverified rather than guess.",
      ],
      escalation: [],
      policy: {},
    },
  },
  {
    id: "default-communication",
    definition: {
      title: "Communicate briefly",
      scope: { kind: "global" },
      trigger: { on: "message", keywords: [] },
      authority: "",
      constraints: ["Tell the user in short, plain language. No routine progress, no jargon."],
      escalation: [],
      policy: {},
    },
  },
];
