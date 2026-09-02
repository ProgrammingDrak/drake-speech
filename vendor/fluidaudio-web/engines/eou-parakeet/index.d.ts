import type { AsrEngine, AsrResult, AudioData, ProgressCb, StreamingAsrEngine, TranscribeOpts } from "../../core/types.js";
import type { AsrSegment } from "../../core/types.js";
export declare class ParakeetEouEngine implements AsrEngine, StreamingAsrEngine {
    readonly id = "eou-parakeet";
    readonly label = "Parakeet EOU 120M";
    private ctx;
    private enc;
    private dec;
    private mel;
    private tokenizer;
    private wdec;
    private decSrc;
    private worker;
    private workerFailed;
    private projW;
    private projB;
    private stream;
    private op;
    private serialize;
    load(onProgress?: ProgressCb): Promise<void>;
    private ensureWorker;
    transcribe(audio: AudioData, opts?: TranscribeOpts): Promise<AsrResult & {
        events?: {
            type: string;
            time: number;
        }[];
    }>;
    private transcribeInner;
    /** Feed 16 kHz samples; returns the text emitted so far (plus buffered state). */
    push(chunk: Float32Array): Promise<string>;
    private pushInner;
    /** Flush the right-padded tail and return the final utterance text. */
    finish(): Promise<string>;
    private finishInner;
    /** <EOU>/<EOB> events seen so far on the current stream (seconds). */
    get streamEvents(): {
        type: string;
        time: number;
    }[];
    /** Word segments decoded so far on the current stream — lets consumers split
     * utterances at event TIMES instead of guessing text boundaries (a push can
     * decode past an <EOU>, so text-length splits overshoot). */
    get streamSegments(): AsrSegment[];
    reset(): void;
    private consume;
    dispose(): Promise<void>;
}
