import { join } from "node:path";
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
import { Inbox } from "./coordinator/inbox.js";
import { GoalEngine } from "./goals/engine.js";
import { type AgentBlock, statusText } from "./goals/status.js";
import { type Goal, GoalStore, type Run, type Verification } from "./goals/store.js";
import { ensureHome, type HomePaths, homePaths } from "./home.js";
import type { Exec } from "./landing/exec.js";
import { createGhClient, type GitHubClient } from "./landing/github.js";
import { Landing } from "./landing/landing.js";
import { registerLandingTools } from "./landing/tools.js";
import { createLogger, type Logger, Redactor } from "./log.js";
import { registerCoordinatorTools } from "./mcp/coordinator-tools.js";
import { ownerTurnGuard } from "./mcp/owner-turn.js";
import { describeChannel, registerSetupTools } from "./mcp/setup-tools.js";
import { Tokens, type ToolClient, ToolRegistry } from "./mcp/tools.js";
import { registerWorkerTools } from "./mcp/worker-tools.js";
import { Memory } from "./memory/service.js";
import { registerMemoryTools } from "./memory/tools.js";
import { Approvals } from "./policy/escalations.js";
import { type Question, Questions } from "./questions/questions.js";
import { QuotaMonitor } from "./quota/monitor.js";
import { type Bucket, QuotaStore } from "./quota/store.js";
import { Scheduler } from "./schedule/service.js";
import { ScheduleStore } from "./schedule/store.js";
import { registerScheduleTools } from "./schedule/tools.js";
import { Pairings } from "./setup/pairing.js";
import { Setup } from "./setup/setup.js";
import { StandingOrders } from "./standing/service.js";
import { registerStandingTools } from "./standing/tools.js";
import { type Db, openDatabase } from "./store/db.js";
import { ProcessTracker } from "./supervisor/processes.js";
import type { RunHealth } from "./supervisor/stalls.js";
import { ModelCatalog } from "./workers/models.js";
import {
  type AdapterFactories,
  Adapters,
  agentLabel,
  BUILTIN_ADAPTERS,
} from "./workers/registry.js";
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
  /** How finished work is landed: the GitHub client (default: the `gh` program) and the runner. */
  landing?: { github?: GitHubClient; exec?: Exec };
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
  /** Quota buckets Preston knows about, and whether each is being monitored. */
  quota(): (Bucket & { monitored: boolean })[];
  /** How the supervisor sees a Run right now. */
  runHealth(runId: string): RunHealth | undefined;
  /** Agent processes recorded for orphan cleanup after a crash. */
  trackedProcesses(): { pid: number; owner: string }[];
  /** Standing orders, including the typed flags other modules read (`effectivePolicy`). */
  readonly standing: StandingOrders;
  readonly schedules: Scheduler;
  readonly memory: Memory;
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
  const processes = new ProcessTracker(db, clock, log.child("processes"));
  const inbox = new Inbox(db, clock);
  const models = new ModelCatalog({ adapters, clock, log: log.child("models") });
  // The monitor, engine and Coordinator call each other; the closures resolve after creation.
  let engineRef: GoalEngine | undefined;
  let coordinatorRef: Coordinator | undefined;
  const quota = new QuotaMonitor({
    store: new QuotaStore(db, clock),
    clock,
    log: log.child("quota"),
    settings: () => config.get().quota,
    adapter: (kind) => adapters.get(kind),
    waitingRuns: (bucket) => store.waitingRuns(bucket).map((r) => r.id),
    resumeRun: (runId, probe) => engineRef?.resumeFromQuota(runId, probe) ?? false,
    resumeCoordinator: (probe) => coordinatorRef?.resume(probe) ?? false,
    stillBlocked: (bucket) => engineRef?.reviewWaits(bucket),
  });
  let approvals: Approvals | undefined;
  const standing = new StandingOrders(db, clock, () => config.get().standing);
  standing.seedDefaults();
  const memory = new Memory({
    dir: join(paths.root, "memory"),
    db,
    clock,
    log: log.child("memory"),
    goals: store,
    isKnownSecret: (text) => redactor.redact(text) !== text,
    settings: () => config.get().memory,
  });
  memory.init();
  const coordinator = new Coordinator({
    db,
    adapters,
    config,
    store,
    questions,
    outbox,
    inbox,
    quota,
    processes,
    tokens,
    clock,
    log: log.child("coordinator"),
    workdir: paths.coordinator,
    transcriptsDir: paths.transcripts,
    mcpLaunch,
    models,
    contextBlocks: () => [standing.render({ audience: "coordinator" }), memory.contextBlock()],
    approval: (id) => {
      const approval = approvals?.find(id);
      if (!approval) return undefined;
      return { approval, authority: store.findGoal(approval.goalId)?.brief.authority ?? "" };
    },
    pendingGoalEvents: () => engineRef?.pendingGoalEvents() ?? [],
    goalEventHandled: (event) => engineRef?.goalEventHandled(event),
  });
  coordinatorRef = coordinator;
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
  const landing = new Landing({
    db,
    clock,
    log: log.child("landing"),
    config,
    goals: store,
    questions,
    worktreesDir: join(paths.root, "worktrees"),
    github: options.landing?.github ?? createGhClient(options.landing?.exec),
    ...(options.landing?.exec ? { exec: options.landing.exec } : {}),
  });
  const scheduleStore = new ScheduleStore(db, clock);
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
    quota,
    processes,
    adapter: (kind) => adapters.get(kind),
    mcpLaunch,
    landing,
    workerContext: (goal) =>
      standing.render({
        audience: "worker",
        projectPath: goal.projectPath,
        scheduleId: scheduleStore.scheduleOfGoal(goal.id),
        text: `${goal.brief.objective}\n${goal.brief.scope}`,
      }),
    raiseWorkerQuestion,
    raiseGoalEvent: (event) => coordinator.submit({ kind: "goal_event", ...event }),
    escalateApproval: (run, action, reason) => escalations.request(run, action, reason),
  });
  engineRef = engine;
  const scheduler = new Scheduler({
    db,
    clock,
    log: log.child("schedule"),
    store: scheduleStore,
    goals: store,
    engine,
    outbox,
    config,
    transcriptsDir: paths.transcripts,
    standingOrderIds: (scope) =>
      standing.applicable({ audience: "worker", ...scope }).map((order) => order.id),
  });
  registerWorkerTools(tools, {
    engine: engine,
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
    quota,
    chat: chatChannels,
    models,
    approvals: escalations,
  });
  registerLandingTools(tools, { landing });
  const requireOwnerTurn = ownerTurnGuard(coordinator);
  registerStandingTools(tools, { standing, requireOwnerTurn });
  registerScheduleTools(tools, { scheduler, coordinator, requireOwnerTurn });
  registerMemoryTools(tools, { memory, coordinator, requireOwnerTurn });
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

  const status = () => {
    const blocks: AgentBlock[] = [];
    for (const agent of adapters.kinds()) {
      const bucket = quota.activeBlock(agent);
      if (bucket) blocks.push({ label: agentLabel(agent), bucket });
    }
    return statusText(store.listGoals({ finishedLimit: 5 }), questions.open(), blocks, clock.now());
  };
  const router = new Router({
    outbox,
    log: log.child("router"),
    // Persisted before the Coordinator sees it; marked handled only with the reply. Messages a
    // pairing intercepts never reach this point, so they are neither queued nor handled twice.
    toCoordinator: (message) => {
      const inboundId = inbox.record(message);
      if (inboundId === undefined) {
        log.child("router").info("ignored a redelivered message", { channel: message.channel });
        return;
      }
      coordinator.submit({ kind: "message", message, inboundId });
    },
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
        const rechecked = quota.recheckForUser().map(agentLabel);
        const lines = resumed.length
          ? [`Resumed:\n${resumed.map((g) => `- ${g.brief.objective}`).join("\n")}`]
          : rechecked.length
            ? []
            : ["Nothing is paused."];
        if (rechecked.length) lines.push(`Checking ${rechecked.join(" and ")} again now.`);
        return lines.join("\n");
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
      // Orphaned agent processes from a crashed daemon go before any Session resumes.
      const orphans = await processes.reconcile();
      if (orphans) log.warn("terminated orphaned agent processes", { count: orphans });
      engine.recover();
      escalations.recover();
      quota.start();
      scheduler.start();
      coordinator.resume();
    },
    async stop() {
      log.info("preston stopping");
      quota.stop();
      await scheduler.stop();
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
    quota: () => quota.list(),
    runHealth: (runId) => engine.runHealth(runId),
    trackedProcesses: () => processes.tracked(),
    standing,
    schedules: scheduler,
    memory,
  };
}
