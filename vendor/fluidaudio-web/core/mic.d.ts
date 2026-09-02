export declare class MicCapture {
    private ctx;
    private stream;
    private node;
    private chunks;
    private total;
    private baseIndex;
    private srcRate;
    /** Peak level of the most recent frame (0..1) — for a simple VU indicator. */
    level: number;
    get running(): boolean;
    /** Captured duration in seconds (at 16 kHz). */
    get seconds(): number;
    start(): Promise<void>;
    /** Last `sec` seconds (or everything, if shorter). Copies into one buffer. */
    tail(sec: number): Float32Array;
    /** Release chunks fully consumed below absolute index `to` — true-streaming
     * consumers never re-read history, so an hours-long session stays bounded.
     * tail()/all() afterwards only cover retained samples (streaming stop paths
     * don't use them). */
    dropBefore(to: number): void;
    /** Samples appended since absolute index `from` (must be ≥ any dropBefore
     * watermark); returns them + new total. For incremental consumers
     * (true-streaming engines): poll with the last returned total. */
    since(from: number): {
        samples: Float32Array;
        total: number;
    };
    /** Full capture as one buffer. */
    all(): Float32Array;
    stop(): Promise<void>;
    clear(): void;
}
