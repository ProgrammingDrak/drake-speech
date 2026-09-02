# Drake Speech

Reusable local speech transcription for browser and native applications.

Version one uses NVIDIA Parakeet Realtime EOU 120M v1. It supports English.
It performs no transcript cleanup, ITN, or filler removal.

## Packages

- `drake-speech/browser` runs direct WebGPU or WASM inference.
- `drake-speech/client` connects native apps to the background service.
- `drake-speech/protocol` defines versioned JSON and PCM frames.
- `native/service` builds `drake-speech-service`.

Both runtimes expose the same lifecycle:

```js
const status = runtime.status();
await runtime.prepare((progress) => console.log(progress.fraction));
const session = await runtime.createSession({ inputMode: 'microphone' });
session.on('partial', ({ text }) => show(text));
session.on('final', ({ text }) => commit(text));
await session.start();
```

Browser `status()` is synchronous. Native `status()` returns a promise.

Sessions expose `start`, `stop`, `cancel`, and `dispose`. PCM sessions also
accept 16 kHz mono `Float32Array` samples through `push`.

## Privacy and security

- Audio and transcript content stays on the device.
- The package records no audio, transcripts, telemetry, or application content.
- The native service opens no TCP ports.
- macOS uses a user-owned Unix socket with mode `0600`.
- Windows uses a named pipe with an owner-only security descriptor.
- Only one transcription session can run. Others receive `busy`.
- The native model unloads after fifteen idle minutes.

## Model storage

The browser downloads 240,453,556 bytes into `drake-speech-models-v1`.
The native service downloads 480,708,981 bytes into user application data.

Every model URL uses a pinned revision. Every file has a pinned byte count and
SHA-256 hash. See `model-manifest.json`.

`clearModel()` removes only package-owned model data.

## Build and test

```sh
npm test
npm run check
cd native/service
cargo check --locked
cargo build --release --locked
```

Install the macOS service:

```sh
sh native/install/macos/install.sh native/service/target/release/drake-speech-service
```

Install the Windows service from PowerShell:

```powershell
.\native\install\windows\install.ps1 .\native\service\target\release\drake-speech-service.exe
```

## Pinned upstreams

- FluidAudio Web: `ab738c92b8a6af0dcdfe51dddd062427a5ec7689`
- parakeet-rs: `1d6ffeae1b8641f497e4ef9a5e9fff37aa7a4181`
- Browser model: `6c6bcda07b23fd91778062b435b1a5f2f6d07504`
- Native model: `a61d2818df4659c956b9661a9447f46e98c15126`

The planned parakeet-rs commit disappeared from the upstream repository.
Version one pins the current reachable commit shown above.

FluidVoice and Fluid Intelligence code and assets remain excluded.
