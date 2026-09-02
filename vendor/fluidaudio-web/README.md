# Vendored FluidAudio Web subset

This directory contains only the browser files required by Parakeet EOU.

- Source: `https://github.com/FluidInference/fluidaudio-web`
- Commit: `ab738c92b8a6af0dcdfe51dddd062427a5ec7689`
- License: MIT

Included code covers microphone capture, model caching, Parakeet EOU,
streaming mel features, WebGPU kernels, and the WASM fallback.

Local changes:

- Renamed the model cache to `drake-speech-models-v1`.
- Pinned every Hugging Face revision.
- Added exact SHA-256 and byte-count checks.
- Removed Node-only and unrelated engine paths.
- Removed text cleanup, ITN, and unrelated audio engines.

See `LICENSE` and `THIRD-PARTY-LICENSES.md` in this directory.
