import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_JSON,
  FrameDecoder,
  ProtocolError,
  assertCompatible,
  decodeJsonPayload,
  encodeJsonFrame
} from "../protocol/index.js";

test("decodes fragmented frames", () => {
  const encoded = encodeJsonFrame({ hello: "world" });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(encoded.slice(0, 3)), []);
  const frames = decoder.push(encoded.slice(3));
  assert.equal(frames[0].kind, FRAME_JSON);
  assert.deepEqual(decodeJsonPayload(frames[0].payload), { hello: "world" });
});

test("rejects unknown protocol majors", () => {
  assert.throws(() => assertCompatible({ major: 2, minor: 0 }), (error) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, "unsupported_protocol");
    return true;
  });
});
