import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  FRAME_JSON,
  FRAME_PCM_F32LE,
  FrameDecoder,
  PROTOCOL_VERSION,
  assertCompatible,
  decodeJsonPayload,
  encodeJsonFrame,
  encodePcmFrame
} from "../protocol/index.js";

export class NativeSpeechToTextRuntime {
  #endpoint;
  #socket = null;
  #decoder = new FrameDecoder();
  #requests = new Map();
  #listeners = new Map();
  #sequence = 0;
  #session = null;

  constructor(options = {}) {
    this.#endpoint = options.endpoint ?? defaultEndpoint();
  }

  async prepare(progress) {
    const unsubscribe = this._on("progress", progress ?? (() => undefined));
    try {
      return await this.#request("prepare", {});
    } finally {
      unsubscribe();
    }
  }

  status() {
    return this.#request("status", {});
  }

  async createSession(options = {}) {
    if (this.#session) throw new NativeSpeechError("busy", "Another transcription session is active.");
    const result = await this.#request("create_session", options);
    const session = new NativeTranscriptionSession(this, result.sessionId, () => {
      if (this.#session === session) this.#session = null;
    });
    this.#session = session;
    return session;
  }

  clearModel() {
    return this.#request("clear_model", {});
  }

  async dispose() {
    await this.#session?.cancel().catch(() => undefined);
    this.#session = null;
    this.#socket?.destroy();
    this.#socket = null;
    for (const { reject } of this.#requests.values()) {
      reject(new NativeSpeechError("disconnected", "The speech service disconnected."));
    }
    this.#requests.clear();
  }

  _sessionCommand(sessionId, type) {
    return this.#request(type, { sessionId });
  }

  async _pushPcm(sessionId, samples) {
    await this.#ensureConnected();
    await this.#request("pcm", { sessionId, samples: samples.length });
    await write(this.#socket, encodePcmFrame(samples));
  }

  _on(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  async #request(type, payload) {
    await this.#ensureConnected();
    const id = String(++this.#sequence);
    const promise = new Promise((resolve, reject) => this.#requests.set(id, { resolve, reject }));
    await write(this.#socket, encodeJsonFrame({ version: PROTOCOL_VERSION, id, type, payload }));
    return promise;
  }

  async #ensureConnected() {
    if (this.#socket && !this.#socket.destroyed) return;
    this.#socket = await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.#endpoint);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    }).catch((cause) => {
      throw new NativeSpeechError("service_unavailable", `Cannot connect to Drake Speech at ${this.#endpoint}.`, { cause });
    });
    this.#socket.on("data", (chunk) => this.#receive(chunk));
    this.#socket.on("close", () => {
      this.#disconnect(new NativeSpeechError("disconnected", "The speech service disconnected."));
    });
    await this.#requestWithoutConnect("hello", { client: "drake-speech-client" });
  }

  #requestWithoutConnect(type, payload) {
    const id = String(++this.#sequence);
    const promise = new Promise((resolve, reject) => this.#requests.set(id, { resolve, reject }));
    void write(this.#socket, encodeJsonFrame({ version: PROTOCOL_VERSION, id, type, payload })).catch(reject);
    return promise;
  }

  #receive(chunk) {
    try {
      for (const frame of this.#decoder.push(chunk)) {
        if (frame.kind !== FRAME_JSON) {
          if (frame.kind !== FRAME_PCM_F32LE) this.#emit("error", { code: "unknown_frame", message: `Unknown frame ${frame.kind}.` });
          continue;
        }
        const message = decodeJsonPayload(frame.payload);
        assertCompatible(message.version);
        if (message.replyTo) {
          const request = this.#requests.get(message.replyTo);
          if (!request) continue;
          this.#requests.delete(message.replyTo);
          if (message.ok) request.resolve(message.result);
          else request.reject(new NativeSpeechError(message.error?.code ?? "service_error", message.error?.message ?? "Speech service error.", message.error?.details));
        } else if (message.type === "event") {
          this.#emit(message.event, message.payload);
        }
      }
    } catch (cause) {
      const socket = this.#socket;
      this.#disconnect(new NativeSpeechError(cause.code ?? "protocol_error", cause.message, { cause }));
      socket?.destroy();
    }
  }

  #disconnect(error) {
    this.#socket = null;
    this.#decoder = new FrameDecoder();
    for (const { reject } of this.#requests.values()) reject(error);
    this.#requests.clear();
    this.#emit("error", { code: error.code, message: error.message, details: error.details });
  }

  #emit(type, payload) {
    for (const listener of this.#listeners.get(type) ?? []) listener(payload);
  }
}

export class NativeTranscriptionSession {
  #runtime;
  #sessionId;
  #release;
  #unsubscribers = [];
  #listeners = new Map();
  #closed = false;
  #terminal;
  #resolveTerminal;

  constructor(runtime, sessionId, release) {
    this.#runtime = runtime;
    this.#sessionId = sessionId;
    this.#release = release;
    this.#terminal = new Promise((resolve) => { this.#resolveTerminal = resolve; });
    for (const type of ["partial", "final", "silence", "progress", "error"]) {
      this.#unsubscribers.push(runtime._on(type, (payload) => {
        if (!payload?.sessionId || payload.sessionId === this.#sessionId) {
          this.#emit(type, payload);
          if (["final", "silence", "error"].includes(type)) this.#close();
        }
      }));
    }
  }

  on(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  start() { return this.#runtime._sessionCommand(this.#sessionId, "start"); }
  push(samples) { return this.#runtime._pushPcm(this.#sessionId, samples); }
  async stop() {
    if (this.#closed) return;
    await this.#runtime._sessionCommand(this.#sessionId, "stop");
    await Promise.race([
      this.#terminal,
      new Promise((_, reject) => setTimeout(() => reject(new NativeSpeechError("final_timeout", "The speech service did not finalize within ten seconds.")), 10_000))
    ]);
  }

  async cancel() {
    if (this.#closed) return;
    try {
      await this.#runtime._sessionCommand(this.#sessionId, "cancel");
    } finally {
      this.#close();
    }
  }

  async dispose() {
    await this.cancel().catch(() => undefined);
    this.#listeners.clear();
  }

  #emit(type, payload) {
    for (const listener of this.#listeners.get(type) ?? []) listener(payload);
  }

  #close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#resolveTerminal?.();
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#release();
  }
}

export class NativeSpeechError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "NativeSpeechError";
    this.code = code;
    this.details = details;
  }
}

export function defaultEndpoint(platform = process.platform) {
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Drake Speech", "run", "speech-v1.sock");
  }
  if (platform === "win32") {
    const safeUser = os.userInfo().username.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return `\\\\.\\pipe\\drake-speech-v1-${safeUser}`;
  }
  throw new NativeSpeechError("unsupported", `Native Drake Speech does not support ${platform}.`);
}

function write(socket, bytes) {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => error ? reject(error) : resolve());
  });
}
