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

test("cancel wins a race with stop finalization", async () => {
  let releaseFinish;
  class SlowFinishEngine extends FakeEngine {
    async finish() {
      return new Promise((resolve) => { releaseFinish = () => resolve("Too late"); });
    }
  }
  const engine = new SlowFinishEngine();
  const runtime = new BrowserSpeechToTextRuntime({ supported: true, storage: new MemoryStorage(), engineFactory: () => engine });
  await runtime.prepare();
  const session = runtime.createSession({ inputMode: "pcm" });
  const resetCountBeforeSession = engine.resetCount;
  let finalCount = 0;
  session.on("final", () => finalCount += 1);
  await session.start();
  const stopping = session.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const cancelling = session.cancel();
  releaseFinish();
  await Promise.all([stopping, cancelling]);
  assert.equal(finalCount, 0);
  assert.equal(engine.resetCount, resetCountBeforeSession + 1);
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

test("keeps timeout defaults when an adapter passes undefined", async () => {
  const runtime = new BrowserSpeechToTextRuntime({ supported: true, storage: new MemoryStorage(), engineFactory: () => new FakeEngine() });
  await runtime.prepare();
  const session = runtime.createSession({ inputMode: "pcm", leadInTimeoutMs: undefined, pollIntervalMs: 1 });
  let silenceCount = 0;
  session.on("silence", () => silenceCount += 1);
  await session.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(silenceCount, 0);
  await session.cancel();
});

test("stop drains queued audio and finalizes once", async () => {
  let releasePush;
  class SlowEngine extends FakeEngine {
    pushes = 0;
    async push() {
      this.pushes += 1;
      await new Promise((resolve) => { releasePush = resolve; });
      return "To be";
    }
  }
  const engine = new SlowEngine();
  const runtime = new BrowserSpeechToTextRuntime({ supported: true, storage: new MemoryStorage(), engineFactory: () => engine });
  await runtime.prepare();
  const session = runtime.createSession({ inputMode: "pcm" });
  let finals = 0;
  session.on("final", () => finals += 1);
  await session.start();
  const pushing = session.push(new Float32Array([0.25, -0.25]));
  await new Promise((resolve) => setImmediate(resolve));
  const firstStop = session.stop();
  const secondStop = session.stop();
  releasePush();
  await Promise.all([pushing, firstStop, secondStop]);
  assert.equal(engine.pushes, 1);
  assert.equal(finals, 1);
});

test("bounds queued audio when inference falls behind", async () => {
  let releasePush;
  class SlowEngine extends FakeEngine {
    async push() {
      await new Promise((resolve) => { releasePush = resolve; });
      return "";
    }
  }
  const runtime = new BrowserSpeechToTextRuntime({ supported: true, storage: new MemoryStorage(), engineFactory: () => new SlowEngine() });
  await runtime.prepare();
  const session = runtime.createSession({ inputMode: "pcm", maxPendingSamples: 4 });
  const errors = [];
  session.on("error", (error) => errors.push(error.code));
  await session.start();
  const first = session.push(new Float32Array(4));
  await new Promise((resolve) => setImmediate(resolve));
  await session.push(new Float32Array(1));
  releasePush();
  await first;
  assert.deepEqual(errors, ["audio_backpressure"]);
});
