import { fileURLToPath } from "node:url";
import { ChannelHub } from "./channels/hub.js";
import { Outbox } from "./channels/outbox.js";
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
import { createLogger, type Logger, Redactor } from "./log.js";
import { registerCoordinatorTools } from "./mcp/coordinator-tools.js";
import { Tokens, type ToolClient, ToolRegistry } from "./mcp/tools.js";
import { registerWorkerTools } from "./mcp/worker-tools.js";
import { type Question, Questions } from "./questions/questions.js";
import { QuotaMonitor } from "./quota/monitor.js";
import { type Bucket, QuotaStore } from "./quota/store.js";
import { Setup } from "./setup/setup.js";
import { type Db, openDatabase } from "./store/db.js";
import { ProcessTracker } from "./supervisor/processes.js";
import type { RunHealth } from "./supervisor/stalls.js";
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
  /** Channels to register, or a function choosing them from the loaded config. */
  channels?: Channel[] | ((ctx: { config: Config; log: Logger }) => Channel[]);
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
  /** Quota buckets Preston knows about, and whether each is being monitored. */
  quota(): (Bucket & { monitored: boolean })[];
  /** How the supervisor sees a Run right now. */
  runHealth(runId: string): RunHealth | undefined;
  /** Agent processes recorded for orphan cleanup after a crash. */
  trackedProcesses(): { pid: number; owner: string }[];
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

  const hub = new ChannelHub(log.child("channels"), clock);
  const channels =
    typeof options.channels === "function"
      ? options.channels({ config: config.get(), log: log.child("channels") })
      : (options.channels ?? []);
  for (const channel of channels) hub.register(channel);
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
  // The monitor, engine and Coordinator call each other; the closures resolve after creation.
  let engine: GoalEngine | undefined;
  let coordinator: Coordinator | undefined;
  const quota = new QuotaMonitor({
    store: new QuotaStore(db, clock),
    clock,
    log: log.child("quota"),
    settings: () => config.get().quota,
    adapter: (kind) => adapters.get(kind),
    waitingRuns: (bucket) => store.waitingRuns(bucket).map((r) => r.id),
    resumeRun: (runId, probe) => engine?.resumeFromQuota(runId, probe) ?? false,
    resumeCoordinator: (probe) => coordinator?.resume(probe) ?? false,
    stillBlocked: (bucket) => engine?.reviewWaits(bucket),
  });
  coordinator = new Coordinator({
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
    pendingGoalEvents: () => engine?.pendingGoalEvents() ?? [],
    goalEventHandled: (event) => engine?.goalEventHandled(event),
  });
  const theCoordinator = coordinator;
  const raiseWorkerQuestion = (question: Question) =>
    theCoordinator.submit({ kind: "worker_question", questionId: question.id });
  engine = new GoalEngine({
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
    raiseWorkerQuestion,
    raiseGoalEvent: (event) => theCoordinator.submit({ kind: "goal_event", ...event }),
  });
  const theEngine = engine;
  registerWorkerTools(tools, {
    engine: theEngine,
    questions,
    config,
    coordinatorWorkdir: paths.coordinator,
    raiseWorkerQuestion,
  });
  registerCoordinatorTools(tools, {
    engine: theEngine,
    store,
    questions,
    coordinator: theCoordinator,
    config,
    adapters,
    hub,
    quota,
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
    // Persisted before the Coordinator sees it; marked handled only with the reply.
    toCoordinator: (message) => {
      const inboundId = inbox.record(message);
      if (inboundId === undefined) {
        log.child("router").info("ignored a redelivered message", { channel: message.channel });
        return;
      }
      theCoordinator.submit({ kind: "message", message, inboundId });
    },
    fixed: {
      status,
      stop: () => {
        const stopped = theEngine.stopAll();
        return stopped.length
          ? `Stopped:\n${stopped.map((g) => `- ${g.brief.objective}`).join("\n")}`
          : "Nothing was running.";
      },
      pause: () => {
        const paused = theEngine.pauseAll();
        return paused.length
          ? `Paused:\n${paused.map((g) => `- ${g.brief.objective}`).join("\n")}\nSay "resume" to continue.`
          : "Nothing to pause.";
      },
      resume: () => {
        const resumed = theEngine.resumeAll();
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
  const setup = new Setup({ config, adapters, coordinator: theCoordinator });

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
      theEngine.recover();
      quota.start();
      theCoordinator.resume();
    },
    async stop() {
      log.info("preston stopping");
      quota.stop();
      // Both mark themselves stopping synchronously, before parked waits are released.
      const stopping = Promise.all([theEngine.stop(), theCoordinator.stop()]);
      questions.releaseWaiters();
      await stopping;
      await outbox.stop();
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
    runHealth: (runId) => theEngine.runHealth(runId),
    trackedProcesses: () => processes.tracked(),
  };
}
