import type { AsrSegment } from "./types.js";
/** Token (id, time) stream → word-level segments. `skipId` filters control
 * tokens (blank/EOU/EOB); tokens missing from id2token are ignored. */
export declare function tokensToWords(ids: number[], times: number[], id2token: string[] | Record<number, string>, skipId?: (id: number) => boolean): AsrSegment[];
/** Group words into caption cues: break on silence gaps, cue duration, or
 * line length — the standard readable-captions heuristics. */
export declare function groupCues(words: AsrSegment[], { maxGapSec, maxDurSec, maxChars }?: {
    maxGapSec?: number | undefined;
    maxDurSec?: number | undefined;
    maxChars?: number | undefined;
}): AsrSegment[];
/** Word segments → SubRip. */
export declare function segmentsToSrt(words: AsrSegment[]): string;
/** Word segments → WebVTT. */
export declare function segmentsToVtt(words: AsrSegment[]): string;
