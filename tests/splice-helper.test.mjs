import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const script = readFileSync(new URL("../src-tauri/src/splice-helper.js", import.meta.url), "utf8");
const backend = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const helperUrl = backend.match(/const SPLICE_HELPER_URL: &str = "([^"]+)"/)[1];
const origin = new URL(helperUrl).origin;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const response = (body = '{"data":{"assetsSearch":{"items":[]}}}', status = 200, challenge = false) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => body,
  headers: { get: name => name === "cf-mitigated" && challenge ? "challenge" : null }
});

function helper(fetch, { internals = false, pageOrigin = origin } = {}) {
  const listeners = new Map();
  const emitted = [];
  const timers = new Map();
  let timerId = 0;
  const event = {
    listen: async (name, handler) => { listeners.set(name, handler); },
    emit: async (name, payload) => { emitted.push({ name, payload }); }
  };
  const window = internals ? {
    __TAURI_INTERNALS__: {
      transformCallback: fn => fn,
      invoke: (command, args) => command === "plugin:event|listen"
        ? event.listen(args.event, args.handler) : event.emit(args.event, args.payload)
    }
  } : { __TAURI__: { event } };
  const context = vm.createContext({
    window, location: { origin: pageOrigin }, URL, AbortController, console, fetch,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(script, context);
  return {
    emitted, listeners,
    send: (id, body = "{}") => listeners.get("splice-search")({ payload: { id, body } }),
    replayInit: () => vm.runInContext(script, context),
    fireTimer: async delay => {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms timer`);
      timers.delete(entry[0]); entry[1].fn(); await flush();
    },
    timerCount: () => timers.size
  };
}

test("searches the API from its own origin through Tauri's internal event bridge", async () => {
  const h = helper(async (url, options) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.method, "POST");
    assert.equal(options.body, '{"query":"kick"}');
    return response();
  }, { internals: true });
  await h.send("request", '{"query":"kick"}');
  assert.equal(h.emitted[0].name, "splice-search-accepted");
  assert.equal(h.emitted.at(-1).payload.ok, true);
  assert.equal(h.timerCount(), 0);
  h.replayInit();
  assert.equal(h.listeners.size, 1);
});

test("duplicate deliveries share one fetch and completed responses can be replayed", async () => {
  let complete;
  let calls = 0;
  const h = helper(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  const first = h.send("same-id");
  await h.send("same-id");
  assert.equal(calls, 1);
  complete(response());
  await first;
  await h.send("same-id");
  assert.equal(calls, 1);
  assert.equal(h.emitted.filter(x => x.name === "splice-search-accepted").length, 3);
  assert.equal(h.emitted.filter(x => x.name === "splice-result").length, 2);
});

test("transient rejections back off while duplicate delivery cannot restart retries", async () => {
  let calls = 0;
  const h = helper(async () => ++calls < 3 ? response("blocked", 403) : response());
  const done = h.send("retry");
  await flush();
  await h.send("retry");
  assert.equal(calls, 1);
  await h.fireTimer(700);
  assert.equal(calls, 2);
  await h.fireTimer(1400);
  await done;
  assert.equal(calls, 3);
  assert.equal(h.emitted.at(-1).payload.ok, true);
});

test("HTTP 400 and HTML responses become errors instead of reaching the UI parser", async () => {
  for (const reply of [response("bad request", 400), response("<html>verification</html>")]) {
    let calls = 0;
    const h = helper(async () => { calls++; return reply; });
    await h.send("invalid");
    assert.equal(calls, 1);
    assert.equal(h.emitted.at(-1).payload.ok, false);
    assert.equal(typeof h.emitted.at(-1).payload.error, "string");
    assert.equal(h.timerCount(), 0);
  }
});

test("a hung fetch is aborted within the frontend's deadline", async () => {
  const h = helper((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const done = h.send("timeout");
  await h.fireTimer(15000);
  await done;
  assert.equal(h.emitted.at(-1).payload.error, "Splice search timed out.");
  assert.equal(h.timerCount(), 0);
});

test("the completed response cache is bounded", async () => {
  let calls = 0;
  const h = helper(async () => { calls++; return response(); });
  for (let i = 0; i < 33; i++) await h.send(String(i));
  await h.send("32");
  assert.equal(calls, 33);
  await h.send("0");
  assert.equal(calls, 34);
});

test("documents outside the API origin do not register an event bridge", () => {
  const h = helper(() => assert.fail("unexpected fetch"), { pageOrigin: "https://splice.com" });
  assert.equal(h.listeners.size, 0);
});
