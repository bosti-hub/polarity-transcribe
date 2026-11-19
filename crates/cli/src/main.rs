//! `pt` — command-line harness for the Polarity Transcribe engine.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use pt_core::asr::{build_prompt, AsrModel, AsrParams, Language};
use pt_core::chunker::{self, ChunkOpts};
use pt_core::ffmpeg::{self, Channel, DecodeOpts};
use pt_core::lexicon;
use pt_core::vad::{self, SegmentOpts, Vad};
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser)]
#[command(name = "pt", about = "Polarity Transcribe engine harness")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Clone, Copy, ValueEnum, PartialEq)]
enum PromptMode {
    /// No prompt at all.
    None,
    /// Verbatim primer on every chunk.
    Primer,
    /// Verbatim primer plus the tail of the previous chunk.
    Context,
}

#[derive(Clone, Copy, ValueEnum)]
enum Chan {
    Mix,
    Left,
    Right,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the whole pipeline on a project (created on the fly from --in1/--in2).
    Run {
        /// Data folder holding projects.
        #[arg(long, default_value = "bench-out/data")]
        data: PathBuf,
        /// Reuse an existing project id instead of importing again.
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        in1: Option<PathBuf>,
        #[arg(long)]
        in2: Option<PathBuf>,
        #[arg(long, value_delimiter = ',')]
        trim1: Option<Vec<f64>>,
        #[arg(long, value_delimiter = ',')]
        trim2: Option<Vec<f64>>,
        #[arg(long, default_value = "nl")]
        lang: String,
        #[arg(long, default_value = "models/ggml-large-v3-turbo-q8_0.bin")]
        model: PathBuf,
        #[arg(long, default_value = "models/ggml-silero-v5.1.2.bin")]
        vad_model: PathBuf,
        #[arg(long, default_value = "models/wespeaker_en_voxceleb_resnet34_LM.onnx")]
        voice_model: PathBuf,
        #[arg(long, default_value_t = 2)]
        speakers: u8,
        #[arg(long, default_value_t = 8)]
        threads: usize,
        #[arg(long)]
        fast: bool,
        #[arg(long)]
        gpu: bool,
        /// Stop after this many seconds (to test resuming).
        #[arg(long)]
        stop_after: Option<f64>,
    },
    /// Estimate the time alignment of the two sources in a project folder.
    Sync {
        dir: PathBuf,
        /// Trim of source 1: start,end in seconds.
        #[arg(long, value_delimiter = ',')]
        trim1: Option<Vec<f64>>,
        #[arg(long, value_delimiter = ',')]
        trim2: Option<Vec<f64>>,
    },
    /// Import a file into a scratch project folder and print the stereo verdict.
    Import {
        input: PathBuf,
        /// Folder to write caches to (created if missing).
        #[arg(long, default_value = "bench-out/import")]
        out: PathBuf,
        #[arg(long, default_value_t = 0)]
        slot: usize,
    },
    /// Transcribe a slice of a file and report speed and filler statistics.
    Bench {
        input: PathBuf,
        #[arg(long, default_value = "models/ggml-large-v3-turbo-q5_0.bin")]
        model: PathBuf,
        #[arg(long, default_value = "models/ggml-silero-v5.1.2.bin")]
        vad_model: PathBuf,
        #[arg(long, default_value_t = 0.0)]
        start: f64,
        #[arg(long, default_value_t = 300.0)]
        duration: f64,
        #[arg(long, default_value = "nl")]
        lang: String,
        #[arg(long, default_value_t = 4)]
        threads: usize,
        #[arg(long, default_value_t = 1)]
        beam: usize,
        #[arg(long, value_enum, default_value = "primer")]
        prompt: PromptMode,
        #[arg(long, value_enum, default_value = "mix")]
        channel: Chan,
        #[arg(long)]
        gpu: bool,
        /// Write words with timings as JSON.
        #[arg(long)]
        json: Option<PathBuf>,
        /// Print per-word timings and probabilities.
        #[arg(long)]
        words: bool,
        /// Write each chunk's audio (16 kHz mono f32, raw little-endian) and a chunks.json
        /// here, so another recogniser can be run on exactly the same chunks.
        #[arg(long)]
        dump_chunks: Option<PathBuf>,
    },
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Run { data, project, in1, in2, trim1, trim2, lang, model, vad_model, voice_model, speakers, threads, fast, gpu, stop_after } => {
            use pt_core::pipeline::{self, JobConfig, Outcome};
            use pt_core::project::Store;
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::Arc;
            let lang = Language::parse(&lang).context("language must be nl or en")?;
            let store = Store::new(data.join("projects"))?;
            let mut p = match project {
                Some(id) => store.load(&id)?,
                None => {
                    let mut p = store.create("cli", lang)?;
                    let dir = store.dir(&p.id)?;
                    let never = AtomicBool::new(false);
                    for (slot, input) in [in1, in2].into_iter().enumerate() {
                        if let Some(input) = input {
                            let t = Instant::now();
                            p.sources[slot] = Some(pt_core::import::import_source(&dir, slot, &input, &never, |_| {})?);
                            eprintln!("imported {} in {:.1}s", input.display(), t.elapsed().as_secs_f64());
                        }
                    }
                    p
                }
            };
            p.language = lang;
            p.speaker_count = speakers;
            for (slot, trim) in [trim1, trim2].into_iter().enumerate() {
                if let (Some(src), Some([a, b])) = (p.sources[slot].as_mut(), trim.as_deref()) {
                    src.trim_start = *a;
                    src.trim_end = b.min(src.duration);
                }
            }
            store.save(&mut p)?;
            eprintln!("project {} layout {:?}", p.id, p.layout());
            for s in p.sources.iter().flatten() {
                eprintln!("  {} {:.1}s stereo={:?} trim {:.1}..{:.1}", s.file_name, s.duration, s.stereo.kind, s.trim_start, s.trim_end);
            }
            let cfg = JobConfig {
                model_id: model.file_name().unwrap().to_string_lossy().into_owned(),
                model,
                vad_model,
                voice_model: Some(voice_model),
                threads,
                use_gpu: gpu,
                fast,
                extra_glossary: Vec::new(),
            };
            let cancel = Arc::new(AtomicBool::new(false));
            if let Some(secs) = stop_after {
                let c = cancel.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs_f64(secs));
                    c.store(true, Ordering::Relaxed);
                });
            }
            let t = Instant::now();
            let mut last = Instant::now();
            let mut stage = None;
            let outcome = pipeline::run(&store, &p.id, &cfg, &cancel, &mut |pr| {
                if stage != Some(pr.stage) {
                    stage = Some(pr.stage);
                    eprintln!("  [{:6.1}s] {:?} starts", t.elapsed().as_secs_f64(), pr.stage);
                }
                if last.elapsed().as_secs_f64() > 5.0 || pr.fraction >= 1.0 {
                    last = Instant::now();
                    eprintln!("  {:?} {:5.1}%  eta {:?}", pr.stage, pr.fraction * 100.0, pr.eta_seconds.map(|e| e.round()));
                }
            })?;
            eprintln!("outcome {:?} after {:.1}s", outcome, t.elapsed().as_secs_f64());
            if outcome == Outcome::Done {
                let dir = store.dir(&p.id)?;
                let tr: pt_core::transcript::Transcript = pt_core::fsutil::read_json(&dir.join("transcript.json"))?;
                let report: serde_json::Value = pt_core::fsutil::read_json(&dir.join("report.json"))?;
                eprintln!("{}", serde_json::to_string_pretty(&report)?);
                for para in &tr.paragraphs {
                    let text: Vec<String> = para
                        .items
                        .iter()
                        .map(|i| match i {
                            pt_core::transcript::Item::Word { t, c, .. } => if *c < 0.5 { format!("{t}?") } else { t.clone() },
                            pt_core::transcript::Item::Pause { s, e } => format!("[stilte {:.1}s]", e - s),
                            pt_core::transcript::Item::Backchannel { sp, t, .. } => format!("[{sp}: {t}]"),
                            pt_core::transcript::Item::Note { t, .. } => t.clone(),
                        })
                        .collect();
                    println!("{} [{}] {}", para.speaker, fmt_time(para.start), text.join(" "));
                }
            }
        }
        Cmd::Sync { dir, trim1, trim2 } => {
            use pt_core::fsutil::{pcm_len, pcm_read};
            use pt_core::sync::{estimate, Track};
            let (p1, p2) = (dir.join("source1_l.pcm"), dir.join("source2_l.pcm"));
            let (d1, d2) = (pcm_len(&p1)? as f64 / 16_000.0, pcm_len(&p2)? as f64 / 16_000.0);
            let range = |t: &Option<Vec<f64>>, d: f64| match t.as_deref() {
                Some([a, b]) => (*a, b.min(d)),
                _ => (0.0, d),
            };
            let (s1, e1) = range(&trim1, d1);
            let (s2, e2) = range(&trim2, d2);
            let mut r1 = |start: i64, len: usize| read_at(&p1, start, len);
            let mut r2 = |start: i64, len: usize| read_at(&p2, start, len);
            fn read_at(p: &std::path::Path, start: i64, len: usize) -> Result<Vec<f32>> {
                if start >= 0 {
                    return pcm_read(p, start as u64, len);
                }
                let skip = ((-start) as usize).min(len);
                let mut v = vec![0f32; skip];
                v.extend(pcm_read(p, 0, len - skip)?);
                Ok(v)
            }
            let t = Instant::now();
            let mut t1 = Track { read: &mut r1, start: s1, end: e1 };
            let mut t2 = Track { read: &mut r2, start: s2, end: e2 };
            let (map, report) = estimate(&mut t1, &mut t2, |_| {})?;
            eprintln!("sync took {:.1}s", t.elapsed().as_secs_f64());
            println!("{}", serde_json::to_string_pretty(&report)?);
            println!("segments: {}", serde_json::to_string(&map.segments)?);
        }
        Cmd::Import { input, out, slot } => {
            std::fs::create_dir_all(&out)?;
            let t = Instant::now();
            let cancel = std::sync::atomic::AtomicBool::new(false);
            let src = pt_core::import::import_source(&out, slot, &input, &cancel, |f| {
                eprint!("\rimporting {:5.1}%", f * 100.0);
            })?;
            eprintln!("\rimported {:.1}s of audio in {:.1}s", src.duration, t.elapsed().as_secs_f64());
            println!("{}", serde_json::to_string_pretty(&src)?);
        }
        Cmd::Bench { input, model, vad_model, start, duration, lang, threads, beam, prompt, channel, gpu, json, words, dump_chunks } => {
            let lang = Language::parse(&lang).context("language must be nl or en")?;
            let channel = match channel {
                Chan::Mix => Channel::Mix,
                Chan::Left => Channel::Left,
                Chan::Right => Channel::Right,
            };
            let t = Instant::now();
            let audio = ffmpeg::decode_mono(&input, &DecodeOpts::mono(channel).range(start, duration))?;
            let audio_sec = audio.len() as f64 / 16_000.0;
            eprintln!("decoded {audio_sec:.1}s in {:.2}s", t.elapsed().as_secs_f64());

            let t = Instant::now();
            let mut vad = Vad::new(&vad_model, threads)?;
            let probs = vad.probabilities(&audio, |_| {})?;
            let speech = vad::segments(&probs, &SegmentOpts::default());
            let speech_sec: f64 = speech.iter().map(|s| s.len()).sum();
            let vad_time = t.elapsed().as_secs_f64();
            let chunks = chunker::plan(&speech, audio_sec, Some(&probs), &ChunkOpts::default());
            eprintln!(
                "vad: {} spans, {speech_sec:.1}s speech, {} chunks, {vad_time:.2}s",
                speech.len(),
                chunks.len()
            );

            if words {
                for s in &speech {
                    println!("  speech {:>8.2} {:>8.2}", start + s.start, start + s.end);
                }
            }
            if let Some(dir) = &dump_chunks {
                std::fs::create_dir_all(dir)?;
                let mut index = Vec::new();
                for (i, ch) in chunks.iter().enumerate() {
                    let samples = ch.extract(&audio, 16_000);
                    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
                    std::fs::write(dir.join(format!("{i:04}.f32")), bytes)?;
                    let span = ch.span();
                    index.push(serde_json::json!({
                        "chunk": i,
                        "start": start + span.start,
                        "end": start + span.end,
                        "audio": ch.duration(),
                    }));
                }
                std::fs::write(dir.join("chunks.json"), serde_json::to_vec_pretty(&index)?)?;
                eprintln!("wrote {} chunks to {}", chunks.len(), dir.display());
            }
            let t = Instant::now();
            let asr = AsrModel::load(&model, gpu)?;
            let mut session = asr.session()?;
            eprintln!(
                "model loaded in {:.2}s on {}",
                t.elapsed().as_secs_f64(),
                asr.device.as_ref().map(|d| d.name.as_str()).unwrap_or("the processor")
            );

            let t = Instant::now();
            let mut all = Vec::new();
            let mut tail: Option<String> = None;
            let mut fillers = 0usize;
            let mut n_words = 0usize;
            for (i, ch) in chunks.iter().enumerate() {
                let samples = ch.extract(&audio, 16_000);
                let p = match prompt {
                    PromptMode::None => String::new(),
                    PromptMode::Primer => build_prompt(lang, &[], None),
                    PromptMode::Context => build_prompt(lang, &[], tail.as_deref()),
                };
                let ct = Instant::now();
                let out = session.transcribe(&samples, &AsrParams { beam_size: beam, prompt: p, ..AsrParams::new(lang, threads) })?;
                let text = out.text();
                let span = ch.span();
                println!(
                    "#{i:03} [{}–{}] ({:.1}s audio, {:.1}s wall, lp {:.2}, nsp {:.2})\n  {text}",
                    fmt_time(start + span.start),
                    fmt_time(start + span.end),
                    ch.duration(),
                    ct.elapsed().as_secs_f64(),
                    out.avg_logprob,
                    out.no_speech_prob
                );
                if words {
                    for w in &out.words {
                        println!(
                            "      {:>8.2} {:>8.2}  p={:.2}  {}",
                            start + ch.to_source(w.start as f64),
                            start + ch.to_source(w.end as f64),
                            w.prob,
                            w.text
                        );
                    }
                }
                for w in &out.words {
                    n_words += 1;
                    if lexicon::is_filler(&w.text, lang) {
                        fillers += 1;
                    }
                    all.push(serde_json::json!({
                        "text": w.text,
                        "start": start + ch.to_source(w.start as f64),
                        "end": start + ch.to_source(w.end as f64),
                        "prob": w.prob,
                        "chunk": i,
                    }));
                }
                let chars: Vec<char> = text.chars().collect();
                let from = chars.len().saturating_sub(160);
                tail = Some(chars[from..].iter().collect());
            }
            let wall = t.elapsed().as_secs_f64();
            eprintln!(
                "\n== {n_words} words, {fillers} fillers ({:.1}%), asr {wall:.1}s for {audio_sec:.1}s audio (RTF {:.3}, {:.1}x realtime), threads {threads}",
                100.0 * fillers as f64 / n_words.max(1) as f64,
                wall / audio_sec,
                audio_sec / wall
            );
            if std::env::var_os("PT_NATIVE_LOGS").is_some() {
                asr.print_timings();
            }
            if let Some(path) = json {
                std::fs::write(&path, serde_json::to_vec_pretty(&all)?)?;
            }
        }
    }
    Ok(())
}

fn fmt_time(t: f64) -> String {
    let m = (t / 60.0).floor() as u64;
    format!("{m:02}:{:04.1}", t - m as f64 * 60.0)
}
