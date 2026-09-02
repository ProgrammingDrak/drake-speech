import { ParakeetEouEngine } from "../vendor/fluidaudio-web/engines/eou-parakeet/index.js";
import { MicCapture } from "../vendor/fluidaudio-web/core/mic.js";
import { CACHE_NAME, clearModelCache } from "../vendor/fluidaudio-web/core/modelCache.js";

export const BROWSER_MODEL_BYTES = 240453556;
export const MODEL_CACHE_NAME = CACHE_NAME;
const INSTALL_MARKER = "drake-speech:model-ready:v1";

export class SpeechRuntimeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "SpeechRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export class BrowserSpeechToTextRuntime {
  #engineFactory;
  #micFactory;
  #storage;
  #engine = null;
  #preparePromise = null;
  #activeSession = null;
  #state;

  constructor(dependencies = {}) {
    this.#engineFactory = dependencies.engineFactory ?? (() => new ParakeetEouEngine());
    this.#micFactory = dependencies.micFactory ?? (() => new MicCapture());
    this.#storage = dependencies.storage ?? globalThis.localStorage;
    const supported = dependencies.supported ?? detectBrowserSupport();
    const installed = supported && this.#storage?.getItem(INSTALL_MARKER) === "true";
    this.#state = {
      support: supported ? "supported" : "unsupported",
      installation: installed ? "installed" : "not-installed",
      loading: "idle",
      ready: false,
      error: null,
      modelBytes: BROWSER_MODEL_BYTES,
      backend: "auto",
      storagePersistence: "unknown"
    };
  }

  status() {
    return structuredCloneSafe(this.#state);
  }

  async prepare(progress) {
    if (this.#state.support === "unsupported") {
      throw new SpeechRuntimeError("unsupported", "This browser cannot run local transcription.");
    }
    if (this.#state.ready) return this.status();
    if (this.#preparePromise) return this.#preparePromise;

    this.#state.loading = this.#state.installation === "installed" ? "loading" : "downloading";
    this.#state.error = null;
    this.#preparePromise = (async () => {
      this.#state.storagePersistence = await requestPersistentStorage() ? "persistent" : "best-effort";
      const engine = this.#engineFactory();
      try {
        await engine.load((event) => {
          this.#state.loading = event.phase === "download" ? "downloading" : "loading";
          progress?.({ ...event, state: this.status() });
        });
        this.#engine = engine;
        this.#state.installation = "installed";
        this.#state.loading = "idle";
        this.#state.ready = true;
        this.#storage?.setItem(INSTALL_MARKER, "true");
        return this.status();
      } catch (cause) {
        await engine.dispose?.().catch(() => undefined);
        this.#state.loading = "idle";
        this.#state.ready = false;
        this.#state.error = normalizeError(cause);
        throw new SpeechRuntimeError(this.#state.error.code, this.#state.error.message, { cause });
      } finally {
        this.#preparePromise = null;
      }
    })();
    return this.#preparePromise;
  }

  createSession(options = {}) {
    if (!this.#state.ready || !this.#engine) {
      throw new SpeechRuntimeError("not_ready", "Prepare the speech runtime before creating a session.");
    }
    if (this.#activeSession) {
      throw new SpeechRuntimeError("busy", "Another transcription session is active.");
    }
    this.#engine.reset();
    const session = new BrowserTranscriptionSession(
      this.#engine,
      this.#micFactory,
      options,
      () => {
        if (this.#activeSession === session) this.#activeSession = null;
      }
    );
    this.#activeSession = session;
    return session;
  }

  async clearModel() {
    if (this.#activeSession) await this.#activeSession.cancel();
    await this.#engine?.dispose?.();
    this.#engine = null;
    await clearModelCache();
    this.#storage?.removeItem(INSTALL_MARKER);
    this.#state.installation = "not-installed";
    this.#state.loading = "idle";
    this.#state.ready = false;
    this.#state.error = null;
  }

  async dispose() {
    if (this.#activeSession) await this.#activeSession.cancel();
    await this.#engine?.dispose?.();
    this.#engine = null;
    this.#state.ready = false;
  }
}

export class BrowserTranscriptionSession {
  #engine;
  #micFactory;
  #options;
  #release;
  #listeners = new Map();
  #mic = null;
  #timer = null;
  #startedAt = 0;
  #lastVoiceAt = 0;
  #readAt = 0;
  #eventCount = 0;
  #processedSamples = 0;
  #text = "";
  #state = "created";
  #queue = Promise.resolve();
  #stopPromise = null;
  #pendingSamples = 0;

  constructor(engine, micFactory, options, release) {
    this.#engine = engine;
    this.#micFactory = micFactory;
    this.#release = release;
    const mergedOptions = {
      language: "en",
      inputMode: "microphone",
      leadInTimeoutMs: 8000,
      silenceTimeoutMs: 2500,
      activityThreshold: 0.012,
      pollIntervalMs: 160,
      maxPendingSamples: 80_000,
      ...options
    };
    this.#options = {
      ...mergedOptions,
      leadInTimeoutMs: mergedOptions.leadInTimeoutMs ?? 8000,
      silenceTimeoutMs: mergedOptions.silenceTimeoutMs ?? 2500,
      activityThreshold: mergedOptions.activityThreshold ?? 0.012,
      pollIntervalMs: mergedOptions.pollIntervalMs ?? 160,
      maxPendingSamples: mergedOptions.maxPendingSamples ?? 80_000
    };
    if (this.#options.language !== "en") {
      throw new SpeechRuntimeError("unsupported_language", "Version one supports English only.");
    }
    if (!["microphone", "pcm"].includes(this.#options.inputMode)) {
      throw new SpeechRuntimeError("invalid_input_mode", "Input mode must be microphone or pcm.");
    }
  }

  on(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  async start() {
    if (this.#state !== "created") {
      throw new SpeechRuntimeError("invalid_state", `Cannot start a ${this.#state} session.`);
    }
    this.#state = "running";
    this.#startedAt = Date.now();
    this.#lastVoiceAt = 0;
    if (this.#options.inputMode === "microphone") {
      this.#mic = this.#micFactory();
      try {
        await this.#mic.start();
      } catch (cause) {
        this.#emitError(cause, "microphone_denied");
        await this.cancel();
        throw cause;
      }
      this.#timer = setInterval(() => this.#pollMicrophone(), this.#options.pollIntervalMs);
    } else {
      this.#timer = setInterval(() => this.#checkTimeouts(), Math.min(250, this.#options.pollIntervalMs));
    }
  }

  push(samples) {
    if (this.#state !== "running" || this.#options.inputMode !== "pcm") {
      return Promise.reject(new SpeechRuntimeError("invalid_state", "PCM input requires a running PCM session."));
    }
    return this.#enqueueSamples(samples);
  }

  stop() {
    if (this.#state === "finished" || this.#state === "cancelled" || this.#state === "disposed") return;
    if (this.#stopPromise) return this.#stopPromise;
    this.#state = "stopping";
    this.#stopPolling();
    this.#stopPromise = (async () => {
      await this.#mic?.stop();
      this.#mic = null;
      await this.#queue;
      try {
        const finalText = normalizeTranscript(await this.#engine.finish());
        if (finalText) this.#text = finalText;
        this.#state = "finished";
        if (this.#text) this.#emit("final", { text: this.#text });
        else this.#emit("silence", { reason: "empty" });
      } catch (cause) {
        this.#state = "finished";
        this.#emitError(cause, "inference_failed");
      } finally {
        this.#release();
      }
    })();
    return this.#stopPromise;
  }

  async cancel() {
    if (["cancelled", "disposed", "finished"].includes(this.#state)) return;
    this.#state = "cancelled";
    this.#stopPolling();
    await this.#mic?.stop();
    this.#mic = null;
    await this.#queue.catch(() => undefined);
    this.#engine.reset();
    this.#release();
  }

  async dispose() {
    await this.cancel();
    this.#listeners.clear();
    this.#state = "disposed";
  }

  #pollMicrophone() {
    if (this.#state !== "running" || !this.#mic) return;
    const { samples, total } = this.#mic.since(this.#readAt);
    this.#readAt = total;
    this.#mic.dropBefore(total);
    if (samples.length) void this.#enqueueSamples(samples);
    this.#checkTimeouts();
  }

  #enqueueSamples(samples) {
    const input = samples instanceof Float32Array ? samples : new Float32Array(samples);
    if (this.#pendingSamples + input.length > this.#options.maxPendingSamples) {
      const error = new SpeechRuntimeError("audio_backpressure", "Transcription could not keep up with live audio.");
      this.#emitError(error, error.code);
      void this.cancel();
      return Promise.resolve();
    }
    this.#pendingSamples += input.length;
    if (rms(input) >= this.#options.activityThreshold) this.#lastVoiceAt = Date.now();
    this.#queue = this.#queue.then(async () => {
      if (!["running", "stopping"].includes(this.#state)) return;
      const text = normalizeTranscript(await this.#engine.push(input));
      this.#processedSamples += input.length;
      this.#emit("progress", { processedSeconds: this.#processedSamples / 16000 });
      if (text && text !== this.#text) {
        this.#text = text;
        this.#emit("partial", { text });
      }
      const events = this.#engine.streamEvents ?? [];
      if (events.length > this.#eventCount) {
        const newEvents = events.slice(this.#eventCount);
        this.#eventCount = events.length;
        if (newEvents.some((event) => event.type === "eou" || event.type === "eob")) {
          queueMicrotask(() => void this.stop());
        }
      }
    }).catch((cause) => {
      this.#emitError(cause, "inference_failed");
      void this.cancel();
    }).finally(() => {
      this.#pendingSamples -= input.length;
    });
    return this.#queue;
  }

  #checkTimeouts() {
    if (this.#state !== "running") return;
    const now = Date.now();
    if (!this.#lastVoiceAt && now - this.#startedAt >= this.#options.leadInTimeoutMs) {
      this.#emit("silence", { reason: "lead-in" });
      void this.cancel();
      return;
    }
    if (this.#lastVoiceAt && now - this.#lastVoiceAt >= this.#options.silenceTimeoutMs) {
      void this.stop();
    }
  }

  #stopPolling() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #emit(type, detail) {
    for (const listener of this.#listeners.get(type) ?? []) listener(detail);
  }

  #emitError(cause, fallbackCode) {
    const error = normalizeError(cause, fallbackCode);
    this.#emit("error", error);
  }
}

export function detectBrowserSupport() {
  return Boolean(
    globalThis.WebAssembly &&
    globalThis.crypto?.subtle &&
    globalThis.caches &&
    globalThis.fetch &&
    globalThis.navigator?.mediaDevices?.getUserMedia &&
    (globalThis.AudioContext || globalThis.webkitAudioContext)
  );
}

async function requestPersistentStorage() {
  if (!globalThis.navigator?.storage?.persist) return false;
  try {
    return await globalThis.navigator.storage.persist();
  } catch {
    return false;
  }
}

function normalizeTranscript(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function normalizeError(cause, fallbackCode = "runtime_failed") {
  if (cause instanceof SpeechRuntimeError) {
    return { code: cause.code, message: cause.message, details: cause.details };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = message.split(":", 1)[0] || fallbackCode;
  return { code: code.includes("_") ? code : fallbackCode, message };
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}
