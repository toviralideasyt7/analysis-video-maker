//! MP4 validation via ffprobe. Degrades to `UNKNOWN` when ffprobe is not on
//! the machine instead of pretending the file was verified.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub file: String,
    pub status: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    pub problems: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ProbeExpectation {
    pub min_duration: Option<f64>,
    pub max_duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
}

fn ffprobe_candidates() -> Vec<String> {
    let mut v = Vec::new();
    if let Ok(p) = std::env::var("DATARACE_FFPROBE") {
        if !p.trim().is_empty() {
            v.push(p);
        }
    }
    v.push("ffprobe".to_string());
    v
}

fn run_ffprobe(path: &Path) -> Option<(String, String)> {
    for exe in ffprobe_candidates() {
        let out = Command::new(&exe)
            .args([
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(path)
            .output();
        if let Ok(o) = out {
            if o.status.success() {
                return Some((exe, String::from_utf8_lossy(&o.stdout).to_string()));
            }
        }
    }
    None
}

fn parse_fraction(s: &str) -> Option<f64> {
    let mut it = s.split('/');
    let num: f64 = it.next()?.trim().parse().ok()?;
    let den: f64 = it.next().unwrap_or("1").trim().parse().ok()?;
    if den == 0.0 {
        return None;
    }
    Some(num / den)
}

pub fn probe_mp4(path: &Path, expect: Option<&ProbeExpectation>) -> ProbeReport {
    let mut problems: Vec<String> = Vec::new();
    if !path.exists() {
        return ProbeReport {
            file: path.display().to_string(),
            status: "FAILED".into(),
            size_bytes: 0,
            duration_seconds: None,
            width: None,
            height: None,
            fps: None,
            video_codec: None,
            audio_codec: None,
            problems: vec!["file does not exist".into()],
            tool: None,
        };
    }
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        problems.push("file is empty".into());
    }

    let Some((tool, raw)) = run_ffprobe(path) else {
        return ProbeReport {
            file: path.display().to_string(),
            status: "UNKNOWN".into(),
            size_bytes: size,
            duration_seconds: None,
            width: None,
            height: None,
            fps: None,
            video_codec: None,
            audio_codec: None,
            problems: vec![
                "ffprobe is not available, so the container could not be validated".into(),
            ],
            tool: None,
        };
    };

    let json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            problems.push(format!("ffprobe output could not be parsed: {}", e));
            serde_json::Value::Null
        }
    };

    let duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse::<f64>().ok());

    let mut width = None;
    let mut height = None;
    let mut fps = None;
    let mut video_codec = None;
    let mut audio_codec = None;
    if let Some(streams) = json.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let kind = s.get("codec_type").and_then(|c| c.as_str()).unwrap_or("");
            if kind == "video" && video_codec.is_none() {
                video_codec = s.get("codec_name").and_then(|c| c.as_str()).map(String::from);
                width = s.get("width").and_then(|w| w.as_u64()).map(|w| w as u32);
                height = s.get("height").and_then(|h| h.as_u64()).map(|h| h as u32);
                fps = s
                    .get("r_frame_rate")
                    .and_then(|r| r.as_str())
                    .and_then(parse_fraction);
            } else if kind == "audio" && audio_codec.is_none() {
                audio_codec = s.get("codec_name").and_then(|c| c.as_str()).map(String::from);
            }
        }
    }

    if let Some(e) = expect {
        if let Some(min) = e.min_duration {
            match duration {
                Some(d) if d < min => problems.push(format!("duration {}s is below the expected minimum {}s", d, min)),
                None => problems.push("duration could not be determined".into()),
                _ => {}
            }
        }
        if let Some(max) = e.max_duration {
            if let Some(d) = duration {
                if d > max {
                    problems.push(format!("duration {}s exceeds the expected maximum {}s", d, max));
                }
            }
        }
        if let Some(w) = e.width {
            if width != Some(w) {
                problems.push(format!("width is {:?}, expected {}", width, w));
            }
        }
        if let Some(h) = e.height {
            if height != Some(h) {
                problems.push(format!("height is {:?}, expected {}", height, h));
            }
        }
        if let Some(f) = e.fps {
            if let Some(actual) = fps {
                if (actual - f).abs() > 0.5 {
                    problems.push(format!("fps is {}, expected {}", actual, f));
                }
            }
        }
    }

    ProbeReport {
        file: path.display().to_string(),
        status: if problems.is_empty() { "VERIFIED".into() } else { "FAILED".into() },
        size_bytes: size,
        duration_seconds: duration,
        width,
        height,
        fps,
        video_codec,
        audio_codec,
        problems,
        tool: Some(tool),
    }
}