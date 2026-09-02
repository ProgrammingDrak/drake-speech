use anyhow::{Context, Result, anyhow, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use interprocess::TryClone;
#[cfg(unix)]
use interprocess::local_socket::GenericFilePath;
#[cfg(windows)]
use interprocess::local_socket::GenericNamespaced;
use interprocess::local_socket::{ListenerOptions, prelude::*};
use parakeet_rs::{ParakeetEOU, ParakeetEOUHandle};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const PROTOCOL_MAJOR: u64 = 1;
const PROTOCOL_MINOR: u64 = 0;
const FRAME_JSON: u8 = 1;
const FRAME_PCM_F32LE: u8 = 2;
const MAX_FRAME: usize = 64 * 1024 * 1024;
const NATIVE_MODEL_BYTES: u64 = 480_708_981;
const MODEL_REPO: &str = "altunenes/parakeet-rs";
const MODEL_REVISION: &str = "a61d2818df4659c956b9661a9447f46e98c15126";
const MODEL_SUBDIR: &str = "realtime_eou_120m-v1-onnx";
const IDLE_UNLOAD: Duration = Duration::from_secs(15 * 60);
const CHUNK_SAMPLES: usize = 2_560;

const MODEL_FILES: &[ModelFile] = &[
    ModelFile {
        name: "encoder.onnx",
        bytes: 459_341_289,
        sha256: "93e1f5e2efd60f305495b2ace07d2baade8e2f7ed087b847b5fa2514e138e611",
    },
    ModelFile {
        name: "decoder_joint.onnx",
        bytes: 21_347_639,
        sha256: "cdf95c774a2d27ec04bb0e06145c61a34dcf5639125b2833fb3ee2051845ee31",
    },
    ModelFile {
        name: "tokenizer.json",
        bytes: 20_053,
        sha256: "f6b0ad8690559351fa478116fe0985a203b76f7c040f3a9381f485c99c0325f8",
    },
];

struct ModelFile {
    name: &'static str,
    bytes: u64,
    sha256: &'static str,
}

struct SharedState {
    model: Mutex<ModelState>,
    active: AtomicBool,
    last_used: Mutex<Instant>,
    model_dir: PathBuf,
}

struct ModelState {
    handle: Option<ParakeetEOUHandle>,
    loading: bool,
    error: Option<ServiceError>,
}

#[derive(Clone)]
struct ServiceError {
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct Request {
    version: ProtocolVersion,
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct ProtocolVersion {
    major: u64,
    #[allow(dead_code)]
    minor: u64,
}

#[derive(Clone, Copy, PartialEq)]
enum InputMode {
    Microphone,
    Pcm,
}

struct Session {
    id: String,
    mode: InputMode,
    lead_in: Duration,
    silence: Duration,
    tx: Option<mpsc::Sender<WorkerCommand>>,
    pending_samples: Option<usize>,
}

enum WorkerCommand {
    Audio(Vec<f32>),
    Stop,
    Cancel,
}

type Writer = Arc<Mutex<LocalSocketStream>>;

fn main() -> Result<()> {
    let app_dir = app_data_dir()?;
    let model_dir = app_dir
        .join("models")
        .join("parakeet-realtime-eou-120m-v1")
        .join(MODEL_REVISION);
    secure_create_dir(&model_dir)?;
    let state = Arc::new(SharedState {
        model: Mutex::new(ModelState {
            handle: None,
            loading: false,
            error: None,
        }),
        active: AtomicBool::new(false),
        last_used: Mutex::new(Instant::now()),
        model_dir,
    });
    start_idle_unloader(Arc::clone(&state));

    let endpoint = endpoint(&app_dir)?;
    let listener = create_listener(&endpoint)?;
    secure_socket(&endpoint)?;
    eprintln!("Drake Speech service ready at {}", endpoint.display());

    for connection in listener.incoming() {
        match connection {
            Ok(stream) => {
                let state = Arc::clone(&state);
                thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, state) {
                        eprintln!("Speech client disconnected: {error:#}");
                    }
                });
            }
            Err(error) => eprintln!("Speech connection failed: {error}"),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_listener(endpoint: &Path) -> Result<LocalSocketListener> {
    let name = endpoint.to_fs_name::<GenericFilePath>()?;
    ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .context("create Unix socket")
}

#[cfg(windows)]
fn create_listener(endpoint: &Path) -> Result<LocalSocketListener> {
    use interprocess::os::windows::local_socket::ListenerOptionsExt;
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    use widestring::U16CString;
    let endpoint_name = endpoint.to_string_lossy().into_owned();
    let name = endpoint_name.to_ns_name::<GenericNamespaced>()?;
    let sddl = U16CString::from_str("D:P(A;;GA;;;OW)")?;
    let security = SecurityDescriptor::deserialize(&sddl)?;
    ListenerOptions::new()
        .name(name)
        .security_descriptor(security)
        .create_sync()
        .context("create named pipe")
}

fn handle_connection(stream: LocalSocketStream, state: Arc<SharedState>) -> Result<()> {
    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    let mut reader = BufReader::new(stream);
    let mut session: Option<Session> = None;

    loop {
        let frame = match read_frame(&mut reader) {
            Ok(frame) => frame,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error.into()),
        };
        match frame.0 {
            FRAME_JSON => {
                let request: Request =
                    serde_json::from_slice(&frame.1).context("decode control frame")?;
                if request.version.major != PROTOCOL_MAJOR {
                    reply_error(
                        &writer,
                        &request.id,
                        "unsupported_protocol",
                        "This protocol major is unsupported.",
                    )?;
                    continue;
                }
                handle_request(request, &writer, &state, &mut session)?;
            }
            FRAME_PCM_F32LE => {
                let Some(active) = session.as_mut() else {
                    send_event(
                        &writer,
                        "error",
                        json!({ "code": "no_session", "message": "No session accepts PCM." }),
                    )?;
                    continue;
                };
                let expected = active.pending_samples.take().unwrap_or(0);
                if active.mode != InputMode::Pcm || frame.1.len() != expected.saturating_mul(4) {
                    send_event(
                        &writer,
                        "error",
                        json!({ "sessionId": active.id, "code": "invalid_pcm", "message": "PCM frame size does not match its control frame." }),
                    )?;
                    continue;
                }
                let samples = bytes_to_f32(&frame.1);
                if let Some(tx) = &active.tx {
                    let _ = tx.send(WorkerCommand::Audio(samples));
                }
            }
            _ => send_event(
                &writer,
                "error",
                json!({ "code": "unknown_frame", "message": "Unknown frame type." }),
            )?,
        }
    }
    if let Some(active) = session {
        if let Some(tx) = active.tx {
            let _ = tx.send(WorkerCommand::Cancel);
        }
        state.active.store(false, Ordering::SeqCst);
    }
    Ok(())
}

fn handle_request(
    request: Request,
    writer: &Writer,
    state: &Arc<SharedState>,
    session: &mut Option<Session>,
) -> Result<()> {
    match request.kind.as_str() {
        "hello" => reply_ok(
            writer,
            &request.id,
            json!({ "version": version(), "service": "drake-speech-service" }),
        ),
        "status" => reply_ok(writer, &request.id, status(state)),
        "prepare" => match prepare_model(state, Some(writer)) {
            Ok(()) => reply_ok(writer, &request.id, status(state)),
            Err(error) => reply_error(writer, &request.id, "prepare_failed", &format!("{error:#}")),
        },
        "clear_model" => {
            if state.active.load(Ordering::SeqCst) {
                reply_error(
                    writer,
                    &request.id,
                    "busy",
                    "Stop the active session first.",
                )
            } else {
                let mut model = state
                    .model
                    .lock()
                    .map_err(|_| anyhow!("model lock poisoned"))?;
                model.handle = None;
                model.error = None;
                if state.model_dir.exists() {
                    fs::remove_dir_all(&state.model_dir)
                        .context("remove package model directory")?;
                }
                secure_create_dir(&state.model_dir)?;
                reply_ok(writer, &request.id, status(state))
            }
        }
        "create_session" => {
            if state.active.swap(true, Ordering::SeqCst) {
                return reply_error(
                    writer,
                    &request.id,
                    "busy",
                    "Another transcription session is active.",
                );
            }
            let mode = match request
                .payload
                .get("inputMode")
                .and_then(Value::as_str)
                .unwrap_or("microphone")
            {
                "microphone" => InputMode::Microphone,
                "pcm" => InputMode::Pcm,
                _ => {
                    state.active.store(false, Ordering::SeqCst);
                    return reply_error(
                        writer,
                        &request.id,
                        "invalid_input_mode",
                        "Input mode must be microphone or pcm.",
                    );
                }
            };
            if request
                .payload
                .get("language")
                .and_then(Value::as_str)
                .unwrap_or("en")
                != "en"
            {
                state.active.store(false, Ordering::SeqCst);
                return reply_error(
                    writer,
                    &request.id,
                    "unsupported_language",
                    "Version one supports English only.",
                );
            }
            let id = Uuid::new_v4().to_string();
            *session = Some(Session {
                id: id.clone(),
                mode,
                lead_in: Duration::from_millis(
                    request
                        .payload
                        .get("leadInTimeoutMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(8_000),
                ),
                silence: Duration::from_millis(
                    request
                        .payload
                        .get("silenceTimeoutMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(2_500),
                ),
                tx: None,
                pending_samples: None,
            });
            reply_ok(writer, &request.id, json!({ "sessionId": id }))
        }
        "start" => {
            let Some(active) = session.as_mut() else {
                return reply_error(writer, &request.id, "no_session", "Create a session first.");
            };
            if active.tx.is_some() {
                return reply_error(
                    writer,
                    &request.id,
                    "invalid_state",
                    "The session already started.",
                );
            }
            if let Err(error) = prepare_model(state, Some(writer)) {
                state.active.store(false, Ordering::SeqCst);
                return reply_error(writer, &request.id, "prepare_failed", &format!("{error:#}"));
            }
            let handle = state
                .model
                .lock()
                .map_err(|_| anyhow!("model lock poisoned"))?
                .handle
                .clone()
                .context("model missing after preparation")?;
            let (tx, rx) = mpsc::channel();
            active.tx = Some(tx.clone());
            let worker = WorkerConfig {
                id: active.id.clone(),
                mode: active.mode,
                lead_in: active.lead_in,
                silence: active.silence,
            };
            let writer_clone = Arc::clone(writer);
            let state_clone = Arc::clone(state);
            thread::spawn(move || run_session(worker, handle, rx, tx, writer_clone, state_clone));
            reply_ok(writer, &request.id, json!({ "started": true }))
        }
        "pcm" => {
            let Some(active) = session.as_mut() else {
                return reply_error(writer, &request.id, "no_session", "Create a session first.");
            };
            if active.mode != InputMode::Pcm || active.tx.is_none() {
                return reply_error(
                    writer,
                    &request.id,
                    "invalid_state",
                    "A running PCM session is required.",
                );
            }
            active.pending_samples = request
                .payload
                .get("samples")
                .and_then(Value::as_u64)
                .map(|value| value as usize);
            reply_ok(writer, &request.id, json!({ "accepted": true }))
        }
        "stop" | "cancel" => {
            let Some(active) = session.take() else {
                return reply_ok(writer, &request.id, json!({ "stopped": true }));
            };
            if let Some(tx) = active.tx {
                let _ = tx.send(if request.kind == "stop" {
                    WorkerCommand::Stop
                } else {
                    WorkerCommand::Cancel
                });
            } else {
                state.active.store(false, Ordering::SeqCst);
            }
            reply_ok(writer, &request.id, json!({ "stopped": true }))
        }
        _ => reply_error(
            writer,
            &request.id,
            "unknown_request",
            "Unknown request type.",
        ),
    }
}

struct WorkerConfig {
    id: String,
    mode: InputMode,
    lead_in: Duration,
    silence: Duration,
}

fn run_session(
    config: WorkerConfig,
    handle: ParakeetEOUHandle,
    rx: mpsc::Receiver<WorkerCommand>,
    tx: mpsc::Sender<WorkerCommand>,
    writer: Writer,
    state: Arc<SharedState>,
) {
    let result = run_session_inner(&config, handle, rx, tx, &writer);
    if let Err(error) = result {
        let _ = send_event(
            &writer,
            "error",
            json!({ "sessionId": config.id, "code": "inference_failed", "message": format!("{error:#}") }),
        );
    }
    state.active.store(false, Ordering::SeqCst);
    if let Ok(mut last_used) = state.last_used.lock() {
        *last_used = Instant::now();
    }
}

fn run_session_inner(
    config: &WorkerConfig,
    handle: ParakeetEOUHandle,
    rx: mpsc::Receiver<WorkerCommand>,
    tx: mpsc::Sender<WorkerCommand>,
    writer: &Writer,
) -> Result<()> {
    let mut model = ParakeetEOU::from_shared(&handle);
    let _microphone = if config.mode == InputMode::Microphone {
        Some(start_microphone(tx)?)
    } else {
        None
    };
    let started = Instant::now();
    let mut last_voice: Option<Instant> = None;
    let mut pending = Vec::<f32>::with_capacity(CHUNK_SAMPLES * 2);
    let mut transcript = String::new();
    let mut published = String::new();
    let mut processed_samples = 0usize;

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(WorkerCommand::Audio(samples)) => {
                if audio_rms(&samples) >= 0.012 {
                    last_voice = Some(Instant::now());
                }
                pending.extend_from_slice(&samples);
                while pending.len() >= CHUNK_SAMPLES {
                    let chunk: Vec<f32> = pending.drain(..CHUNK_SAMPLES).collect();
                    if transcribe_chunk(&mut model, &chunk, &mut transcript)? {
                        send_event(
                            writer,
                            "final",
                            json!({ "sessionId": config.id, "text": transcript.trim() }),
                        )?;
                        return Ok(());
                    }
                    processed_samples += CHUNK_SAMPLES;
                    send_event(
                        writer,
                        "progress",
                        json!({ "sessionId": config.id, "processedSeconds": processed_samples as f64 / 16_000.0 }),
                    )?;
                    if !transcript.is_empty() && transcript != published {
                        send_event(
                            writer,
                            "partial",
                            json!({ "sessionId": config.id, "text": transcript.trim() }),
                        )?;
                        published.clone_from(&transcript);
                    }
                }
            }
            Ok(WorkerCommand::Stop) => {
                if !pending.is_empty() {
                    pending.resize(CHUNK_SAMPLES, 0.0);
                    transcribe_chunk(&mut model, &pending, &mut transcript)?;
                }
                for _ in 0..3 {
                    transcribe_chunk(&mut model, &vec![0.0; CHUNK_SAMPLES], &mut transcript)?;
                }
                if transcript.trim().is_empty() {
                    send_event(
                        writer,
                        "silence",
                        json!({ "sessionId": config.id, "reason": "empty" }),
                    )?;
                } else {
                    send_event(
                        writer,
                        "final",
                        json!({ "sessionId": config.id, "text": transcript.trim() }),
                    )?;
                }
                return Ok(());
            }
            Ok(WorkerCommand::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last_voice.is_none() && started.elapsed() >= config.lead_in {
                    send_event(
                        writer,
                        "silence",
                        json!({ "sessionId": config.id, "reason": "lead-in" }),
                    )?;
                    return Ok(());
                }
                if last_voice.is_some_and(|time| time.elapsed() >= config.silence) {
                    if transcript.trim().is_empty() {
                        send_event(
                            writer,
                            "silence",
                            json!({ "sessionId": config.id, "reason": "empty" }),
                        )?;
                    } else {
                        send_event(
                            writer,
                            "final",
                            json!({ "sessionId": config.id, "text": transcript.trim() }),
                        )?;
                    }
                    return Ok(());
                }
            }
        }
    }
}

fn transcribe_chunk(
    model: &mut ParakeetEOU,
    chunk: &[f32],
    transcript: &mut String,
) -> Result<bool> {
    let text = model
        .transcribe(chunk, true)
        .context("Parakeet inference")?;
    let endpoint = text.contains("[EOU]") || text.contains("<EOU>");
    let clean = text
        .replace("[EOU]", "")
        .replace("<EOU>", "")
        .replace("[EOB]", "")
        .replace("<EOB>", "");
    transcript.push_str(&clean);
    Ok(endpoint)
}

fn start_microphone(tx: mpsc::Sender<WorkerCommand>) -> Result<cpal::Stream> {
    let device = cpal::default_host()
        .default_input_device()
        .context("no microphone is available")?;
    let supported = device
        .default_input_config()
        .context("read microphone configuration")?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let config: cpal::StreamConfig = supported.clone().into();
    let on_error = move |_error| {};
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| send_audio(data.iter().copied(), channels, sample_rate, &tx),
            on_error,
            None,
        )?,
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| {
                send_audio(
                    data.iter().map(|v| *v as f32 / 32768.0),
                    channels,
                    sample_rate,
                    &tx,
                )
            },
            on_error,
            None,
        )?,
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _| {
                send_audio(
                    data.iter().map(|v| *v as f32 / 32768.0 - 1.0),
                    channels,
                    sample_rate,
                    &tx,
                )
            },
            on_error,
            None,
        )?,
        format => bail!("unsupported microphone sample format {format:?}"),
    };
    stream.play()?;
    Ok(stream)
}

fn send_audio(
    samples: impl Iterator<Item = f32>,
    channels: usize,
    sample_rate: u32,
    tx: &mpsc::Sender<WorkerCommand>,
) {
    let raw: Vec<f32> = samples.collect();
    let mono: Vec<f32> = raw
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    let output = if sample_rate == 16_000 {
        mono
    } else {
        resample_linear(&mono, sample_rate, 16_000)
    };
    let _ = tx.send(WorkerCommand::Audio(output));
}

fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    let count = ((input.len() as u64 * to as u64) / from as u64) as usize;
    if count == 0 {
        return Vec::new();
    }
    let step = (input.len().saturating_sub(1)) as f64 / count.saturating_sub(1).max(1) as f64;
    (0..count)
        .map(|index| {
            let position = index as f64 * step;
            let left = position.floor() as usize;
            let fraction = (position - left as f64) as f32;
            input[left] * (1.0 - fraction)
                + input.get(left + 1).copied().unwrap_or(input[left]) * fraction
        })
        .collect()
}

fn prepare_model(state: &Arc<SharedState>, writer: Option<&Writer>) -> Result<()> {
    let mut model = state
        .model
        .lock()
        .map_err(|_| anyhow!("model lock poisoned"))?;
    if model.handle.is_some() {
        return Ok(());
    }
    model.loading = true;
    model.error = None;
    let result = (|| {
        secure_create_dir(&state.model_dir)?;
        let mut completed = 0;
        for file in MODEL_FILES {
            let path = state.model_dir.join(file.name);
            if verify_file(&path, file).is_err() {
                download_file(file, &path, completed, writer)?;
            }
            completed += file.bytes;
        }
        if let Some(writer) = writer {
            send_event(
                writer,
                "progress",
                json!({ "phase": "loading", "loaded": NATIVE_MODEL_BYTES, "total": NATIVE_MODEL_BYTES, "fraction": 1.0 }),
            )?;
        }
        model.handle = Some(
            ParakeetEOUHandle::from_pretrained(&state.model_dir, None)
                .context("load Parakeet model")?,
        );
        Ok(())
    })();
    model.loading = false;
    if let Err(error) = &result {
        model.error = Some(ServiceError {
            code: "prepare_failed".into(),
            message: format!("{error:#}"),
        });
    }
    result
}

fn download_file(
    file: &ModelFile,
    destination: &Path,
    completed: u64,
    writer: Option<&Writer>,
) -> Result<()> {
    let url = format!(
        "https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{MODEL_SUBDIR}/{}",
        file.name
    );
    let mut response = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?
        .get(url)
        .send()?
        .error_for_status()?;
    let part = destination.with_extension(format!(
        "{}.part",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ));
    if part.exists() {
        fs::remove_file(&part).context("remove interrupted package download")?;
    }
    let mut output = File::create(&part)?;
    let mut hash = Sha256::new();
    let mut downloaded = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = response.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
        hash.update(&buffer[..count]);
        downloaded += count as u64;
        if let Some(writer) = writer {
            send_event(
                writer,
                "progress",
                json!({ "file": file.name, "phase": "download", "loaded": completed + downloaded, "total": NATIVE_MODEL_BYTES, "fraction": (completed + downloaded) as f64 / NATIVE_MODEL_BYTES as f64 }),
            )?;
        }
    }
    output.sync_all()?;
    if downloaded != file.bytes {
        fs::remove_file(&part).ok();
        bail!(
            "model_size_mismatch:{}:{}:{}",
            file.name,
            downloaded,
            file.bytes
        );
    }
    let actual = hex::encode(hash.finalize());
    if actual != file.sha256 {
        fs::remove_file(&part).ok();
        bail!(
            "model_hash_mismatch:{}:{}:{}",
            file.name,
            actual,
            file.sha256
        );
    }
    fs::rename(&part, destination)?;
    Ok(())
}

fn verify_file(path: &Path, expected: &ModelFile) -> Result<()> {
    if fs::metadata(path)?.len() != expected.bytes {
        bail!("size mismatch");
    }
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash)?;
    if hex::encode(hash.finalize()) != expected.sha256 {
        bail!("hash mismatch");
    }
    Ok(())
}

fn status(state: &Arc<SharedState>) -> Value {
    let installed = MODEL_FILES.iter().all(|file| {
        fs::metadata(state.model_dir.join(file.name))
            .map(|metadata| metadata.len() == file.bytes)
            .unwrap_or(false)
    });
    match state.model.lock() {
        Ok(model) => json!({
            "support": "supported", "installation": if installed { "installed" } else { "not-installed" },
            "loading": if model.loading { "loading" } else { "idle" }, "ready": model.handle.is_some(),
            "error": model.error.as_ref().map(|error| json!({ "code": error.code, "message": error.message })),
            "modelBytes": NATIVE_MODEL_BYTES, "backend": "cpu"
        }),
        Err(_) => {
            json!({ "support": "supported", "installation": "unknown", "loading": "idle", "ready": false, "error": { "code": "state_failed", "message": "Model state is unavailable." }, "modelBytes": NATIVE_MODEL_BYTES, "backend": "cpu" })
        }
    }
}

fn start_idle_unloader(state: Arc<SharedState>) {
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(60));
            if state.active.load(Ordering::SeqCst) {
                continue;
            }
            let idle = state
                .last_used
                .lock()
                .map(|time| time.elapsed())
                .unwrap_or_default();
            if idle >= IDLE_UNLOAD {
                if let Ok(mut model) = state.model.lock() {
                    model.handle = None;
                }
            }
        }
    });
}

fn read_frame(reader: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut header = [0u8; 5];
    reader.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header[1..5].try_into().unwrap()) as usize;
    if size > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame exceeds 64 MiB",
        ));
    }
    let mut payload = vec![0u8; size];
    reader.read_exact(&mut payload)?;
    Ok((header[0], payload))
}

fn write_json(writer: &Writer, value: &Value) -> Result<()> {
    let payload = serde_json::to_vec(value)?;
    let mut stream = writer.lock().map_err(|_| anyhow!("writer lock poisoned"))?;
    stream.write_all(&[FRAME_JSON])?;
    stream.write_all(&(payload.len() as u32).to_be_bytes())?;
    stream.write_all(&payload)?;
    Ok(())
}

fn reply_ok(writer: &Writer, id: &str, result: Value) -> Result<()> {
    write_json(
        writer,
        &json!({ "version": version(), "replyTo": id, "ok": true, "result": result }),
    )
}

fn reply_error(writer: &Writer, id: &str, code: &str, message: &str) -> Result<()> {
    write_json(
        writer,
        &json!({ "version": version(), "replyTo": id, "ok": false, "error": { "code": code, "message": message } }),
    )
}

fn send_event(writer: &Writer, event: &str, payload: Value) -> Result<()> {
    write_json(
        writer,
        &json!({ "version": version(), "type": "event", "event": event, "payload": payload }),
    )
}

fn version() -> Value {
    json!({ "major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR })
}

fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
        .collect()
}

fn audio_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

fn app_data_dir() -> Result<PathBuf> {
    dirs::data_local_dir()
        .context("user application data directory is unavailable")
        .map(|path| path.join("Drake Speech"))
}

#[cfg(unix)]
fn endpoint(app_dir: &Path) -> Result<PathBuf> {
    let run = app_dir.join("run");
    secure_create_dir(&run)?;
    Ok(run.join("speech-v1.sock"))
}

#[cfg(windows)]
fn endpoint(_app_dir: &Path) -> Result<PathBuf> {
    let username = std::env::var("USERNAME")
        .unwrap_or_else(|_| "user".into())
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "_.-".contains(character) {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    Ok(PathBuf::from(format!("drake-speech-v1-{username}")))
}

fn secure_create_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(unix)]
fn secure_socket(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(windows)]
fn secure_socket(_path: &Path) -> Result<()> {
    Ok(())
}
