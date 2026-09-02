import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const browserRuntime = readFileSync(new URL("../browser/index.js", import.meta.url), "utf8");
const microphone = readFileSync(new URL("../vendor/fluidaudio-web/core/mic.js", import.meta.url), "utf8");
const nativeClient = readFileSync(new URL("../client/index.js", import.meta.url), "utf8");
const nativeService = readFileSync(new URL("../native/service/src/main.rs", import.meta.url), "utf8");

test("audio paths contain no remote transport", () => {
  for (const source of [browserRuntime, microphone]) {
    assert.doesNotMatch(source, /WebSocket|EventSource|sendBeacon|XMLHttpRequest/);
  }
  assert.doesNotMatch(nativeClient, /createServer|connect\s*\(\s*\{[^}]*port|http:|https:/s);
});

test("native HTTP access exists only in the model downloader", () => {
  assert.match(nativeService, /fn download_file/);
  assert.doesNotMatch(nativeService, /transcript[^\n]*(reqwest|send|post)|reqwest[^\n]*transcript/i);
});
