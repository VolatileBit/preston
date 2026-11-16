import { fileURLToPath } from "node:url";
import { ChatChannels } from "./channels/chat.js";
import { ChannelHub, type HostNotifier } from "./channels/hub.js";
import { Outbox } from "./channels/outbox.js";
import { CHAT_CHANNELS, type ChatChannelKind, type ChatChannelSpec } from "./channels/registry.js";
import { Router } from "./channels/router.js";
import type { Channel } from "./channels/types.js";
import { type Clock, systemClock } from "./clock.js";
import { ConfigManager, type ConfigPatch, configSecrets } from "./config/config.js";
import type { Config } from "./config/schema.js";
import { Coordinator } from "./coordinator/coordinator.js";
import { GoalEngine } from "./goals/engine.js";
import { statusText } from "./goals/status.js";
import { type Goal, GoalStore, type Run, type Verification } from "./goals/store.js";
import { ensureHome, type HomePaths, homePaths } from "./home.js";
import { createLogger, type Logger, Redactor } from "./log.js";
import { registerCoordinatorTools } from "./mcp/coordinator-tools.js";
import { describeChannel, registerSetupTools } from "./mcp/setup-tools.js";
import { Tokens, type ToolClient, ToolRegistry } from "./mcp/tools.js";
import { registerWorkerTools } from "./mcp/worker-tools.js";
import { Approvals } from "./policy/escalations.js";
import { type Question, Questions } from "./questions/questions.js";
import { Pairings } from "./setup/pairing.js";
import { Setup } from "./setup/setup.js";
import { type Db, openDatabase } from "./store/db.js";
import { ModelCatalog } from "./workers/models.js";
import { type AdapterFactories, Adapters, BUILTIN_ADAPTERS } from "./workers/registry.js";
import type { McpLaunchSpec } from "./workers/types.js";

export interface RuntimeOptions {
  /** Preston's home directory (see `resolveHome`). */
  home: string;
  clock?: Clock;
  /** Worker adapters by agent kind. Defaults to the built-in adapters. */
  adapters?: AdapterFactories;
  /**
   * Fixed Channels to register (the terminal, or fakes in tests), or a function choosing them
   * from the loaded config. A chat Channel kind registered here is not built from config.
   */
  channels?: Channel[] | ((ctx: { config: Config; log: Logger }) => Channel[]);
  /** The chat Channels built from `config.channels`. Defaults to Discord, Slack and WeChat. */
  chatChannels?: Record<ChatChannelKind, ChatChannelSpec>;
  /** Desktop notifications for Channels (`ChannelContext.notifyHost`). Logged when absent. */
  notifyHost?: HostNotifier;
  /** How agent CLIs launch `preston mcp`; `mcp --token <t>` is appended. */
  mcpCommand?: { command: string; args: string[] };
  /** Config to start from when this home has none yet. */
  initialConfig?: ConfigPatch;
  /** Mirror log lines to stderr. */
  logToStderr?: boolean;
}

/** A running Preston: everything the daemon owns, without the IPC endpoint. */
export interface Runtime {
  readonly paths: HomePaths;
  readonly config: ConfigManager;
  readonly setup: Setup;
  /** Preston's MCP tools, for the IPC proxy (and in-process test agents). */
  readonly tools: ToolClient;
  readonly log: Logger;
  start(): Promise<void>;
  /** Stops all work without changing durable state; the next start recovers it. */
  stop(): Promise<void>;
  goals(): Goal[];
  goal(id: string): Goal | undefined;
  runs(goalId: string): Run[];
  verifications(goalId: string): Verification[];
  openQuestions(): Question[];
  /** The deterministic "status" text. */
  statusText(): string;
}

const DEFAULT_MCP_COMMAND = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./cli.js", import.meta.url))],
};

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const clock = options.clock ?? systemClock;
  const paths = homePaths(options.home);
  ensureHome(paths);
  const redactor = new Redactor();
  const addSecret = (secret: string) => redactor.add(secret);
  let chat: ChatChannels | undefined;
  const log = createLogger({ dir: paths.logs, clock, redactor, mirror: options.logToStderr });
  const db: Db = openDatabase(paths.db);
  const config = new ConfigManager({
    db,
    file: paths.config,
    clock,
    log: log.child("config"),
    initial: options.initialConfig,
    onChange: (c) => {
      for (const secret of configSecrets(c)) redactor.add(secret);
      chat?.onConfigChange(c);
    },
  });

  const tokens = new Tokens((token) => redactor.add(token));
  const tools = new ToolRegistry(tokens, log.child("tools"));
  const mcpCommand = options.mcpCommand ?? DEFAULT_MCP_COMMAND;
  const mcpLaunch = (token: string): McpLaunchSpec => ({
    command: mcpCommand.command,
    args: [...mcpCommand.args, "mcp", "--token", token],
    env: { PRESTON_HOME: paths.root },
  });

  const hub = new ChannelHub(log.child("channels"), clock, options.notifyHost);
  const channels =
    typeof options.channels === "function"
      ? options.channels({ config: config.get(), log: log.child("channels") })
      : (options.channels ?? []);
  for (const channel of channels) hub.register(channel);
  chat = new ChatChannels({
    specs: options.chatChannels ?? CHAT_CHANNELS,
    hub,
    config,
    home: paths.root,
    log: log.child("channels"),
    addSecret,
    fixed: new Set(channels.map((c) => c.kind)),
  });
  chat.init();
  const chatChannels = chat;
  const outbox = new Outbox(db, hub, clock, log.child("outbox"), () => config.get().outbox);
  const store = new GoalStore(db, clock);
  const questions = new Questions({
    db,
    clock,
    outbox,
    hub,
    log: log.child("questions"),
    goalName: (id) => store.findGoal(id)?.brief.objective,
  });
  const adapters = new Adapters(options.adapters ?? BUILTIN_ADAPTERS, {
    home: paths.root,
    clock,
    log: log.child("agents"),
    tools,
  });
  const models = new ModelCatalog({ adapters, clock, log: log.child("models") });
  let approvals: Approvals | undefined;
  const coordinator = new Coordinator({
    adapters,
    config,
    store,
    questions,
    outbox,
    tokens,
    clock,
    log: log.child("coordinator"),
    workdir: paths.coordinator,
    transcriptsDir: paths.transcripts,
    mcpLaunch,
    models,
    approval: (id) => {
      const approval = approvals?.find(id);
      if (!approval) return undefined;
      return { approval, authority: store.findGoal(approval.goalId)?.brief.authority ?? "" };
    },
  });
  approvals = new Approvals({
    db,
    clock,
    questions,
    config,
    log: log.child("approvals"),
    raise: (approval) => coordinator.submit({ kind: "approval", approvalId: approval.id }),
  });
  const escalations = approvals;
  const raiseWorkerQuestion = (question: Question) => {
    const approval = escalations.byQuestion(question.id);
    if (approval) escalations.raise(approval);
    else coordinator.submit({ kind: "worker_question", questionId: question.id });
  };
  const engine = new GoalEngine({
    db,
    store,
    questions,
    outbox,
    config,
    tokens,
    clock,
    log: log.child("goals"),
    transcriptsDir: paths.transcripts,
    adapter: (kind) => adapters.get(kind),
    mcpLaunch,
    raiseWorkerQuestion,
    escalateApproval: (run, action, reason) => escalations.request(run, action, reason),
  });
  registerWorkerTools(tools, {
    engine,
    questions,
    config,
    coordinatorWorkdir: paths.coordinator,
    raiseWorkerQuestion,
  });
  const pairings = new Pairings({
    chat: chatChannels,
    outbox,
    log: log.child("pairing"),
    submit: (input) => coordinator.submit(input),
    addSecret,
  });
  registerCoordinatorTools(tools, {
    engine,
    store,
    questions,
    coordinator,
    config,
    adapters,
    hub,
    chat: chatChannels,
    models,
    approvals: escalations,
  });
  registerSetupTools(tools, {
    chat: chatChannels,
    hub,
    pairings,
    config,
    coordinator,
    adapters,
    models,
    addSecret,
  });

  const status = () => statusText(store.listGoals({ finishedLimit: 5 }), questions.open());
  const router = new Router({
    outbox,
    log: log.child("router"),
    toCoordinator: (message) => coordinator.submit({ kind: "message", message }),
    intercept: (message) => pairings.intercept(message),
    fixed: {
      status,
      stop: () => {
        const stopped = engine.stopAll();
        return stopped.length
          ? `Stopped:\n${stopped.map((g) => `- ${g.brief.objective}`).join("\n")}`
          : "Nothing was running.";
      },
      pause: () => {
        const paused = engine.pauseAll();
        return paused.length
          ? `Paused:\n${paused.map((g) => `- ${g.brief.objective}`).join("\n")}\nSay "resume" to continue.`
          : "Nothing to pause.";
      },
      resume: () => {
        const resumed = engine.resumeAll();
        return resumed.length
          ? `Resumed:\n${resumed.map((g) => `- ${g.brief.objective}`).join("\n")}`
          : "Nothing is paused.";
      },
    },
  });
  hub.onInbound((message) => router.handle(message));
  const setup = new Setup({
    config,
    adapters,
    coordinator,
    channelsNeedingPairing: () =>
      chatChannels
        .kinds()
        .map((kind) => describeChannel({ chat: chatChannels, hub, pairings }, kind))
        .filter(
          (c) => (c.state === "needs_pairing" || c.state === "invalid") && !c.pairingInProgress,
        )
        .map((c) => c.detail),
  });

  let started = false;
  return {
    paths,
    config,
    setup,
    tools,
    log,
    async start() {
      if (started) return;
      started = true;
      log.info("preston starting", { home: paths.root, pid: process.pid });
      await hub.start();
      outbox.start();
      engine.recover();
      escalations.recover();
    },
    async stop() {
      log.info("preston stopping");
      // Both mark themselves stopping synchronously, before parked waits are released.
      pairings.stop();
      const stopping = Promise.all([engine.stop(), coordinator.stop()]);
      questions.releaseWaiters();
      escalations.releaseWaiters();
      await stopping;
      await outbox.stop();
      await chatChannels.idle();
      await hub.stop();
      db.close();
    },
    goals: () => store.listGoals({ finishedLimit: 1000 }),
    goal: (id) => store.findGoal(id),
    runs: (goalId) => store.runsForGoal(goalId),
    verifications: (goalId) => store.verifications(goalId),
    openQuestions: () => questions.open(),
    statusText: status,
  };
}
