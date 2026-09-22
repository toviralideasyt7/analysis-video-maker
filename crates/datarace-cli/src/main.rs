//! `datarace` - command line front end for the deterministic core.
//!
//! Every subcommand reads JSON (or a data file), writes JSON to stdout or
//! `--out`, and exits non-zero on error so the TypeScript orchestrator can rely
//! on the exit status.

use anyhow::{bail, Context, Result};
use datarace_core::frames::{build_frame_tape, FrameOptions, InterpolationPolicy};
use datarace_core::model::{DatasetInput, EntityInput};
use datarace_core::{dates, entities, hash, ingest, probe, rank, units, validate};
use std::path::PathBuf;

const HELP: &str = r#"datarace - deterministic data core for analysis-video-maker

USAGE
  datarace <command> [options]

COMMANDS
  ingest    --in <file.csv|tsv|json|jsonl|xlsx> [--out <file>]
            Convert a raw tabular file into a rectangular JSON table.

  normalize --in <dataset.json> [--out <file>] [--target-unit <unit>]
            Parse dates, normalize units and resolve entities.
            Missing values stay missing (status UNKNOWN).

  rank      --in <dataset.json> [--out <file>] [--top N] [--mover N]
            Reproducible per-period rankings.

  frames    --in <dataset.json> [--out <file>] [--top N]
            [--frames-per-transition N] [--fps N] [--width N] [--height N]
            [--policy strict|carryForward] [--mover N]
            Per-frame bar-race tape consumed by the renderer.

  validate  --in <dataset.json> [--out <file>] [--max-date YYYY-MM-DD] [--strict]
            Specification data-quality report. --strict exits 2 when
            violations > 0 (CI gate).

  hash      --in <file|json-string> [--out <file>] [--json]
            Stable SHA-256 content hash.

  probe     --in <file.mp4> [--expect-duration MIN:MAX] [--expect-size WxH]
            [--expect-fps N] [--out <file>]
            Validate a rendered MP4 (needs ffprobe; reports UNKNOWN without it).

  entities  --names a,b,c | --in <names.json> [--out <file>]
            Resolve entity names to canonical entities.

  countries [--out <file>]
            Dump the bundled ISO-3166 reference table.

  --help | -h
"#;

struct Args {
    command: String,
    flags: Vec<(String, String)>,
}

impl Args {
    fn parse(raw: Vec<String>) -> Result<Args> {
        let mut command = String::new();
        let mut flags: Vec<(String, String)> = Vec::new();
        let mut i = 0;
        while i < raw.len() {
            let a = &raw[i];
            if a.starts_with("--") {
                let key = a.trim_start_matches('-').to_string();
                let next = raw.get(i + 1);
                match next {
                    Some(v) if !v.starts_with("--") => {
                        flags.push((key, v.clone()));
                        i += 2;
                    }
                    _ => {
                        flags.push((key, "true".to_string()));
                        i += 1;
                    }
                }
            } else if a.starts_with('-') && a.len() == 2 {
                let key = match a.as_str() {
                    "-h" => "help",
                    other => other.trim_start_matches('-'),
                };
                flags.push((key.to_string(), "true".to_string()));
                i += 1;
            } else {
                if command.is_empty() {
                    command = a.clone();
                } else {
                    flags.push(("_arg".to_string(), a.clone()));
                }
                i += 1;
            }
        }
        Ok(Args { command, flags })
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.flags
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    fn get_usize(&self, key: &str, default: usize) -> usize {
        self.get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
    }

    fn get_u32(&self, key: &str, default: u32) -> u32 {
        self.get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
    }

    fn get_i64(&self, key: &str, default: i64) -> i64 {
        self.get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
    }

    fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
}

fn read_to_string(path: &str) -> Result<String> {
    if path == "-" {
        use std::io::Read;
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s)?;
        return Ok(s);
    }
    std::fs::read_to_string(path).with_context(|| format!("reading {}", path))
}

fn load_dataset(path: &str) -> Result<DatasetInput> {
    let text = read_to_string(path)?;
    let ds: DatasetInput =
        serde_json::from_str(&text).with_context(|| format!("parsing dataset {}", path))?;
    Ok(ds)
}

fn emit(out: Option<&str>, value: &serde_json::Value) -> Result<()> {
    let text = serde_json::to_string_pretty(value)?;
    match out {
        Some(p) => {
            std::fs::write(p, text).with_context(|| format!("writing {}", p))?;
            println!("{{\"written\":\"{}\"}}", p.replace('\\', "/"));
        }
        None => println!("{}", text),
    }
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("datarace: error: {:#}", e);
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() {
        print!("{}", HELP);
        return Ok(());
    }
    let args = Args::parse(argv)?;
    if args.command.is_empty() || args.has("help") || args.command == "help" {
        print!("{}", HELP);
        return Ok(());
    }
    let out = args.get("out").map(|s| s.to_string());

    match args.command.as_str() {
        "ingest" => {
            let Some(input) = args.get("in") else { bail!("ingest requires --in <file>") };
            let tables = ingest::ingest_file(&PathBuf::from(input))?;
            let payload = serde_json::json!({ "tables": tables, "count": tables.len() });
            emit(out.as_deref(), &payload)?;
        }
        "normalize" => {
            let Some(input) = args.get("in") else { bail!("normalize requires --in <dataset.json>") };
            let ds = load_dataset(input)?;
            let target_unit = args.get("target-unit").map(|s| s.to_string());
            let mut observations = Vec::new();
            let mut dropped = Vec::new();
            let mut entities_out = Vec::new();
            for (i, o) in ds.observations.iter().enumerate() {
                let parsed = match dates::parse_date(&o.date) {
                    Some(p) => p,
                    None => {
                        dropped.push(serde_json::json!({ "index": i, "reason": "unparsable-date", "date": o.date }));
                        continue;
                    }
                };
                let unit_info = o
                    .unit
                    .clone()
                    .or_else(|| ds.unit.clone())
                    .map(|u| units::normalize_unit(&u));
                let mut value = o.value;
                let mut conversion = None;
                if let (Some(v), Some(info), Some(target)) = (value, unit_info.as_ref(), target_unit.as_ref()) {
                    if let Some(converted) = units::convert(v, &info.input, target) {
                        conversion = Some(serde_json::json!({
                            "from": info.canonical, "to": units::normalize_unit(target).canonical, "factor": info.factor
                        }));
                        value = Some(converted);
                    }
                }
                let resolution = entities::resolve(&o.entity_name());
                if !entities_out.iter().any(|e: &serde_json::Value| e["id"] == serde_json::json!(resolution.entity.id)) {
                    entities_out.push(serde_json::to_value(&resolution.entity)?);
                }
                observations.push(serde_json::json!({
                    "observationId": format!("obs_{:05}", i + 1),
                    "entity": resolution.entity,
                    "entityResolution": resolution.status,
                    "date": parsed.iso,
                    "frequency": parsed.frequency.as_str(),
                    "sortKey": parsed.sort_key,
                    "value": value,
                    "status": if value.is_none() { "UNKNOWN" } else { o.status.as_deref().unwrap_or("SUPPORTED") },
                    "unit": unit_info.as_ref().map(|u| u.canonical.clone()),
                    "unitDimension": unit_info.as_ref().map(|u| u.dimension.clone()),
                    "unitKnown": unit_info.as_ref().map(|u| u.known),
                    "conversion": conversion,
                    "geography": o.geography,
                    "source": o.source.as_ref().and_then(|s| s.text()),
                    "sourceUrl": o.source_url,
                    "confidence": o.confidence
                }));
            }
            let payload = serde_json::json!({
                "name": ds.name,
                "metric": ds.metric,
                "unit": ds.unit,
                "observations": observations,
                "entities": entities_out,
                "dropped": dropped,
                "notes": ["values are never imputed; a missing value serializes as null with status UNKNOWN"]
            });
            emit(out.as_deref(), &payload)?;
        }
        "rank" => {
            let Some(input) = args.get("in") else { bail!("rank requires --in <dataset.json>") };
            let ds = load_dataset(input)?;
            let top = args.get_usize("top", usize::MAX / 2);
            let mover = args.get_i64("mover", 2);
            let (ranking, _) = rank::rank_dataset(&ds, top, mover);
            emit(out.as_deref(), &serde_json::to_value(&ranking)?)?;
        }
        "frames" => {
            let Some(input) = args.get("in") else { bail!("frames requires --in <dataset.json>") };
            let ds = load_dataset(input)?;
            let policy = match args.get("policy").unwrap_or("carryForward") {
                "strict" => InterpolationPolicy::Strict,
                "carryForward" => InterpolationPolicy::CarryForward,
                other => bail!("unknown --policy {:?} (use strict|carryForward)", other),
            };
            let opts = FrameOptions {
                top_n: args.get_usize("top", 10),
                frames_per_transition: args.get_usize("frames-per-transition", 30),
                fps: args.get_u32("fps", 30),
                width: args.get_u32("width", 1280),
                height: args.get_u32("height", 720),
                mover_threshold: args.get_i64("mover", 2),
                policy,
            };
            let tape = build_frame_tape(&ds, &opts);
            emit(out.as_deref(), &serde_json::to_value(&tape)?)?;
        }
        "validate" => {
            let Some(input) = args.get("in") else { bail!("validate requires --in <dataset.json>") };
            let ds = load_dataset(input)?;
            let max_date = args
                .get("max-date")
                .map(|s| s.to_string())
                .unwrap_or_else(datarace_core::dates::today_iso);
            let report = validate::validate_dataset(&ds, &max_date);
            emit(out.as_deref(), &serde_json::to_value(&report)?)?;
            if args.has("strict") && report.violations > 0 {
                eprintln!("datarace: {} data-quality violations", report.violations);
                std::process::exit(2);
            }
        }
        "hash" => {
            let Some(input) = args.get("in") else { bail!("hash requires --in <file|string>") };
            let digest = if args.has("json") {
                let v: serde_json::Value = serde_json::from_str(&read_to_string(input)?)?;
                hash::sha256_json(&v)
            } else {
                let path = PathBuf::from(input);
                if path.exists() && path.is_file() {
                    hash::sha256_file(&path)?
                } else {
                    hash::sha256_bytes(input.as_bytes())
                }
            };
            emit(out.as_deref(), &serde_json::json!({ "input": input, "sha256": digest }))?;
        }
        "probe" => {
            let Some(input) = args.get("in") else { bail!("probe requires --in <file.mp4>") };
            let mut expect = probe::ProbeExpectation::default();
            if let Some(range) = args.get("expect-duration") {
                let mut parts = range.split(':');
                expect.min_duration = parts.next().and_then(|v| v.parse().ok());
                expect.max_duration = parts.next().and_then(|v| v.parse().ok());
            }
            if let Some(size) = args.get("expect-size") {
                let mut parts = size.split('x');
                expect.width = parts.next().and_then(|v| v.parse().ok());
                expect.height = parts.next().and_then(|v| v.parse().ok());
            }
            if let Some(fps) = args.get("expect-fps").and_then(|v| v.parse().ok()) {
                expect.fps = Some(fps);
            }
            let expect = if expect.min_duration.is_none() && expect.max_duration.is_none() && expect.width.is_none() && expect.height.is_none() && expect.fps.is_none() {
                None
            } else {
                Some(expect)
            };
            let report = probe::probe_mp4(&PathBuf::from(input), expect.as_ref());
            emit(out.as_deref(), &serde_json::to_value(&report)?)?;
            if report.status == "FAILED" {
                std::process::exit(3);
            }
        }
        "entities" => {
            let names: Vec<String> = if let Some(list) = args.get("names") {
                list.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
            } else if let Some(input) = args.get("in") {
                serde_json::from_str(&read_to_string(input)?)?
            } else {
                bail!("entities requires --names a,b,c or --in <names.json>")
            };
            let resolved = entities::resolve_many(&names);
            emit(out.as_deref(), &serde_json::to_value(&resolved)?)?;
        }
        "countries" => {
            emit(out.as_deref(), &serde_json::to_value(entities::countries())?)?;
        }
        other => bail!("unknown command {:?}\n\n{}", other, HELP),
    }
    Ok(())
}

#[allow(dead_code)]
fn unused_entity_input(_e: EntityInput) {}