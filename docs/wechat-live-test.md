# WeChat live test

A human-run test on a real WeChat account. It measures what the automated suite can't: how long after the owner's last message unprompted ("proactive") sends still work, how many fit in that window, and how long a login lasts. The results may change WeChat messaging defaults (spec: Testing Decisions, Human-Only Work). They don't decide whether WeChat ships.

Community reports (unverified, 2026-11-16) suggest a window of about 24 hours, about 10 sends per window, and that a refusal shows up as `ret=-2` or HTTP 429. The Channel currently treats `-2` and 429 as "limit reached", and `-14` as "login lost".

## Setup

- A personal WeChat account with ClawBot access, on a phone you can keep with you for two days. A spare account is best.
- The host stays awake for the whole test (macOS: `caffeinate -i`, or the OS power settings).
- Stop any running Preston daemon that uses this WeChat pairing. Two pollers on one bot token split the inbound messages between them.
- Run `npm run build` in the repository, then save the harness below **outside the repository** as `wechat-live.mjs`, and point the import at your checkout. It keeps the pairing in `wechat-live.json` (mode 0600, holds the bot token: delete it afterwards) and appends every event to `wechat-live.log`.

```js
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createWeChatChannel } from "/path/to/preston/dist/channels/wechat/index.js";

const STATE = "wechat-live.json";
const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (patch) => writeFileSync(STATE, JSON.stringify({ ...load(), ...patch }), { mode: 0o600 });
const record = (event, data = {}) => {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  appendFileSync("wechat-live.log", `${line}\n`);
  console.log(line);
};
// Records the raw sendmessage reply (ret, errmsg, HTTP status) for each send.
const fetchAndRecord = async (url, init) => {
  const res = await fetch(url, init);
  if (String(url).includes("sendmessage")) {
    record("sendmessage", { http: res.status, body: (await res.clone().text()).slice(0, 300) });
  }
  return res;
};
const channel = createWeChatChannel(load(), { fetch: fetchAndRecord, persist: async (p) => save(p) });
const [cmd, ...words] = process.argv.slice(2);

if (cmd === "pair") {
  const r = await channel.pair({ show: (t) => console.log(t), signal: AbortSignal.timeout(600_000) });
  if (r.configPatch) save(r.configPatch);
  record("pair", { ok: r.ok, detail: r.detail });
} else if (cmd === "listen") {
  await channel.start({
    onMessage: (m) => record("inbound", { isOwner: m.isOwner, text: m.text }),
    setStatus: (status, detail) => record("status", { status, detail }),
    notifyHost: (text) => record("notify", { text }),
    log: (level, message) => level !== "debug" && record("log", { level, message }),
  });
  process.on("SIGINT", () => channel.stop().then(() => process.exit(0)));
} else if (cmd === "send") {
  record("send", await channel.send({ text: words.join(" ") || "probe", kind: "notice" }));
}
```

For each send, check on the phone whether the message actually arrived. `ret=0` doesn't prove delivery.

## Procedure

1. **Pair (day 1, morning).** Run `node wechat-live.mjs pair` and scan. Note the time. Start `node wechat-live.mjs listen` in its own terminal and leave it running for the whole test. It stores the owner's context token whenever you write from the phone.
2. **Per-window cap.** From the phone, send "hi". Then run
   `for i in $(seq 1 15); do node wechat-live.mjs send "cap probe $i"; sleep 60; done`.
   Record how many probes arrived, and the first refusal's `ret`, `errmsg` and HTTP status. Then send "hi" again, run one more probe, and record whether the count reset.
3. **Proactive window.** Wait at least an hour after step 2 (or until the next day). Then send "hi" from the phone, note the time, and don't write to the bot again until this step ends. Run probes at fixed offsets from that message, in minutes (9 probes, fewer than the reported cap; use fewer if step 2 measured a lower cap):
   `prev=0; for m in 60 360 720 1080 1320 1410 1470 1560 1800; do sleep $(( (m - prev) * 60 )); prev=$m; node wechat-live.mjs send "window probe +${m}m"; done`.
   Record which probes arrived. The window ends between the last one that arrived and the first one that didn't.
4. **Login lifetime.** Keep `listen` running until day 2 ends (at least 48 hours after pairing). Search `wechat-live.log` for `needs_pairing`, a `notify` event, or `error -14`, and record when they first appear (or "none within N hours"). Also record whether stopping and restarting `listen` keeps working without a new scan.
5. **Clean up.** Stop `listen`, delete `wechat-live.json`, and unbind the ClawBot on the phone if the account was only for testing. Before sharing the log, check it holds no context or bot tokens.

## Results

Fill this in and commit it. If a number changes Channel behaviour, also update the error mapping in `src/channels/wechat/index.ts`.

| Measurement | Result | Evidence (log lines, phone) |
|---|---|---|
| Date, region, WeChat app version | | |
| Proactive sends per window | | |
| Refusal signal (`ret` / `errcode` / HTTP / `errmsg`) | | |
| Does an owner message reset the count? | | |
| Proactive window after the owner's last message | | |
| Refused sends that returned `ret=0` (silently dropped) | | |
| Login lifetime / first `-14` | | |
| Survives a restart without a new scan? | | |
