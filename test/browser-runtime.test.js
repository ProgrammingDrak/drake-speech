import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSpeechToTextRuntime, SpeechRuntimeError } from "../browser/index.js";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

class FakeEngine {
  streamEvents = [];
  resetCount = 0;
  async load(progress) { progress?.({ file: "model", phase: "download", loaded: 1, total: 1, fraction: 1 }); }
  reset() { this.resetCount += 1; this.streamEvents = []; }
  async push() { return "To be"; }
  async finish() { return "To be or not to be"; }
  async dispose() {}
}

test("prepares once and rejects concurrent sessions", async () => {
  const engine = new FakeEngine();
  const runtime = new BrowserSpeechToTextRuntime({ supported: true, storage: new MemoryStorage(), engineFactory: () => engine });
  await runtime.prepare();
  assert.equal(runtime.status().ready, true);
  const session = runtime.createSession({ inputMode: "pcm" });
  assert.throws(() => runtime.createSession({ inputMode: "pcm" }), (error) => {
    assert.ok(error instanceof SpeechRuntimeError);
    assert.equal(error.code, "busy");
    return true;
  });
  await session.cancel();
  const next = runtime.createSession({ inputMode: "pcm" });
  await next.cancel();
});

test("emits cumulative partial and final transcripts", async () => {
  const runtime = new BrowserSpeechToTextRuntime({ supported: true, storage: new MemoryStorage(), engineFactory: () => new FakeEngine() });
  await runtime.prepare();
  const session = runtime.createSession({ inputMode: "pcm", activityThreshold: 0 });
  const events = [];
  session.on("partial", ({ text }) => events.push(["partial", text]));
  session.on("final", ({ text }) => events.push(["final", text]));
  await session.start();
  await session.push(new Float32Array([0.25, -0.25]));
  await session.stop();
  assert.deepEqual(events, [
    ["partial", "To be"],
    ["final", "To be or not to be"]
  ]);
});

test("cancel does not emit a final transcript", async () => {
  const runtime = new BrowserSpeechToTextRuntime({ supported: true, storage: new MemoryStorage(), engineFactory: () => new FakeEngine() });
  await runtime.prepare();
  const session = runtime.createSession({ inputMode: "pcm" });
  let finalCount = 0;
  session.on("final", () => finalCount += 1);
  await session.start();
  await session.cancel();
  assert.equal(finalCount, 0);
});

test("finalizes when Parakeet emits an endpoint", async () => {
  class EndpointEngine extends FakeEngine {
    async push() {
      this.streamEvents = [{ type: "eou", time: 1.2 }];
      return "Friends Romans countrymen";
    }
    async finish() { return "Friends Romans countrymen"; }
  }
  const runtime = new BrowserSpeechToTextRuntime({ supported: true, storage: new MemoryStorage(), engineFactory: () => new EndpointEngine() });
  await runtime.prepare();
  const session = runtime.createSession({ inputMode: "pcm" });
  const final = new Promise((resolve) => session.on("final", ({ text }) => resolve(text)));
  await session.start();
  await session.push(new Float32Array([0.2, -0.2]));
  assert.equal(await final, "Friends Romans countrymen");
});

test("ends a silent session after its lead-in timeout", async () => {
  const runtime = new BrowserSpeechToTextRuntime({ supported: true, storage: new MemoryStorage(), engineFactory: () => new FakeEngine() });
  await runtime.prepare();
  const session = runtime.createSession({ inputMode: "pcm", leadInTimeoutMs: 10, pollIntervalMs: 5 });
  const reason = new Promise((resolve) => session.on("silence", ({ reason }) => resolve(reason)));
  await session.start();
  assert.equal(await reason, "lead-in");
});
