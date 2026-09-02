# Validation status

## Passing locally

- Browser runtime state transitions
- Single-session `busy` rejection
- Cancellation without a false final event
- Parakeet endpoint finalization
- Lead-in silence timeout
- Fragmented IPC frame decoding
- Unknown protocol-major rejection
- Exact model size and SHA-256 verification
- Missing and interrupted download rejection
- Corrupt browser-cache replacement
- Static audio-path privacy audit
- Native service type compilation with `cargo check`
- Line Learner unit suite, type check, and production build
- Line Learner model-cache survival policy
- Build-pattern catalog validation

## Hardware gates still required

These gates need model downloads, audio fixtures, or target devices.

- Browser and native WER against the same English corpus
- Five percent maximum WER
- Every representative theatrical line passing the matcher
- M4 first-partial and finalization latency
- Representative Windows x64 finalization latency
- Thirty-minute bounded-memory sessions
- Offline transcription with all network requests blocked
- Chrome, Edge, Firefox, macOS Safari, iPhone Safari, and iPad Safari

The final macOS service link also needs more free disk space.
Compilation passed before the linker exhausted the remaining disk.
