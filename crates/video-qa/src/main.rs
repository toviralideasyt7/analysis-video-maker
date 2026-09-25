//! video-qa -- automated visual QA gate for data-race videos.
//!
//! Rust port of tools/video-qa/check-video.py. Compares a rendered
//! bar-chart-race MP4 against its bundle (frames.json + video-spec.json)
//! and flags the visual/animation bug classes:
//!
//!   C1  non-proportional bars
//!   C2  unstable layout
//!   C3a non-monotonic tweens
//!   C3b overlapping text labels
//!   C3c rank order/labels
//!
//! Usage:
//!     video-qa <video.mp4> --frames bundles/<projectId>/ [--out report.json]
//!
//! Exit codes: 0 = clean, 1 = violations found, 2 = usage/environment error.

use anyhow::{bail, Context, Result};
use image::RgbImage;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

// ---------------------------------------------------------------- constants
// Layout constants matching the renderer (DataRace.tsx) and the Python gate.
const RACE_TOP: u32 = 112;
const RACE_BOT: u32 = 648;
const BAR_X0: u32 = 96;
const ZONE_X1: u32 = 955;
const C3C_X1: u32 = 135;
const BAR_X1: u32 = 960;
const MARGIN_X0: u32 = 50;
const MARGIN_X1: u32 = 90;

// ------------------------------------------------------------------- types
#[derive(Debug, Clone, Deserialize)]
struct Bar {
    #[serde(rename = "entityId")]
    entity_id: String,
    value: f64,
    rank: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct TapeFrame {
    bars: Vec<Bar>,
    #[serde(rename = "isPeriodBoundary", default)]
    is_period_boundary: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct Entity {
    id: String,
    color: String,
    #[serde(rename = "flagDataUri", default)]
    _flag_data_uri: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct Tape {
    frames: Vec<TapeFrame>,
    entities: Vec<Entity>,
    #[serde(rename = "topN", default)]
    top_n: Option<usize>,
    #[serde(rename = "framesPerTransition", default)]
    frames_per_transition: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
struct SceneSpec {
    id: Option<String>,
    #[serde(rename = "type", default)]
    type_: String,
    duration: f64,
    props: Option<SceneProps>,
}

#[derive(Debug, Clone, Deserialize)]
struct SceneProps {
    #[serde(rename = "tapeRange", default)]
    tape_range: Option<(usize, usize)>,
}

#[derive(Debug, Clone, Deserialize)]
struct VideoSpec {
    scenes: Vec<SceneSpec>,
}

#[derive(Debug, Clone, Serialize)]
struct Violation {
    check: String,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tape_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scene: Option<String>,
}

// ------------------------------------------------------------- image utils
/// Convert an RGB pixel to OpenCV-style HSV (H: 0-179, S: 0-255, V: 0-255).
fn rgb_to_hsv(r: u8, g: u8, b: u8) -> (i16, i16, i16) {
    let rf = r as f64 / 255.0;
    let gf = g as f64 / 255.0;
    let bf = b as f64 / 255.0;
    let cmax = rf.max(gf).max(bf);
    let cmin = rf.min(gf).min(bf);
    let delta = cmax - cmin;

    let h_deg = if delta == 0.0 {
        0.0
    } else if cmax == rf {
        60.0 * (((gf - bf) / delta) % 6.0)
    } else if cmax == gf {
        60.0 * ((bf - rf) / delta + 2.0)
    } else {
        60.0 * ((rf - gf) / delta + 4.0)
    };
    let h_deg = if h_deg < 0.0 { h_deg + 360.0 } else { h_deg };
    // OpenCV H is 0-179 (degrees / 2)
    let h = (h_deg / 2.0).round() as i16;
    let s = if cmax == 0.0 {
        0.0
    } else {
        delta / cmax
    };
    let v = cmax;
    (
        h.clamp(0, 179),
        (s * 255.0).round() as i16,
        (v * 255.0).round() as i16,
    )
}

fn hex_to_rgb(hex: &str) -> (u8, u8, u8) {
    let h = hex.trim_start_matches('#');
    let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(0);
    let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(0);
    let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(0);
    (r, g, b)
}

fn hex_to_hsv(hex: &str) -> (i16, i16, i16) {
    let (r, g, b) = hex_to_rgb(hex);
    rgb_to_hsv(r, g, b)
}

// --------------------------------------------------------------- VideoQA
struct Scene {
    id: String,
    type_: String,
    start: u64,
    nframes: u64,
    tape_range: Option<(usize, usize)>,
}

struct Measured {
    entity: String,
    value: f64,
    rank: i64,
    width: Option<u32>,
    x0: Option<u32>,
    ymid: f64,
}

struct VideoQA {
    video: PathBuf,
    tape: Tape,
    #[allow(dead_code)]
    spec: VideoSpec,
    #[allow(dead_code)]
    n_screen: u64,
    fps_render: f64,
    hues: HashMap<String, (i16, i16, i16)>,
    violations: Vec<Violation>,
    warnings: Vec<Violation>,
    imgs: HashMap<u64, RgbImage>,
    paths: HashMap<u64, PathBuf>,
    smooth_ranks: Option<Vec<HashMap<String, f64>>>,
    scenes: Vec<Scene>,
    tmpdir: PathBuf,
}

impl VideoQA {
    fn new(video: PathBuf, tape: Tape, spec: VideoSpec, n_screen: u64, fps_render: f64) -> Result<Self> {
        let hues: HashMap<String, (i16, i16, i16)> = tape
            .entities
            .iter()
            .map(|e| (e.id.clone(), hex_to_hsv(&e.color)))
            .collect();

        let mut scenes = Vec::new();
        let mut cursor = 0.0;
        for s in &spec.scenes {
            let nframes = (s.duration * fps_render).round() as u64;
            scenes.push(Scene {
                id: s.id.clone().unwrap_or_else(|| "?".to_string()),
                type_: s.type_.clone(),
                start: (cursor * fps_render).round() as u64,
                nframes,
                tape_range: s.props.as_ref().and_then(|p| p.tape_range),
            });
            cursor += s.duration;
        }

        let tmpdir = std::env::temp_dir().join(format!("videoqa-{}", std::process::id()));
        std::fs::create_dir_all(&tmpdir)?;

        Ok(VideoQA {
            video,
            tape,
            spec,
            n_screen,
            fps_render,
            hues,
            violations: Vec::new(),
            warnings: Vec::new(),
            imgs: HashMap::new(),
            paths: HashMap::new(),
            smooth_ranks: None,
            scenes,
            tmpdir,
        })
    }

    fn row_h(&self, n: usize) -> f64 {
        let top_n = self.tape.top_n.unwrap_or(n).max(1);
        (RACE_BOT - RACE_TOP) as f64 / top_n as f64
    }

    fn race_scenes(&self) -> Vec<&Scene> {
        self.scenes
            .iter()
            .filter(|s| s.type_ == "bar_race" && s.tape_range.is_some())
            .collect()
    }

    fn boundary_tape_indices(&self) -> (Vec<usize>, usize) {
        let bpt = self.tape.frames_per_transition.unwrap_or(30).max(1);
        let mut idx: Vec<usize> = self
            .tape
            .frames
            .iter()
            .enumerate()
            .filter(|(_, f)| f.is_period_boundary)
            .map(|(i, _)| i)
            .collect();
        if idx.is_empty() {
            idx = (0..self.tape.frames.len()).step_by(bpt).collect();
        }
        (idx, bpt)
    }

    fn screen_of_tape(&self, scene: &Scene, tape_idx: usize) -> u64 {
        let (t0, t1) = scene.tape_range.unwrap();
        let frac = (tape_idx as f64 - t0 as f64) / (t1 as f64 - t0 as f64).max(1.0);
        scene.start + (frac * (scene.nframes as f64 - 1.0)).round() as u64
    }

    fn tape_of_screen(&self, scene: &Scene, screen_idx: u64) -> usize {
        let (t0, t1) = scene.tape_range.unwrap();
        let frac = (screen_idx as f64 - scene.start as f64)
            / (scene.nframes as f64 - 1.0).max(1.0);
        (t0 as f64 + frac * (t1 as f64 - t0 as f64)).round() as usize
    }

    /// Settled (screen, tape) samples inside bar_race scenes.
    /// Returns (samples, mids, c2cands).
    #[allow(clippy::type_complexity)]
    fn sample_plan(
        &self,
        n_samples: usize,
    ) -> (
        Vec<(u64, usize, String)>,
        Vec<(u64, usize, String, u64)>,
        Vec<(u64, usize, String)>,
    ) {
        let (_bounds, bpt) = self.boundary_tape_indices();
        let mut blocks: Vec<(&Scene, usize)> = Vec::new();
        let mut settled: Vec<(&Scene, usize)> = Vec::new();
        for scene in self.race_scenes() {
            let (t0, t1) = scene.tape_range.unwrap();
            let mut b = (t0 / bpt) * bpt;
            while b < t0 {
                b += bpt;
            }
            let mut first = true;
            while b + bpt <= t1 {
                let mid = b + bpt / 2;
                if mid >= t0 && mid <= t1 {
                    blocks.push((scene, mid));
                    if !first {
                        settled.push((scene, mid));
                    }
                    first = false;
                }
                b += bpt;
            }
        }
        if settled.is_empty() {
            return (vec![], vec![], vec![]);
        }
        let step = (settled.len() / n_samples).max(1);
        let picks: Vec<(&Scene, usize)> = settled.iter().step_by(step).take(n_samples).cloned().collect();

        let samples: Vec<(u64, usize, String)> = picks
            .iter()
            .map(|(sc, t)| (self.screen_of_tape(sc, *t), *t, sc.id.clone()))
            .collect();

        let mut mids: Vec<(u64, usize, String, u64)> = Vec::new();
        for (s, _t, sid) in &samples {
            let sc = picks.iter().find(|(psc, _)| psc.id == *sid).unwrap().0;
            for sec in [0.2, 0.4, 0.6] {
                let sm = s + (sec * self.fps_render).round() as u64;
                if sm < sc.start + sc.nframes {
                    mids.push((sm, self.tape_of_screen(sc, sm), sid.clone(), *s));
                }
            }
        }

        let mut c2: Vec<(u64, usize, String)> = Vec::new();
        let mut seen: HashSet<u64> = HashSet::new();
        for scene in self.race_scenes() {
            for sec in [0.15, 0.3, 0.5, 0.8, 1.2, 2.0] {
                let s = scene.start + (sec * self.fps_render).round() as u64;
                if s < scene.start + scene.nframes && !seen.contains(&s) {
                    seen.insert(s);
                    c2.push((s, self.tape_of_screen(scene, s), scene.id.clone()));
                }
            }
        }
        let n_fades = c2.len();
        for (sc, t) in &blocks {
            let s = self.screen_of_tape(sc, *t);
            if !seen.contains(&s) {
                seen.insert(s);
                c2.push((s, *t, sc.id.clone()));
            }
        }
        let (fades, rest) = c2.split_at(n_fades.min(c2.len()));
        let mut fades = fades.to_vec();
        let mut rest = rest.to_vec();
        if rest.len() > 40 {
            let step = rest.len() as f64 / 40.0;
            rest = (0..40).map(|i| rest[(i as f64 * step) as usize].clone()).collect();
        }
        fades.extend(rest);
        (samples, mids, fades)
    }

    /// Extract frames via ffmpeg (batched select filter, 48 per batch).
    fn extract(&mut self, screen_indices: &HashSet<u64>) -> Result<()> {
        let mut idxs: Vec<u64> = screen_indices.iter().cloned().collect();
        idxs.sort_unstable();
        for (b, chunk) in idxs.chunks(48).enumerate() {
            let sel = chunk
                .iter()
                .map(|i| format!("eq(n\\,{})", i))
                .collect::<Vec<_>>()
                .join("+");
            let out_pat = self.tmpdir.join(format!("c{:04}-%%03d.png", b));
            let out_str = out_pat.to_string_lossy().to_string();
            let status = Command::new("ffmpeg")
                .args([
                    "-v", "error",
                    "-i", &self.video.to_string_lossy(),
                    "-vf", &format!("select='{}'", sel),
                    "-vsync", "0",
                    &out_str,
                ])
                .status()
                .context("failed to run ffmpeg")?;
            if !status.success() {
                bail!("ffmpeg frame extraction failed");
            }
            let mut got: Vec<PathBuf> = std::fs::read_dir(&self.tmpdir)?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with(&format!("c{:04}-", b)) && n.ends_with(".png"))
                        .unwrap_or(false)
                })
                .collect();
            got.sort();
            if got.len() != chunk.len() {
                bail!(
                    "extracted {} frames, expected {}",
                    got.len(),
                    chunk.len()
                );
            }
            for (i, p) in chunk.iter().zip(got.iter()) {
                self.paths.insert(*i, p.clone());
            }
        }
        Ok(())
    }

    fn img(&mut self, screen_idx: u64) -> Result<&RgbImage> {
        if !self.imgs.contains_key(&screen_idx) {
            let path = self.paths.get(&screen_idx).context("frame not extracted")?;
            let img = image::open(path)?.to_rgb8();
            self.imgs.insert(screen_idx, img);
        }
        Ok(self.imgs.get(&screen_idx).unwrap())
    }

    // ------------------------------------------------------ detection
    /// Brand-color mask for an entity. Returns None for near-gray colors
    /// (caller falls back to BGR distance).
    fn hue_mask(&self, img: &RgbImage, eid: &str) -> Option<Vec<bool>> {
        let (h, s, v) = self.hues[eid];
        if s < 40 {
            return None;
        }
        let w = (img.width()) as usize;
        let hgt = (img.height()) as usize;
        let mut mask = vec![false; w * hgt];
        for y in 0..hgt {
            for x in 0..w {
                let p = img.get_pixel(x as u32, y as u32);
                let (ph, ps, pv) = rgb_to_hsv(p[0], p[1], p[2]);
                let mut dh = (ph - h).abs();
                dh = dh.min(180 - dh);
                let vfloor = v - 80;
                if dh <= 12 && ps >= 45 && pv >= vfloor {
                    mask[y * w + x] = true;
                }
            }
        }
        Some(mask)
    }

    fn color_mask(&self, img: &RgbImage, eid: &str) -> Vec<bool> {
        let w = img.width() as usize;
        let hgt = img.height() as usize;
        let mut full = vec![false; w * hgt];

        // Zone: [RACE_TOP:RACE_BOT, BAR_X0:ZONE_X1]
        let zone_w = (ZONE_X1 - BAR_X0) as usize;
        let zone_h = (RACE_BOT - RACE_TOP) as usize;
        let mut zone = RgbImage::new(zone_w as u32, zone_h as u32);
        for y in 0..zone_h {
            for x in 0..zone_w {
                let p = img.get_pixel(BAR_X0 + x as u32, RACE_TOP + y as u32);
                zone.put_pixel(x as u32, y as u32, *p);
            }
        }

        let mask_opt = self.hue_mask(&zone, eid);
        let mask: Vec<bool> = if let Some(m) = mask_opt {
            m
        } else {
            // Fallback: BGR distance for near-gray brand colors
            let (er, eg, eb) = hex_to_rgb(
                &self.tape.entities.iter().find(|e| e.id == eid).unwrap().color,
            );
            let mut m = vec![false; zone_w * zone_h];
            for y in 0..zone_h {
                for x in 0..zone_w {
                    let p = zone.get_pixel(x as u32, y as u32);
                    let d = (p[0] as i16 - er as i16).abs()
                        + (p[1] as i16 - eg as i16).abs()
                        + (p[2] as i16 - eb as i16).abs();
                    let (_, ps, _) = rgb_to_hsv(p[0], p[1], p[2]);
                    if d < 90 && ps < 60 {
                        m[y * zone_w + x] = true;
                    }
                }
            }
            m
        };

        for y in 0..zone_h {
            for x in 0..zone_w {
                if mask[y * zone_w + x] {
                    full[(RACE_TOP as usize + y) * w + (BAR_X0 as usize + x)] = true;
                }
            }
        }
        full
    }

    /// Width (px) of entity's bar. Returns (width, x0) or (None, None).
    fn measure_bar(
        &self,
        img: &RgbImage,
        eid: &str,
        ymid: f64,
        row_h: f64,
    ) -> (Option<u32>, Option<u32>) {
        let mask = self.color_mask(img, eid);
        let w = img.width() as usize;
        let bar_h = row_h - 16.0;
        let top = ((ymid - bar_h / 2.0).round() as i64).max(0) as usize;
        let bot = ((ymid + bar_h / 2.0).round() as usize).min(img.height() as usize);
        if top >= bot {
            return (None, None);
        }

        // Column coverage: fraction of brand pixels per x in [BAR_X0, ZONE_X1)
        let n = (ZONE_X1 - BAR_X0) as usize;
        let mut cov = vec![0.0; n];
        for x in 0..n {
            let mut count = 0;
            let mut total = 0;
            for y in top..bot {
                total += 1;
                if mask[y * w + BAR_X0 as usize + x] {
                    count += 1;
                }
            }
            if total > 0 {
                cov[x] = count as f64 / total as f64;
            }
        }

        let mut i = 0;
        while i < 12 && cov[i] < 0.30 {
            i += 1;
        }
        if i >= 12 {
            return (None, None);
        }
        let x0 = BAR_X0 + i as u32;
        let mut last = i;
        let mut gap = 0;
        for (j, &c) in cov.iter().enumerate().skip(i) {
            if c >= 0.30 {
                last = j;
                gap = 0;
            } else {
                gap += 1;
                if gap >= 6 && c < 0.15 {
                    break;
                }
            }
        }
        (Some(BAR_X0 + last as u32 + 1 - x0), Some(x0))
    }

    /// Is the spotlight card visible? Saturated vertical strip at x~963.
    fn card_present(&mut self, screen_idx: u64) -> Result<bool> {
        let img = self.img(screen_idx)?.clone();
        let mut max_col = 0;
        for x in 955..975 {
            let mut count = 0;
            for y in 180..360 {
                let p = img.get_pixel(x, y);
                let (_, s, _) = rgb_to_hsv(p[0], p[1], p[2]);
                if s > 80 {
                    count += 1;
                }
            }
            max_col = max_col.max(count);
        }
        Ok(max_col > 100)
    }

    // ---------------------------------------------------------- checks
    fn add_violation(&mut self, check: &str, detail: String, frame: Option<u64>, tape_index: Option<usize>, scene: Option<String>) {
        self.violations.push(Violation {
            check: check.to_string(),
            detail,
            frame,
            tape_index,
            scene,
        });
    }

    fn add_warning(&mut self, check: &str, detail: String, frame: Option<u64>, tape_index: Option<usize>, scene: Option<String>) {
        self.warnings.push(Violation {
            check: check.to_string(),
            detail,
            frame,
            tape_index,
            scene,
        });
    }

    fn frame_rows(&self, tape_idx: usize) -> Vec<(String, f64, i64)> {
        let mut bars: Vec<(String, f64, i64)> = self.tape.frames[tape_idx]
            .bars
            .iter()
            .map(|b| (b.entity_id.clone(), b.value, b.rank))
            .collect();
        bars.sort_by_key(|(_, _, r)| *r);
        bars
    }

    fn measure_frame(&mut self, screen_idx: u64, tape_idx: usize) -> Result<Vec<Measured>> {
        let img = self.img(screen_idx)?.clone();
        let rows = self.frame_rows(tape_idx);
        let n = rows.len();
        let row_h = self.row_h(n);
        let mut out = Vec::new();
        for (k, (eid, value, rank)) in rows.iter().enumerate() {
            let ymid = RACE_TOP as f64 + (k as f64 + 0.5) * row_h;
            let (w, x0) = self.measure_bar(&img, eid, ymid, row_h);
            out.push(Measured {
                entity: eid.clone(),
                value: *value,
                rank: *rank,
                width: w,
                x0,
                ymid,
            });
        }
        Ok(out)
    }

    /// C1: bars strictly proportional to values.
    fn check_proportional(&mut self, screen_idx: u64, tape_idx: usize, scene_id: &str, measured: &[Measured]) {
        let good: Vec<&Measured> = measured
            .iter()
            .filter(|m| m.width.unwrap_or(0) > 40 && m.value > 0.0)
            .collect();
        let mut n1 = 0;
        let mut n2 = 0;
        for i in 0..good.len() {
            for j in (i + 1)..good.len() {
                let a = good[i];
                let b = good[j];
                let expected = a.value / b.value;
                let got = a.width.unwrap() as f64 / b.width.unwrap() as f64;
                let rel = (got - expected).abs() / expected;
                if rel > 0.12 && n1 < 6 {
                    self.add_violation(
                        "C1-non-proportional-bars",
                        format!(
                            "{} ({:.2}) vs {} ({:.2}): value ratio {:.2} but bar-width ratio {:.2} (widths {}px vs {}px)",
                            a.entity, a.value, b.entity, b.value, expected, got,
                            a.width.unwrap(), b.width.unwrap()
                        ),
                        Some(screen_idx), Some(tape_idx), Some(scene_id.to_string()),
                    );
                    n1 += 1;
                }
                let wa = a.width.unwrap() as f64;
                let wb = b.width.unwrap() as f64;
                if expected > 1.5
                    && wa.min(wb) > 20.0
                    && (wa - wb).abs() / wa.max(wb) < 0.03
                    && n2 < 6
                {
                    self.add_violation(
                        "C1-identical-widths",
                        format!(
                            "{} ({:.2}) and {} ({:.2}) render at the SAME width ({}px) despite a {:.1}x value ratio -- min-width clamp is destroying the ranking",
                            a.entity, a.value, b.entity, b.value, a.width.unwrap(), expected
                        ),
                        Some(screen_idx), Some(tape_idx), Some(scene_id.to_string()),
                    );
                    n2 += 1;
                }
            }
        }
    }

    /// C2: layout stable across spotlight cycle.
    fn check_layout_stable(&mut self, samples: &[(u64, usize, String, Vec<Measured>)]) -> Result<()> {
        let mut by_card: HashMap<bool, Vec<(u64, u32)>> = HashMap::new();
        by_card.insert(true, Vec::new());
        by_card.insert(false, Vec::new());
        let mut x0s: Vec<u32> = Vec::new();

        for (screen_idx, _tape_idx, _scene_id, measured) in samples {
            let lead = measured.iter().min_by_key(|m| m.rank).unwrap();
            if lead.width.is_none() {
                continue;
            }
            let card = self.card_present(*screen_idx)?;
            by_card.get_mut(&card).unwrap().push((*screen_idx, lead.width.unwrap()));
            if let Some(x0) = lead.x0 {
                x0s.push(x0);
            }
        }

        let widths: Vec<u32> = by_card.values().flat_map(|v| v.iter().map(|(_, w)| *w)).collect();
        let both_states = !by_card[&true].is_empty() && !by_card[&false].is_empty();
        let enough = widths.len() >= 3 || (both_states && widths.len() >= 2);
        let mut fired = false;

        if enough {
            let min_w = *widths.iter().min().unwrap();
            let max_w = *widths.iter().max().unwrap();
            let spread = max_w - min_w;
            if spread > 12 {
                fired = true;
                let shown: Vec<u32> = by_card[&true].iter().map(|(_, w)| *w).collect();
                let hidden: Vec<u32> = by_card[&false].iter().map(|(_, w)| *w).collect();
                self.add_violation(
                    "C2-layout-unstable",
                    format!(
                        "leader bar width varies {}px..{}px (spread {}px) across sampled frames while its value fraction is 1.0 -- the race width must stay constant",
                        min_w, max_w, spread
                    ),
                    None, None, None,
                );
                let _ = (shown, hidden);
            }
        }
        if !fired && !both_states && widths.len() >= 2 {
            let state = if !by_card[&true].is_empty() { "shown" } else { "hidden" };
            self.add_warning(
                "C2-inconclusive",
                format!(
                    "spotlight card was {} in all {} sampled frames -- could not observe both card states, layout-vs-card comparison skipped",
                    state, widths.len()
                ),
                None, None, None,
            );
        }
        if x0s.len() >= 3 {
            let min_x = *x0s.iter().min().unwrap();
            let max_x = *x0s.iter().max().unwrap();
            let spread = max_x - min_x;
            if spread > 6 {
                self.add_violation(
                    "C2-bar-shifted",
                    format!(
                        "leader bar left edge moves {}..{} (spread {}px); bars must stay pinned at x={}",
                        min_x, max_x, spread, BAR_X0
                    ),
                    None, None, None,
                );
            }
        }
        Ok(())
    }

    /// C3a: smooth tweens (no overshoot / teleport).
    fn check_tweens(
        &mut self,
        full: &[(u64, usize, String, Vec<Measured>)],
        mids: &[(u64, usize, String, u64, Vec<Measured>)],
    ) {
        let by_screen: HashMap<u64, (&String, &Vec<Measured>)> = full
            .iter()
            .map(|(s, _, sid, m)| (*s, (sid, m)))
            .collect();
        let mut probes: HashMap<u64, Vec<(u64, &Vec<Measured>)>> = HashMap::new();
        for (s, _, _, ss, m) in mids {
            probes.entry(*ss).or_default().push((*s, m));
        }

        for (ss, plist) in &probes {
            let (sid, m0list) = match by_screen.get(ss) {
                Some(v) => v,
                None => continue,
            };
            let m0: HashMap<&str, &Measured> =
                m0list.iter().map(|m| (m.entity.as_str(), m)).collect();
            let mut top3: Vec<&Measured> = m0.values().cloned().collect();
            top3.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap());
            top3.truncate(3);

            for tm in top3 {
                let eid = tm.entity.as_str();
                if tm.width.is_none() {
                    continue;
                }
                let mut seq = vec![tm.width.unwrap()];
                let mut ok = true;
                let mut sorted_plist = plist.clone();
                sorted_plist.sort_by_key(|(s, _)| *s);
                for (_ps, pm) in sorted_plist {
                    let d: HashMap<&str, &Measured> =
                        pm.iter().map(|m| (m.entity.as_str(), m)).collect();
                    match d.get(eid).and_then(|m| m.width) {
                        Some(w) => seq.push(w),
                        None => {
                            ok = false;
                            break;
                        }
                    }
                }
                if !ok || seq.len() < 3 {
                    continue;
                }
                let tol = 15.0_f64.max(0.04 * (*seq.first().unwrap().max(seq.last().unwrap()) as f64));
                let lo = (*seq.first().unwrap() as f64).min(*seq.last().unwrap() as f64) - tol;
                let hi = (*seq.first().unwrap() as f64).max(*seq.last().unwrap() as f64) + tol;
                for w in &seq[1..seq.len() - 1] {
                    let wf = *w as f64;
                    if !(lo <= wf && wf <= hi) {
                        self.add_violation(
                            "C3a-tween-overshoot",
                            format!(
                                "'{}': width {}px -> {}px -> {}px within 0.6s -- bar overshoots or jumps outside its endpoint range instead of gliding smoothly",
                                eid, seq[0], w, seq[seq.len() - 1]
                            ),
                            Some(*ss), None, Some((*sid).clone()),
                        );
                        break;
                    }
                }
            }
        }
    }

    /// Replicate the renderer's buildSmoothRanks (DataRace.tsx).
    fn smooth_ranks(&mut self) -> &Vec<HashMap<String, f64>> {
        if self.smooth_ranks.is_none() {
            let blend: f64 = 12.0;
            let mut displayed: HashMap<String, (f64, f64, usize)> = HashMap::new(); // eid -> (value, target, since)
            let mut smoothed: Vec<HashMap<String, f64>> = Vec::new();
            for (index, f) in self.tape.frames.iter().enumerate() {
                for bar in &f.bars {
                    let eid = bar.entity_id.clone();
                    let entry = displayed.entry(eid.clone()).or_insert((bar.rank as f64, bar.rank as f64, index));
                    if entry.1 != bar.rank as f64 {
                        entry.1 = bar.rank as f64;
                        entry.2 = index;
                    }
                    let progress = ((index as f64 - entry.2 as f64) / blend.max(1.0)).min(1.0);
                    let eased = 1.0 - (1.0 - progress).powi(3);
                    entry.0 = entry.0 + (entry.1 - entry.0) * eased;
                }
                smoothed.push(displayed.iter().map(|(k, v)| (k.clone(), v.0)).collect());
            }
            self.smooth_ranks = Some(smoothed);
        }
        self.smooth_ranks.as_ref().unwrap()
    }

    /// C3b: no label text crossing row boundaries.
    fn check_labels(&mut self, screen_idx: u64, tape_idx: usize, scene_id: &str, measured: &[Measured]) -> Result<()> {
        let img = self.img(screen_idx)?.clone();
        let w = img.width() as usize;
        let hgt = img.height() as usize;

        // dark_text = (max_rgb < 90) & ((max-min) < 40)
        let mut dark_text = vec![false; w * hgt];
        for y in 0..hgt {
            for x in 0..w {
                let p = img.get_pixel(x as u32, y as u32);
                let mx = p[0].max(p[1]).max(p[2]) as i16;
                let mn = p[0].min(p[1]).min(p[2]) as i16;
                if mx < 90 && (mx - mn) < 40 {
                    dark_text[y * w + x] = true;
                }
            }
        }

        let mut rows: Vec<&Measured> = measured.iter().collect();
        rows.sort_by(|a, b| a.ymid.partial_cmp(&b.ymid).unwrap());

        let smoothed = self.smooth_ranks().clone();
        let sdict = smoothed.get(tape_idx.min(smoothed.len().saturating_sub(1)));

        for pair in rows.windows(2) {
            let r0 = pair[0];
            let r1 = pair[1];
            // Skip mid-swap pairs (smoothed ranks < 0.75 apart)
            if let Some(sd) = sdict {
                let sr0 = sd.get(&r0.entity);
                let sr1 = sd.get(&r1.entity);
                if let (Some(a), Some(b)) = (sr0, sr1) {
                    if (a - b).abs() < 0.75 {
                        continue;
                    }
                }
            }
            let yb = ((r0.ymid + r1.ymid) / 2.0) as i64;
            let y0 = (yb - 5).max(0) as usize;
            let y1 = (yb + 5).min(hgt as i64) as usize;
            let mut count = 0;
            for y in y0..y1 {
                for x in (BAR_X0 as usize)..(BAR_X1 as usize).min(w) {
                    if dark_text[y * w + x] {
                        count += 1;
                    }
                }
            }
            if count > 500 {
                self.add_violation(
                    "C3b-label-overlap",
                    format!(
                        "text/label pixels cross the boundary between '{}' and '{}' rows ({} dark px in the boundary strip)",
                        r0.entity, r1.entity, count
                    ),
                    Some(screen_idx), None, Some(scene_id.to_string()),
                );
                break;
            }
        }
        Ok(())
    }

    /// Brand-color pixels per row band, per entity.
    fn row_entity_scores(&self, img: &RgbImage, n: usize) -> HashMap<String, Vec<u64>> {
        // Zone: [RACE_TOP:RACE_BOT, BAR_X0:C3C_X1]
        let zone_w = (C3C_X1 - BAR_X0) as usize;
        let zone_h = (RACE_BOT - RACE_TOP) as usize;
        let row_h = self.row_h(n);
        let mut scores: HashMap<String, Vec<u64>> = HashMap::new();

        for eid in self.tape.entities.iter().map(|e| &e.id) {
            let mut zone = RgbImage::new(zone_w as u32, zone_h as u32);
            for y in 0..zone_h {
                for x in 0..zone_w {
                    let p = img.get_pixel(BAR_X0 + x as u32, RACE_TOP + y as u32);
                    zone.put_pixel(x as u32, y as u32, *p);
                }
            }
            let mask_opt = self.hue_mask(&zone, eid);
            let mask: Vec<bool> = if let Some(m) = mask_opt {
                m
            } else {
                let (er, eg, eb) = hex_to_rgb(
                    &self.tape.entities.iter().find(|e| &e.id == eid).unwrap().color,
                );
                let mut m = vec![false; zone_w * zone_h];
                for y in 0..zone_h {
                    for x in 0..zone_w {
                        let p = zone.get_pixel(x as u32, y as u32);
                        let d = (p[0] as i16 - er as i16).abs()
                            + (p[1] as i16 - eg as i16).abs()
                            + (p[2] as i16 - eb as i16).abs();
                        let (_, ps, _) = rgb_to_hsv(p[0], p[1], p[2]);
                        if d < 90 && ps < 60 {
                            m[y * zone_w + x] = true;
                        }
                    }
                }
                m
            };

            let mut per_row = vec![0u64; n];
            for (k, slot) in per_row.iter_mut().enumerate() {
                let y0 = (k as f64 * row_h) as usize;
                let y1 = ((k as f64 + 1.0) * row_h) as usize;
                let mut count = 0u64;
                for y in y0.min(zone_h)..y1.min(zone_h) {
                    for x in 0..zone_w {
                        if mask[y * zone_w + x] {
                            count += 1;
                        }
                    }
                }
                *slot = count;
            }
            scores.insert(eid.clone(), per_row);
        }
        scores
    }

    /// C3c: bars sit in smoothed-rank order; rank numbers present.
    fn check_ranks(&mut self, screen_idx: u64, tape_idx: usize, scene_id: &str, measured: &[Measured]) -> Result<()> {
        let img = self.img(screen_idx)?.clone();
        let n = measured.len();
        let smoothed_all = self.smooth_ranks().clone();
        let smoothed = smoothed_all.get(tape_idx).cloned().unwrap_or_default();

        let mut exp: Vec<&Measured> = measured.iter().collect();
        exp.sort_by(|a, b| {
            let sa = smoothed.get(&a.entity).cloned().unwrap_or(a.rank as f64);
            let sb = smoothed.get(&b.entity).cloned().unwrap_or(b.rank as f64);
            sa.partial_cmp(&sb).unwrap()
        });
        let expected: Vec<&str> = exp.iter().map(|m| m.entity.as_str()).collect();

        let scores = self.row_entity_scores(&img, n);
        for (k, e) in expected.iter().enumerate() {
            let s_e = scores[*e][k];
            let max_s = scores.values().map(|v| v[k]).max().unwrap_or(0);
            if max_s <= (1.5 * (s_e.max(80) as f64)) as u64 {
                continue;
            }
            let sr_e = smoothed.get(*e).cloned().unwrap_or(0.0);
            if (sr_e - (sr_e + 0.5) as i64 as f64).abs() > 0.3 {
                self.add_warning(
                    "C3c-glide-order",
                    format!(
                        "row {}: '{}' not dominant (smoothed rank {:.2}) -- mid-glide, strict order not asserted",
                        k + 1, e, sr_e
                    ),
                    Some(screen_idx), Some(tape_idx), Some(scene_id.to_string()),
                );
            } else {
                let w = scores.iter().max_by_key(|(_, v)| v[k]).map(|(eid, _)| eid).unwrap();
                self.add_violation(
                    "C3c-rank-order",
                    format!(
                        "row {}: expected '{}' ({}px) but '{}' dominates the band ({}px) -- bar order does not match the rank order",
                        k + 1, e, s_e, w, max_s
                    ),
                    Some(screen_idx), Some(tape_idx), Some(scene_id.to_string()),
                );
            }
        }

        // Rank numbers in left margin
        let w = img.width() as usize;
        let hgt = img.height() as usize;
        let mut gray = vec![false; w * hgt];
        for y in 0..hgt {
            for x in 0..w {
                let p = img.get_pixel(x as u32, y as u32);
                let mx = p[0].max(p[1]).max(p[2]) as i16;
                let mn = p[0].min(p[1]).min(p[2]) as i16;
                if (mx - mn) < 30 && (110..=215).contains(&mx) {
                    gray[y * w + x] = true;
                }
            }
        }
        let row_h = self.row_h(n);
        let mut sorted: Vec<&Measured> = measured.iter().collect();
        sorted.sort_by(|a, b| a.ymid.partial_cmp(&b.ymid).unwrap());
        for (k, m) in sorted.iter().enumerate() {
            let y0 = (RACE_TOP as f64 + k as f64 * row_h) as i64;
            let y1 = (RACE_TOP as f64 + (k as f64 + 1.0) * row_h) as i64;
            let wy0 = ((y0 as f64 - row_h / 2.0) as i64).max(0) as usize;
            let wy1 = (y1 as f64 + row_h / 2.0) as usize;
            let mut count = 0;
            for y in wy0..wy1.min(hgt) {
                for x in (MARGIN_X0 as usize)..(MARGIN_X1 as usize).min(w) {
                    if gray[y * w + x] {
                        count += 1;
                    }
                }
            }
            if count < 25 {
                self.add_violation(
                    "C3c-rank-label-missing",
                    format!(
                        "no rank number found in the left margin for row {} ('{}')",
                        k + 1, m.entity
                    ),
                    Some(screen_idx), Some(tape_idx), Some(scene_id.to_string()),
                );
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------------- run
    fn run(&mut self, n_samples: usize) -> Result<&Vec<Violation>> {
        let (samples, mids, c2cands) = self.sample_plan(n_samples);
        if samples.is_empty() {
            bail!("no bar_race scenes with tapeRange found in video-spec.json; nothing to check");
        }

        let mut all_indices: HashSet<u64> = HashSet::new();
        for (s, _, _) in &samples {
            all_indices.insert(*s);
        }
        for (s, _, _) in &c2cands {
            all_indices.insert(*s);
        }
        for (ms, _, _, _) in &mids {
            all_indices.insert(*ms);
        }
        self.extract(&all_indices)?;

        let mut full: Vec<(u64, usize, String, Vec<Measured>)> = Vec::new();
        for (screen_idx, tape_idx, scene_id) in &samples {
            let measured = self.measure_frame(*screen_idx, *tape_idx)?;
            self.check_proportional(*screen_idx, *tape_idx, scene_id, &measured);
            self.check_labels(*screen_idx, *tape_idx, scene_id, &measured)?;
            self.check_ranks(*screen_idx, *tape_idx, scene_id, &measured)?;
            full.push((*screen_idx, *tape_idx, scene_id.clone(), measured));
        }

        let mut c2_full: Vec<(u64, usize, String, Vec<Measured>)> = Vec::new();
        for (screen_idx, tape_idx, scene_id) in &c2cands {
            let measured = self.measure_frame(*screen_idx, *tape_idx)?;
            c2_full.push((*screen_idx, *tape_idx, scene_id.clone(), measured));
        }
        self.check_layout_stable(&c2_full)?;

        let mut mids_full: Vec<(u64, usize, String, u64, Vec<Measured>)> = Vec::new();
        for (ms, mt, msid, ss) in &mids {
            let measured = self.measure_frame(*ms, *mt)?;
            mids_full.push((*ms, *mt, msid.clone(), *ss, measured));
        }
        self.check_tweens(&full, &mids_full);

        Ok(&self.violations)
    }
}

// ------------------------------------------------------------------ main
fn probe_video(path: &Path) -> Result<(u32, u32, u64)> {
    let out = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,nb_frames",
            "-show_entries", "format=duration",
            "-of", "json",
        ])
        .arg(path)
        .output()
        .context("failed to run ffprobe")?;
    if !out.status.success() {
        bail!("ffprobe failed");
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)?;
    let stream = &v["streams"][0];
    let width = stream["width"].as_u64().unwrap_or(0) as u32;
    let height = stream["height"].as_u64().unwrap_or(0) as u32;
    // nb_frames may be "N/A"; fall back to duration * fps estimate via r_frame_rate
    let nb_frames = stream["nb_frames"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let duration: f64 = v["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    Ok((width, height, nb_frames.max((duration * 30.0) as u64)))
}

fn print_usage() {
    eprintln!("Usage: video-qa <video.mp4> --frames <frames.json|bundle-dir> [--out report.json] [--samples N]");
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        print_usage();
        std::process::exit(2);
    }

    let mut video: Option<String> = None;
    let mut frames_arg: Option<String> = None;
    let mut out: Option<String> = None;
    let mut samples: usize = 8;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--frames" => {
                i += 1;
                frames_arg = Some(args.get(i).context("missing --frames value")?.clone());
            }
            "--out" => {
                i += 1;
                out = Some(args.get(i).context("missing --out value")?.clone());
            }
            "--samples" => {
                i += 1;
                samples = args.get(i).context("missing --samples value")?.parse()?;
            }
            a if !a.starts_with('-') && video.is_none() => {
                video = Some(a.to_string());
            }
            a => {
                eprintln!("unknown argument: {}", a);
                print_usage();
                std::process::exit(2);
            }
        }
        i += 1;
    }

    let video = PathBuf::from(video.context("missing video path")?);
    let frames_arg = frames_arg.context("missing --frames")?;
    if !video.is_file() {
        eprintln!("ERROR: video not found: {}", video.display());
        std::process::exit(2);
    }

    let frames_path: PathBuf;
    let bundle_dir: PathBuf;
    if Path::new(&frames_arg).is_dir() {
        bundle_dir = PathBuf::from(&frames_arg);
        frames_path = bundle_dir.join("frames.json");
    } else {
        frames_path = PathBuf::from(&frames_arg);
        bundle_dir = frames_path.parent().unwrap().to_path_buf();
    }
    if !frames_path.is_file() {
        eprintln!("ERROR: frames.json not found: {}", frames_arg);
        std::process::exit(2);
    }
    let spec_path = bundle_dir.join("video-spec.json");
    if !spec_path.is_file() {
        eprintln!(
            "ERROR: video-spec.json not found in bundle dir {} (needed for the scene -> tape mapping).",
            bundle_dir.display()
        );
        std::process::exit(2);
    }

    let (width, height, n_frames) = probe_video(&video)?;
    if width != 1280 || height != 720 {
        eprintln!(
            "WARNING: expected 1280x720, got {}x{} -- layout checks may be off.",
            width, height
        );
    }

    let tape: Tape = serde_json::from_str(
        &std::fs::read_to_string(&frames_path).context("failed to read frames.json")?,
    )?;
    if tape.frames.is_empty() || tape.entities.is_empty() {
        eprintln!("ERROR: frames.json lacks 'frames'/'entities'.");
        std::process::exit(2);
    }
    let spec: VideoSpec = serde_json::from_str(
        &std::fs::read_to_string(&spec_path).context("failed to read video-spec.json")?,
    )?;

    // fps = total frames / duration
    let out_probe = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "json"])
        .arg(&video)
        .output()?;
    let pv: serde_json::Value = serde_json::from_slice(&out_probe.stdout)?;
    let duration: f64 = pv["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0);
    let fps_render = n_frames as f64 / duration;

    let mut qa = VideoQA::new(video.clone(), tape, spec, n_frames, fps_render)?;
    let violations = qa.run(samples)?.clone();
    let warnings = qa.warnings.clone();

    let report = serde_json::json!({
        "video": video.to_string_lossy(),
        "frames": frames_path.to_string_lossy(),
        "video_info": {"width": width, "height": height, "frames": n_frames},
        "violations": violations,
        "warnings": warnings,
    });
    if let Some(out_path) = out {
        std::fs::write(&out_path, serde_json::to_string_pretty(&report)?)?;
    }

    for w in &warnings {
        println!("  ! [{}] {}", w.check, w.detail);
    }
    if violations.is_empty() {
        println!("OK: {} passed all video-qa checks.", video.display());
        // Cleanup temp dir
        let _ = std::fs::remove_dir_all(&qa.tmpdir);
        std::process::exit(0);
    }
    println!("FAIL: {} violation(s) in {}:", violations.len(), video.display());
    for v in &violations {
        let mut loc = String::new();
        if let Some(f) = v.frame {
            loc.push_str(&format!(" [video frame {}", f));
            if let Some(t) = v.tape_index {
                loc.push_str(&format!(" / tape {}", t));
            }
            if let Some(s) = &v.scene {
                loc.push_str(&format!(" / {}", s));
            }
            loc.push(']');
        }
        println!("  - [{}] {}{}", v.check, v.detail, loc);
    }
    let _ = std::fs::remove_dir_all(&qa.tmpdir);
    std::process::exit(1);
}
