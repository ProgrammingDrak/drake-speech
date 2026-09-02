// Fetch model files from Hugging Face and persist them via the Cache API so the
// (often hundreds of MB) weights are downloaded once per browser. Reports byte
// progress for the UI.
export const CACHE_NAME = "drake-speech-models-v1";
const HF_BASE = "https://huggingface.co";
/** Resolve `repo` + `path` to the HF `resolve/main` URL. */
export function hfUrl(repo, path, revision = "main") {
    return `${HF_BASE}/${repo}/resolve/${revision}/${path}`;
}
/**
 * Fetch a single URL as bytes, using the Cache API and streaming progress.
 * `opts.skipCache` bypasses the cache entirely — for mutable URLs (e.g. local
 * dev exports that change when an extractor re-runs), where a stale cached
 * manifest could silently pair with fresh sibling files.
 */
export async function fetchCached(url, onProgress, label = url, opts) {
    // Cache API is best-effort: opening/matching/putting can throw (quota, or the
    // per-entry size limit — a 600 MB weight file exceeds it in Chrome), and that
    // must never fail the load.
    let cache = null;
    try {
        if (opts?.skipCache)
            throw new Error("skip");
        cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(url);
        if (hit) {
            const bytes = new Uint8Array(await hit.arrayBuffer());
            try {
                await verify(bytes, opts, label, onProgress);
                return bytes;
            }
            catch (error) {
                await cache.delete(url).catch(() => false);
                // Continue with a clean network fetch. The fresh verified bytes
                // replace this corrupt package-owned entry below.
            }
        }
    }
    catch {
        cache = null;
    }
    // referrerPolicy no-referrer: HF hotlink-protects some hosts (e.g. *.workers.dev)
    // by returning 404 when the Referer is theirs → surfaces as a CORS error. The
    // page-level <meta name="referrer"> covers third-party libs; this covers ours.
    const res = await fetch(url, { referrerPolicy: "no-referrer" });
    if (!res.ok || !res.body)
        throw new Error(`fetch ${url} → ${res.status}`);
    // SPA hosts (e.g. Cloudflare single-page-application fallback) answer missing
    // assets with index.html + HTTP 200; caching that would poison the model
    // cache until the user clears site storage.
    if ((res.headers.get("content-type") || "").includes("text/html")) {
        throw new Error(`fetch ${url} → HTML instead of a model asset (file not deployed?)`);
    }
    const total = Number(res.headers.get("content-length") || 0);
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.({ file: label, phase: "download", loaded, total, fraction: total ? loaded / total : 0 });
    }
    const bytes = concat(chunks, loaded);
    await verify(bytes, opts, label, onProgress);
    // Store a fresh Response so subsequent loads are instant — best-effort: Chrome's
    // Cache API rejects entries beyond a few hundred MB ("Failed to execute 'put'"),
    // so on failure we just skip caching (re-download next time) rather than fail.
    if (cache) {
        try {
            await cache.put(url, new Response(bytes, { headers: { "content-length": String(loaded) } }));
        }
        catch {
            /* too large to cache — fine, keep going uncached */
        }
    }
    return bytes;
}
/** Fetch many files, aggregating progress across the set. */
export async function fetchAll(files, onProgress) {
    const out = new Map();
    let doneBytes = 0;
    // Rough overall fraction: weight each file equally in count, refine by bytes.
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const url = hfUrl(f.repo, f.path, f.revision);
        const bytes = await fetchCached(url, (p) => {
            onProgress?.({
                file: f.path,
                phase: p.phase,
                loaded: doneBytes + p.loaded,
                total: 0,
                fraction: (i + p.fraction) / files.length,
            });
        }, f.path);
        doneBytes += bytes.byteLength;
        out.set(f.path, bytes);
    }
    return out;
}
export async function clearModelCache() {
    await caches.delete(CACHE_NAME);
}
async function verify(bytes, opts, label, onProgress) {
    if (opts?.expectedBytes !== undefined && bytes.byteLength !== opts.expectedBytes) {
        throw new Error(`model_size_mismatch:${label}:${bytes.byteLength}:${opts.expectedBytes}`);
    }
    if (!opts?.expectedSha256)
        return;
    if (!globalThis.crypto?.subtle)
        throw new Error("model_hash_unsupported:Web Crypto is unavailable");
    onProgress?.({ file: label, phase: "load", loaded: 0, total: bytes.byteLength, fraction: 0 });
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== opts.expectedSha256.toLowerCase())
        throw new Error(`model_hash_mismatch:${label}:${actual}:${opts.expectedSha256}`);
    onProgress?.({ file: label, phase: "load", loaded: bytes.byteLength, total: bytes.byteLength, fraction: 1 });
}
function concat(chunks, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
    }
    return out;
}
