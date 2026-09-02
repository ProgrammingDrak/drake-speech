import type { ProgressCb } from "./types.js";
export declare const CACHE_NAME = "drake-speech-models-v1";
/** Resolve `repo` + `path` to the HF `resolve/main` URL. */
export declare function hfUrl(repo: string, path: string, revision?: string): string;
/**
 * Fetch a single URL as bytes, using the Cache API and streaming progress.
 * `opts.skipCache` bypasses the cache entirely — for mutable URLs (e.g. local
 * dev exports that change when an extractor re-runs), where a stale cached
 * manifest could silently pair with fresh sibling files.
 */
export declare function fetchCached(url: string, onProgress?: ProgressCb, label?: string, opts?: {
    skipCache?: boolean;
    expectedSha256?: string;
    expectedBytes?: number;
}): Promise<Uint8Array>;
/** Fetch many files, aggregating progress across the set. */
export declare function fetchAll(files: {
    repo: string;
    path: string;
    revision?: string;
}[], onProgress?: ProgressCb): Promise<Map<string, Uint8Array>>;
export declare function clearModelCache(): Promise<void>;
