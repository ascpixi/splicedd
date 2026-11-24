import assert from "node:assert/strict";
import test from "node:test";
import { createSearchTransport } from "../src/splice/search-transport.ts";

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function bridge() {
  const listeners = new Map();
  const sent = [];
  const events = {
    emit: async (name, payload) => { sent.push({ name, payload }); },
    listen: async (name, handler) => {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    }
  };
  return {
    events, sent, listeners,
    receive: (name, payload) => listeners.get(name)?.({ payload })
  };
}

test("delivery retries stop on acknowledgement while waiting for a slow search", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const b = bridge();
  const result = createSearchTransport(b.events)("search body");
  await flush();
  assert.equal(b.sent.length, 1);
  const { id } = b.sent[0].payload;
  t.mock.timers.tick(1500);
  assert.equal(b.sent.length, 2);
  assert.deepEqual(b.sent[0], b.sent[1]);
  b.receive("splice-search-accepted", { id });
  t.mock.timers.tick(9000);
  assert.equal(b.sent.length, 2);
  b.receive("splice-result", { id: "another-search", ok: true, body: "wrong" });
  assert.equal(b.listeners.size, 2);
  b.receive("splice-result", { id, ok: true, body: "matching result" });
  assert.equal(await result, "matching result");
  assert.equal(b.listeners.size, 0);
});

test("helper errors reject the search and unsubscribe", async () => {
  const b = bridge();
  const result = createSearchTransport(b.events)("{}");
  const rejected = assert.rejects(result, /HTTP 403/);
  await flush();
  b.receive("splice-result", { id: b.sent[0].payload.id, ok: false, error: "HTTP 403" });
  await rejected;
  assert.equal(b.listeners.size, 0);
});

test("listener registration finishing after timeout cannot leak or dispatch a search", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const b = bridge();
  const registrations = [];
  b.events.listen = (name, handler) => new Promise(resolve => {
    registrations.push(() => {
      b.listeners.set(name, handler);
      resolve(() => b.listeners.delete(name));
    });
  });
  const result = createSearchTransport(b.events)("{}");
  const rejected = assert.rejects(result, /timed out/);
  t.mock.timers.tick(20000);
  await rejected;
  registrations.forEach(register => register());
  await flush();
  assert.equal(b.sent.length, 0);
  assert.equal(b.listeners.size, 0);
});

test("IPC delivery and listener registration failures clean up other listeners", async () => {
  for (const failure of ["emit", "listen"]) {
    const b = bridge();
    if (failure === "emit") b.events.emit = async () => { throw new Error("IPC unavailable"); };
    else {
      const listen = b.events.listen;
      b.events.listen = (name, handler) => name === "splice-result"
        ? Promise.reject(new Error("IPC unavailable")) : listen(name, handler);
    }
    await assert.rejects(createSearchTransport(b.events)("{}"), /IPC unavailable/);
    await flush();
    assert.equal(b.listeners.size, 0);
  }
});
