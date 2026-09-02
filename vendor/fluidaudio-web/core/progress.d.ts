import type { TranscribeProgress } from "./types.js";
export declare function makeTranscribeProgress(totalSeconds: number, onProgress?: (p: TranscribeProgress) => void): {
    update(processedSeconds: number): void;
    done(): void;
} | null;
