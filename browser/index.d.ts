export type RuntimeSupport = "supported" | "unsupported";
export type InstallationState = "installed" | "not-installed";
export type LoadingState = "idle" | "downloading" | "loading";
export interface RuntimeStatus {
  support: RuntimeSupport;
  installation: InstallationState;
  loading: LoadingState;
  ready: boolean;
  error: { code: string; message: string; details?: unknown } | null;
  modelBytes: number;
  backend: "auto" | "webgpu" | "wasm";
  storagePersistence: "unknown" | "persistent" | "best-effort";
}
export interface PrepareProgress {
  file: string;
  phase?: "download" | "load";
  loaded: number;
  total: number;
  fraction: number;
  state: RuntimeStatus;
}
export interface SessionOptions {
  language?: "en";
  inputMode?: "microphone" | "pcm";
  leadInTimeoutMs?: number;
  silenceTimeoutMs?: number;
  activityThreshold?: number;
  pollIntervalMs?: number;
  maxPendingSamples?: number;
}
export interface SessionEvents {
  partial: { text: string };
  final: { text: string };
  silence: { reason: "lead-in" | "empty" };
  progress: { processedSeconds: number };
  error: { code: string; message: string; details?: unknown };
}
export declare const BROWSER_MODEL_BYTES = 240453556;
export declare const MODEL_CACHE_NAME = "drake-speech-models-v1";
export declare class SpeechRuntimeError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown);
}
export declare class BrowserTranscriptionSession {
  on<K extends keyof SessionEvents>(type: K, listener: (event: SessionEvents[K]) => void): () => void;
  start(): Promise<void>;
  push(samples: Float32Array): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
export declare class BrowserSpeechToTextRuntime {
  constructor(dependencies?: Record<string, unknown>);
  status(): RuntimeStatus;
  prepare(progress?: (event: PrepareProgress) => void): Promise<RuntimeStatus>;
  createSession(options?: SessionOptions): BrowserTranscriptionSession;
  clearModel(): Promise<void>;
  dispose(): Promise<void>;
}
export declare function detectBrowserSupport(): boolean;
