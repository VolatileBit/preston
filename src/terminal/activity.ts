import { type Language, language } from "../i18n/index.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_MS = 100;
const MESSAGE_MS = 3_200;

const MESSAGES: Record<Language, readonly string[]> = {
  en: [
    "Pondering",
    "Consulting the oracle",
    "Herding the agents",
    "Untangling the plan",
    "Sharpening pencils",
    "Reading the fine print",
    "Warming up the brain",
    "Asking the rubber duck",
    "Connecting the dots",
    "Brewing something good",
    "Dusting off the whiteboard",
    "Counting to infinity",
  ],
  "zh-CN": [
    "思考中",
    "请教神谕中",
    "正在召集小伙伴",
    "整理思路中",
    "削铅笔中",
    "仔细阅读小字",
    "大脑预热中",
    "请教橡皮鸭",
    "连点成线中",
    "酝酿好点子",
    "擦白板中",
    "数到无穷大",
  ],
};

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * Shows that Preston is thinking: a spinner and a rotating, light-hearted message, drawn as the
 * prompt's prefix so what the user is typing stays untouched.
 */
export class ActivityIndicator {
  private handle: unknown;
  private tick = 0;
  private order: number[] = [];

  constructor(
    /** Draws the prompt; an empty prefix is the normal prompt. */
    private readonly draw: (prefix: string) => void,
    private readonly timers: Timers = {
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms);
        handle.unref();
        return handle;
      },
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    },
    private readonly random: () => number = Math.random,
  ) {}

  get running(): boolean {
    return this.handle !== undefined;
  }

  start(): void {
    if (this.handle !== undefined) return;
    this.tick = 0;
    this.order = shuffled(MESSAGES[language()].length, this.random);
    this.render();
    this.handle = this.timers.setInterval(() => {
      this.tick += 1;
      this.render();
    }, FRAME_MS);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.timers.clearInterval(this.handle);
    this.handle = undefined;
    this.draw("");
  }

  private render(): void {
    const messages = MESSAGES[language()];
    const step = Math.floor((this.tick * FRAME_MS) / MESSAGE_MS);
    const index = this.order[step % this.order.length] ?? 0;
    const frame = FRAMES[this.tick % FRAMES.length];
    this.draw(`${frame} ${messages[index % messages.length]}… `);
  }
}

function shuffled(length: number, random: () => number): number[] {
  const order = Array.from({ length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return order;
}
