import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { NativeSpeechToTextRuntime } from "../client/index.js";
import {
  FRAME_JSON,
  FRAME_PCM_F32LE,
  FrameDecoder,
  PROTOCOL_VERSION,
  decodeJsonPayload,
  encodeJsonFrame
} from "../protocol/index.js";

async function socketFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "drake-speech-client-"));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\drake-speech-test-${process.pid}-${Date.now()}`
    : path.join(directory, "speech.sock");
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return endpoint;
}

function reply(socket, replyTo, result = {}) {
  socket.write(encodeJsonFrame({ version: PROTOCOL_VERSION, replyTo, ok: true, result }));
}

test("reports a typed connection error", async (t) => {
  const endpoint = await socketFixture(t);
  const runtime = new NativeSpeechToTextRuntime({ endpoint });
  await assert.rejects(runtime.status(), (error) => {
    assert.equal(error.code, "service_unavailable");
    return true;
  });
});

test("keeps each PCM control beside its binary frame", async (t) => {
  const endpoint = await socketFixture(t);
  const server = net.createServer();
  const order = [];
  server.on("connection", (socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind === FRAME_JSON) {
          const message = decodeJsonPayload(frame.payload);
          if (message.type === "pcm") order.push(`control:${message.payload.sessionId}`);
          reply(socket, message.id);
        } else if (frame.kind === FRAME_PCM_F32LE) {
          order.push(`audio:${new Float32Array(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength / 4)[0]}`);
        }
      }
    });
  });
  server.listen(endpoint);
  await once(server, "listening");

  const runtime = new NativeSpeechToTextRuntime({ endpoint });
  t.after(async () => {
    await runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
  });
  await Promise.all([
    runtime._pushPcm("first", new Float32Array([1])),
    runtime._pushPcm("second", new Float32Array([2]))
  ]);

  assert.deepEqual(order, ["control:first", "audio:1", "control:second", "audio:2"]);
});
