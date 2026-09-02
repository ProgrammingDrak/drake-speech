export interface ProtocolVersion { major: number; minor: number }
export declare const PROTOCOL_VERSION: Readonly<ProtocolVersion>;
export declare const FRAME_JSON = 1;
export declare const FRAME_PCM_F32LE = 2;
export declare class ProtocolError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown);
}
export declare function assertCompatible(version: ProtocolVersion): void;
export declare function encodeJsonFrame(message: unknown): Uint8Array;
export declare function encodePcmFrame(samples: Float32Array): Uint8Array;
export declare function encodeFrame(kind: number, payload: Uint8Array): Uint8Array;
export declare class FrameDecoder {
  push(chunk: Uint8Array | ArrayBuffer): Array<{ kind: number; payload: Uint8Array }>;
}
export declare function decodeJsonPayload(payload: Uint8Array): unknown;
