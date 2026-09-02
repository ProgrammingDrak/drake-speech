export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });
export const FRAME_JSON = 1;
export const FRAME_PCM_F32LE = 2;

export class ProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }
}

export function assertCompatible(version) {
  if (!version || version.major !== PROTOCOL_VERSION.major) {
    throw new ProtocolError(
      "unsupported_protocol",
      `Protocol major ${version?.major ?? "missing"} is unsupported. Expected ${PROTOCOL_VERSION.major}.`,
      { expected: PROTOCOL_VERSION, received: version }
    );
  }
}

export function encodeJsonFrame(message) {
  return encodeFrame(FRAME_JSON, new TextEncoder().encode(JSON.stringify(message)));
}

export function encodePcmFrame(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  return encodeFrame(FRAME_PCM_F32LE, bytes);
}

export function encodeFrame(kind, payload) {
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = kind;
  new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
  frame.set(payload, 5);
  return frame;
}

export class FrameDecoder {
  #buffer = new Uint8Array(0);

  push(chunk) {
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const next = new Uint8Array(this.#buffer.byteLength + incoming.byteLength);
    next.set(this.#buffer);
    next.set(incoming, this.#buffer.byteLength);
    this.#buffer = next;

    const frames = [];
    while (this.#buffer.byteLength >= 5) {
      const size = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + 1, 4).getUint32(0, false);
      if (size > 64 * 1024 * 1024) {
        throw new ProtocolError("frame_too_large", `Frame size ${size} exceeds 64 MiB.`);
      }
      if (this.#buffer.byteLength < size + 5) break;
      const kind = this.#buffer[0];
      const payload = this.#buffer.slice(5, size + 5);
      frames.push({ kind, payload });
      this.#buffer = this.#buffer.slice(size + 5);
    }
    return frames;
  }
}

export function decodeJsonPayload(payload) {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch (cause) {
    throw new ProtocolError("invalid_json", "The control frame contains invalid JSON.", { cause: String(cause) });
  }
}
