import type { RuntimeStatus, SessionEvents, SessionOptions } from "../browser/index.js";
export declare class NativeSpeechError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown);
}
export declare class NativeTranscriptionSession {
  on<K extends keyof SessionEvents>(type: K, listener: (event: SessionEvents[K] & { sessionId?: string }) => void): () => void;
  start(): Promise<unknown>;
  push(samples: Float32Array): Promise<void>;
  stop(): Promise<unknown>;
  cancel(): Promise<unknown>;
  dispose(): Promise<void>;
}
export declare class NativeSpeechToTextRuntime {
  constructor(options?: { endpoint?: string });
  prepare(progress?: (event: unknown) => void): Promise<RuntimeStatus>;
  status(): Promise<RuntimeStatus>;
  createSession(options?: SessionOptions): Promise<NativeTranscriptionSession>;
  clearModel(): Promise<unknown>;
  dispose(): Promise<void>;
}
export declare function defaultEndpoint(platform?: NodeJS.Platform): string;
