// Parakeet EOU 120M — end-of-utterance detection + transcription, fully ORT-free.
//
// NVIDIA's `parakeet_realtime_eou_120m-v1`: a streaming FastConformer RNNT with two
// control tokens — <EOU> (end of utterance) and <EOB> — so a voice agent can tell
// when the user finished speaking. Decoded offline (whole clip); the transcript plus
// the <EOU>/<EOB> timestamps come back together.
//
// Everything is hand-written on raw WebGPU + JS (no onnxruntime):
//   • Mel: JsPreprocessor NA log-mel (no CMVN) — this model wants un-normalized mel.
//   • Encoder: the shared FastConformer (raw-encoder.js) with EOU streaming config —
//     causal subsampling pad, causal depthwise conv, conv-module LayerNorm, and a
//     cache-aware chunked attention mask (chunk 2, left context 70). fp16 weights
//     (int8 degrades this 120M RNNT). Runs on WebGPU.
//   • Decoder+joint: 1-layer LSTM RNNT (raw-decoder-eou.js), small enough for plain JS.
//     The exported joint prepends a zero SOS timestep per call (2-step LSTM).
// Full raw path == ORT reference transcript; encoder maxΔ 4.4e-2 (fp16) vs ORT.
import { fetchCached, hfUrl } from "../../core/modelCache.js";
import { makeTranscribeProgress } from "../../core/progress.js";
import { createContext } from "../../gpu/context.js";
import { loadParakeetEncoder } from "../asr-parakeet/raw-encoder.js";
import { loadEouDecoder, loadEouWasmDecoder, eouWasmDecodeCont, eouWasmReset } from "../asr-parakeet/raw-decoder-eou.js";
import { createEncodeStream, encodeStreamPush, encodeStreamFlush, disposeEncodeStream } from "../asr-parakeet/streaming-encoder.js";
import { JsPreprocessor } from "../asr-nemotron/nemotron-mel.js";
import { StreamingMel } from "../asr-nemotron/streaming-mel.js";
import { tokensToWords } from "../../core/captions.js";
import { makeEouTokenizer } from "./eou-decode.js";
import { EOU_CFG } from "./config.js";
const wasmUrl = new URL("../asr-parakeet/parakeet-decoder.wasm", import.meta.url); // cross-bundler asset URL
const WEIGHTS_REPO = "FluidInference/fluidaudio-web";
const VOCAB_REPO = "ysdede/parakeet-realtime-eou-120m-v1-onnx";
const WEIGHTS_REVISION = "6c6bcda07b23fd91778062b435b1a5f2f6d07504";
const VOCAB_REVISION = "6d6be8e9113b4aa8ae7b4d5dfb655795c084d0c6";
const FILES = {
    "eou/encoder-fp16.manifest.json": { bytes: 39130, sha256: "ea9bc2993d3a58bb66ffabbf4d860f901f6ee9e859d0d90e24a04c1c0aa1c6ab" },
    "eou/encoder-fp16.bin": { bytes: 219063296, sha256: "590a0a673d8f40cb3fa60538f49972847c8ac0f474b7873fe5f6ccf781137bdd" },
    "eou/decoder-fp32.manifest.json": { bytes: 629, sha256: "cafda436f87e948996d15726900a75b648a0fe97e50086f1963749ea9c2b237a" },
    "eou/decoder-fp32.bin": { bytes: 21344268, sha256: "f627c74db4064400527937f93fb7a8b67d5ca64581baf9380ee566c1123764b2" },
    "vocab.txt": { bytes: 6233, sha256: "77c3f876cddac2d9ad82efceea38fd6acd16575e0ab54ab3396aa4621fa8ff02" },
};
const FRAME_SEC = 0.08; // 10ms mel hop × 8× subsampling
// EOU streaming FastConformer config (see raw-encoder.js): causal subsampling pad,
// causal depthwise conv, chunked-causal attention (chunk 2, left context 70).
const PROJ_D = 640; // joint-projected frame width (512→640 GEMM rides the encode batch)
// Batch-transcribe chunk size (subsampled frames ≈ 61s audio). Swept on the
// 1-hour bench (dawn, M-series): 384→173×, 512→207×, 640→229×, 768→254×,
// 896→208×, 1536→149× — 768 is a solid local optimum (GEMM occupancy vs
// attention-rectangle size), 1.5× the old quadratic-segment path's 167×.
const BATCH_CHUNK = 768;
export class ParakeetEouEngine {
    id = "eou-parakeet";
    label = "Parakeet EOU 120M";
    ctx = null;
    enc = null;
    dec = null;
    mel = null;
    tokenizer = null;
    wdec = null; // wasm-SIMD decoder (holds the stream's RNNT state)
    decSrc = null;
    worker = null;
    workerFailed = false;
    projW = null; // joint enc projection 512→640, run GPU-side pre-download
    projB = null;
    stream = null;
    // push()/finish() serialize through this chain: the SDK doesn't force callers
    // to await one push before the next, and interleaved encodeStreamPush loops
    // on one encSt corrupt the FIFO/caches.
    op = Promise.resolve();
    serialize(fn) {
        const r = this.op.then(fn, fn);
        this.op = r.then(() => undefined, () => undefined);
        return r;
    }
    async load(onProgress) {
        this.ctx = await createContext({ onBackend: (b) => console.info(`[eou-parakeet] backend: ${b}`) });
        const options = (path) => ({ expectedBytes: FILES[path].bytes, expectedSha256: FILES[path].sha256 });
        const json = async (path) => JSON.parse(new TextDecoder().decode(await fetchCached(hfUrl(WEIGHTS_REPO, path, WEIGHTS_REVISION), onProgress, path, options(path))));
        const bytes = (path) => fetchCached(hfUrl(WEIGHTS_REPO, path, WEIGHTS_REVISION), onProgress, path, options(path));
        const encMan = await json("eou/encoder-fp16.manifest.json");
        const encBin = await bytes("eou/encoder-fp16.bin");
        const decMan = await json("eou/decoder-fp32.manifest.json");
        const decBin = await bytes("eou/decoder-fp32.bin");
        const vocab = new TextDecoder().decode(await fetchCached(hfUrl(VOCAB_REPO, "vocab.txt", VOCAB_REVISION), onProgress, "vocab.txt", options("vocab.txt")));
        this.enc = loadParakeetEncoder(this.ctx, encBin, encMan, EOU_CFG);
        const decF32 = new Float32Array(decBin.buffer, decBin.byteOffset, decBin.byteLength / 4);
        this.dec = loadEouDecoder(decF32, decMan);
        // Decode runs in the wasm-SIMD crate (JS loop is the hour-scale bottleneck);
        // the joint's 512→640 enc projection rides the encode batch as one GEMM.
        const wasmBytes = await (await fetch(wasmUrl)).arrayBuffer();
        this.wdec = await loadEouWasmDecoder(wasmBytes, decF32, decMan);
        this.decSrc = { wasmBytes, decBuf: decF32, man: decMan };
        this.projW = this.ctx.upload(this.dec.encW.slice(), 512, 640);
        this.projB = this.ctx.upload(this.dec.encB.slice(), 1, 640);
        this.mel = new JsPreprocessor({ nMels: 128 });
        this.tokenizer = makeEouTokenizer(vocab);
        onProgress?.({ file: WEIGHTS_REPO, loaded: 1, total: 1, fraction: 1 });
    }
    // One stateful decode worker (RNNT state lives in ITS wasm instance): batch
    // decode runs off the main thread and overlaps the next chunk's GPU encode.
    // Chrome main-thread wasm ran ~2.6× slower than node while also driving the
    // GPU — this was EOU's whole 1-hour bottleneck after the stream-batch encode.
    async ensureWorker() {
        if (this.worker || this.workerFailed)
            return this.worker;
        if (typeof Worker === "undefined" || !this.decSrc)
            return null;
        try {
            const w = new Worker(new URL("./eou-decoder-worker.js", import.meta.url), { type: "module" });
            let seq = 0;
            const waiting = new Map();
            w.onmessage = (e) => {
                const m = e.data;
                if (m.type === "ready")
                    return;
                const p = waiting.get(m.id);
                if (!p)
                    return;
                waiting.delete(m.id);
                if (m.type === "err")
                    p.reject(new Error(`eou decode worker: ${m.error}`));
                else
                    p.resolve(m);
            };
            w.onerror = (e) => {
                for (const [, p] of waiting)
                    p.reject(new Error(String(e.message ?? e)));
                waiting.clear();
            };
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error("eou decode worker init timeout")), 20000);
                const prev = w.onmessage;
                w.onmessage = (e) => {
                    if (e.data?.type === "ready") {
                        clearTimeout(t);
                        w.onmessage = prev;
                        resolve();
                    }
                    else if (e.data?.type === "err") {
                        clearTimeout(t);
                        reject(new Error(String(e.data.error)));
                    }
                };
                // copies, not transfers — the main-thread wdec keeps its own instance
                w.postMessage({ type: "init", wasmBytes: this.decSrc.wasmBytes.slice(0), decBuf: this.decSrc.decBuf.slice().buffer, man: this.decSrc.man });
            });
            this.worker = {
                call: (msg, transfer) => {
                    const id = seq++;
                    return new Promise((resolve, reject) => {
                        waiting.set(id, { resolve, reject });
                        try {
                            w.postMessage({ ...msg, id }, transfer ?? []);
                        }
                        catch (e) {
                            waiting.delete(id);
                            reject(e);
                        }
                    });
                },
                terminate: () => w.terminate(),
            };
        }
        catch (err) {
            console.warn("[eou-parakeet] decode worker unavailable — inline decode:", err);
            this.workerFailed = true;
            this.worker = null;
        }
        return this.worker;
    }
    transcribe(audio, opts) {
        return this.serialize(() => this.transcribeInner(audio, opts));
    }
    async transcribeInner(audio, opts) {
        if (!this.enc || !this.wdec || !this.mel || !this.tokenizer)
            throw new Error("ParakeetEouEngine.load() not called");
        if (this.stream)
            throw new Error("a live stream is active — reset() before batch transcribe (shared decoder state)");
        const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
        const t0 = now();
        // Batch IS a big-chunk stream. The old path materialized full [T,T]
        // chunked-attention buffers per 4-minute segment (~288MB of scores each)
        // even though the model only attends 70 frames back; the streaming encoder
        // computes the same function at linear cost (bit-exact — gate:
        // scripts/streaming-encode-check.mjs). Decoder state now carries across
        // the WHOLE clip (no per-segment reset — whole-clip LSTM continuity).
        const mel = new StreamingMel(128);
        const encSt = createEncodeStream(this.ctx, this.enc, { proj: { w: this.projW, b: this.projB } });
        const worker = await this.ensureWorker();
        if (worker)
            await worker.call({ type: "reset" });
        else
            eouWasmReset(this.wdec);
        let melMs = 0;
        let encMs = 0;
        let decMs = 0;
        let subT = 0;
        const ids = [];
        const idTimes = [];
        const events = [];
        // Worker path: decode of chunk k overlaps the GPU encode of chunk k+1.
        // Decode is stateful+sequential, so results append via a promise chain
        // (chunk order preserved); frames buffers are TRANSFERRED (each is a
        // fresh download, never reused).
        let decChain = Promise.resolve();
        const accumulate = (r) => {
            ids.push(...r.ids);
            idTimes.push(...r.idFrames.map((f) => f * FRAME_SEC));
            for (const e of r.events)
                events.push({ type: e.type, time: +(e.frame * FRAME_SEC).toFixed(2) });
        };
        const consume = (frames) => {
            const n = frames.length / PROJ_D;
            const mySubT = subT;
            subT += n;
            if (worker) {
                decChain = decChain.then(async () => {
                    const r = await worker.call({ type: "decode", frames: frames.buffer, n, subT: mySubT }, [frames.buffer]);
                    decMs += r.ms;
                    accumulate(r);
                });
            }
            else {
                const td = now();
                accumulate(eouWasmDecodeCont(this.wdec, frames, n, mySubT));
                decMs += now() - td;
            }
        };
        const SLICE = 240 * 16000; // feed 4-min slices so chunk passes reach BATCH_CHUNK
        const progress = makeTranscribeProgress(audio.samples.length / 16000, opts?.onProgress);
        try {
            for (let off = 0; off < audio.samples.length; off += SLICE) {
                const tm = now();
                const { data, count } = mel.push(audio.samples.subarray(off, Math.min(off + SLICE, audio.samples.length)));
                melMs += now() - tm;
                if (data && count > 0) {
                    const te = now();
                    const out = await encodeStreamPush(this.ctx, encSt, data, count, { maxChunk: BATCH_CHUNK });
                    encMs += now() - te;
                    if (out)
                        consume(out);
                }
                progress?.update(Math.min(off + SLICE, audio.samples.length) / 16000);
            }
            const tm = now();
            const fl = mel.flush();
            melMs += now() - tm;
            const te = now();
            if (fl.data && fl.count > 0) {
                const out = await encodeStreamPush(this.ctx, encSt, fl.data, fl.count, { maxChunk: BATCH_CHUNK });
                if (out)
                    consume(out);
            }
            const tail = await encodeStreamFlush(this.ctx, encSt);
            encMs += now() - te;
            if (tail)
                consume(tail);
            await decChain; // drain the overlapped decodes (order-preserving)
        }
        finally {
            // even on a mid-loop throw, in-flight worker decodes must settle before
            // the arena/pool teardown (they only touch transferred CPU buffers, but
            // a rejected chain must not become an unhandled rejection).
            await decChain.catch(() => { });
            disposeEncodeStream(this.ctx, encSt);
            this.ctx.trimPool();
        }
        progress?.done();
        return {
            text: this.tokenizer.decode(ids),
            segments: tokensToWords(ids, idTimes, this.tokenizer.id2token),
            metrics: { melMs: +melMs.toFixed(1), encodeMs: +encMs.toFixed(1), decodeMs: +decMs.toFixed(1), totalMs: +(now() - t0).toFixed(1) },
            events,
        };
    }
    // ── true streaming (docs/STREAMING.md; gate: scripts/streaming-encode-check.mjs) ──
    // Carries conformer K/V + conv caches and the RNNT LSTM state chunk-to-chunk;
    // bit-exact with the offline chunked-causal path, so push() at mic cadence
    // costs one tiny chunk pass instead of a rolling re-decode.
    /** Feed 16 kHz samples; returns the text emitted so far (plus buffered state). */
    push(chunk) {
        return this.serialize(() => this.pushInner(chunk));
    }
    async pushInner(chunk) {
        if (!this.enc || !this.wdec || !this.tokenizer)
            throw new Error("ParakeetEouEngine.load() not called");
        if (this.stream?.finished)
            throw new Error("finish() already called — reset() to start a new stream");
        if (this.stream?.broken)
            throw new Error("stream broken by an earlier push failure — reset() to start a new stream");
        if (!this.stream) {
            eouWasmReset(this.wdec); // RNNT state lives in the wasm instance
            this.stream = {
                mel: new StreamingMel(128),
                encSt: createEncodeStream(this.ctx, this.enc, { proj: { w: this.projW, b: this.projB } }),
                ids: [],
                idTimes: [],
                events: [],
                subT: 0,
                finished: false,
                broken: false,
            };
        }
        const s = this.stream;
        // The mel FIFO absorbs the chunk BEFORE the encode that can throw — after a
        // failure the stream state is undefined (re-sending the chunk would feed
        // the mel twice). Poison it: the caller must reset() for a new utterance.
        try {
            const { data, count } = s.mel.push(chunk);
            if (data && count > 0) {
                const out = await encodeStreamPush(this.ctx, s.encSt, data, count, { maxChunk: 16 });
                if (out)
                    this.consume(out);
            }
        }
        catch (err) {
            s.broken = true;
            throw err;
        }
        return this.tokenizer.decode(s.ids);
    }
    /** Flush the right-padded tail and return the final utterance text. */
    finish() {
        return this.serialize(() => this.finishInner());
    }
    async finishInner() {
        if (!this.stream || !this.tokenizer)
            return "";
        const s = this.stream;
        if (s.finished || s.broken)
            return this.tokenizer.decode(s.ids);
        s.finished = true;
        const { data, count } = s.mel.flush();
        if (data && count > 0) {
            const out = await encodeStreamPush(this.ctx, s.encSt, data, count, { maxChunk: 16 });
            if (out)
                this.consume(out);
        }
        const tail = await encodeStreamFlush(this.ctx, s.encSt);
        if (tail)
            this.consume(tail);
        return this.tokenizer.decode(s.ids);
    }
    /** <EOU>/<EOB> events seen so far on the current stream (seconds). */
    get streamEvents() {
        return this.stream?.events ?? [];
    }
    /** Word segments decoded so far on the current stream — lets consumers split
     * utterances at event TIMES instead of guessing text boundaries (a push can
     * decode past an <EOU>, so text-length splits overshoot). */
    get streamSegments() {
        if (!this.stream || !this.tokenizer)
            return [];
        return tokensToWords(this.stream.ids, this.stream.idTimes, this.tokenizer.id2token);
    }
    reset() {
        if (this.stream) {
            disposeEncodeStream(this.ctx, this.stream.encSt);
            this.ctx?.trimPool();
        }
        this.stream = null;
    }
    consume(frames) {
        const s = this.stream;
        const n = frames.length / PROJ_D; // stream frames arrive pre-projected [n, 640]
        const { ids, idFrames, events } = eouWasmDecodeCont(this.wdec, frames, n, s.subT);
        s.ids.push(...ids);
        s.idTimes.push(...idFrames.map((f) => f * FRAME_SEC));
        for (const e of events)
            s.events.push({ type: e.type, time: +(e.frame * FRAME_SEC).toFixed(2) });
        s.subT += n;
    }
    async dispose() {
        this.reset();
        this.worker?.terminate();
        this.worker = null;
        this.ctx?.destroy();
        this.ctx = this.enc = this.dec = this.wdec = this.projW = this.projB = this.mel = this.tokenizer = null;
    }
}
