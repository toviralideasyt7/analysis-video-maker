//! Frame-tape generation for the bar-chart race.
//!
//! This is the performance-critical stage: it turns a full dataset (50k+
//! observations, 100+ entities) into the per-frame bar state the renderer
//! consumes, so the renderer never has to do data math per frame.
//!
//! Honesty rule: gaps are only ever *carried forward* for visual continuity and
//! every carried frame is flagged (`held = true`) plus reported in `notes`. In
//! `Strict` policy an entity with no value at a period simply is not drawn.

use crate::entities;
use crate::model::DatasetInput;
use crate::rank::rank_dataset;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InterpolationPolicy {
    Strict,
    CarryForward,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityMeta {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag_code: Option<String>,
    pub color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarState {
    pub entity_id: String,
    pub value: f64,
    pub rank: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_rank: Option<usize>,
    pub width: f64,
    pub held: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank_delta: Option<i64>,
    pub is_mover: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameState {
    pub index: usize,
    pub label: String,
    pub from_label: String,
    pub to_label: String,
    pub t: f64,
    pub is_period_boundary: bool,
    pub max_value: f64,
    pub bars: Vec<BarState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameTape {
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub top_n: usize,
    pub frames_per_transition: usize,
    pub duration_in_frames: usize,
    pub period_labels: Vec<String>,
    pub entities: Vec<EntityMeta>,
    pub frames: Vec<FrameState>,
    pub notes: Vec<String>,
}

/// Distinct, high-contrast palette used when a dataset does not assign colors.
pub const PALETTE: [&str; 24] = [
    "#2563eb", "#dc2626", "#f59e0b", "#059669", "#7c3aed", "#0891b2", "#db2777", "#65a30d",
    "#ea580c", "#4338ca", "#0d9488", "#b91c1c", "#4d7c0f", "#9333ea", "#0369a1", "#c2410c",
    "#1e40af", "#be123c", "#a16207", "#15803d", "#6d28d9", "#0e7490", "#9d174d", "#3f6212",
];

pub struct FrameOptions {
    pub top_n: usize,
    pub frames_per_transition: usize,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub mover_threshold: i64,
    pub policy: InterpolationPolicy,
    /// Max consecutive trailing periods (past the entity's last observation)
    /// an entity's last value is carried across. `None` = unlimited (legacy).
    /// Gaps *within* the observed lifespan are always carried; only the
    /// trailing run past the final observation is capped, so long-dead
    /// entities stop haunting the chart. The caller sizes this in years
    /// (~10 years of screen time), not raw periods.
    pub max_carry: Option<usize>,
}

impl Default for FrameOptions {
    fn default() -> Self {
        FrameOptions {
            top_n: 10,
            frames_per_transition: 30,
            fps: 30,
            width: 1280,
            height: 720,
            mover_threshold: 2,
            policy: InterpolationPolicy::CarryForward,
            max_carry: None,
        }
    }
}

pub fn build_frame_tape(dataset: &DatasetInput, opts: &FrameOptions) -> FrameTape {
    let (ranking, _) = rank_dataset(dataset, opts.top_n, opts.mover_threshold);
    let period_labels: Vec<String> = ranking.periods.iter().map(|p| p.label.clone()).collect();

    // entity -> period label -> (value, rank)
    let mut by_entity: BTreeMap<String, BTreeMap<String, (f64, usize)>> = BTreeMap::new();
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for row in &ranking.rows {
        by_entity
            .entry(row.entity_id.clone())
            .or_default()
            .insert(row.period_label.clone(), (row.value, row.rank));
        names.insert(row.entity_id.clone(), row.entity.clone());
    }

    // Filled series: for each entity, walk periods in order and carry the last
    // *observed* value forward across gaps of any length. The old code only
    // carried within a single adjacent transition, so an entity missing from
    // two consecutive survey years (e.g. Indonesia in 1988-1989) vanished from
    // the boundary frame while the transition frames still showed its carried
    // bar — and the spotlight leader (ranked on raw observations) disagreed
    // with the bars on screen. Values before an entity's first observation are
    // never fabricated: the entity simply does not appear yet.
    let mut filled: BTreeMap<String, BTreeMap<String, (f64, bool)>> = BTreeMap::new();
    for (id, series) in &by_entity {
        let mut last: Option<f64> = None;
        let mut missing_run: usize = 0;
        let mut filled_series: BTreeMap<String, (f64, bool)> = BTreeMap::new();
        // Index of the entity's last observed period: past this point the
        // entity may be dead, so the carry cap applies. Gaps *within* the
        // observed lifespan are carried across freely — sparse historical
        // data must not make entities flicker in and out between observations.
        let last_obs_idx = series
            .keys()
            .next_back()
            .and_then(|k| period_labels.iter().position(|l| l == k));
        for (idx, label) in period_labels.iter().enumerate() {
            if let Some((v, _)) = series.get(label) {
                filled_series.insert(label.clone(), (*v, false));
                last = Some(*v);
                missing_run = 0;
            } else if let Some(prev) = last {
                let trailing = last_obs_idx.map(|li| idx > li).unwrap_or(true);
                if !trailing {
                    filled_series.insert(label.clone(), (prev, true));
                } else {
                    missing_run += 1;
                    // A long-dead entity (Netscape in 2026, the Second French
                    // colonial empire in 2021) should not haunt the chart
                    // forever: stop carrying once the trailing gap exceeds
                    // the cap (~10 years of screen time, set by the caller).
                    let within_cap = opts.max_carry.map(|m| missing_run <= m).unwrap_or(true);
                    if within_cap {
                        filled_series.insert(label.clone(), (prev, true));
                    } else {
                        last = None;
                    }
                }
            }
        }
        filled.insert(id.clone(), filled_series);
    }

    // Meta from the canonical ranking order (most prominent first).
    let mut entities_meta: Vec<EntityMeta> = Vec::new();
    for (i, id) in ranking.entity_order.iter().enumerate() {
        let explicit = dataset
            .entities
            .iter()
            .find(|e| entities::slugify(&e.name) == *id);
        let res = entities::resolve(id);
        let name = explicit.map(|e| e.name.clone()).unwrap_or_else(|| {
            names.get(id).cloned().unwrap_or_else(|| id.clone())
        });
        let color = explicit
            .and_then(|e| e.color.clone())
            .unwrap_or_else(|| PALETTE[i % PALETTE.len()].to_string());
        let from_country = res.status == "resolved";
        entities_meta.push(EntityMeta {
            id: id.clone(),
            name,
            flag: if from_country { res.entity.iso2.as_ref().and_then(|c| entities::flag_emoji(c)) } else { None },
            flag_code: if from_country { res.entity.flag_code.clone() } else { None },
            color,
            logo: explicit.and_then(|e| e.logo.clone()),
            image: explicit.and_then(|e| e.image.clone()),
            group: explicit
                .and_then(|e| e.group.clone())
                .or(if from_country { res.entity.group.clone() } else { None }),
        });
    }

    // Ranks at a given period label, used as the reference for rank changes.
    // Comparing against the *previous period* (not the previous frame) is what
    // makes `rank_delta` / `is_mover` meaningful for the viewer.
    //
    // IMPORTANT: ranks are computed from the *filled* series (see below), so
    // the leader named in spotlight cards always matches the bars the viewer
    // sees at that period. Ranking raw observations here while the frames
    // carry values forward produced "1988: Ghana leads" over bars showing
    // Indonesia on top.
    let ranks_at = |label: &str| -> BTreeMap<String, usize> {
        let mut vals: Vec<(&String, f64)> = filled
            .iter()
            .filter_map(|(id, series)| series.get(label).map(|(v, _)| (id, *v)))
            .collect();
        vals.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(b.0))
        });
        vals.iter()
            .take(opts.top_n)
            .enumerate()
            .map(|(i, (id, _))| ((*id).clone(), i + 1))
            .collect()
    };

    let mut frames: Vec<FrameState> = Vec::new();
    let mut held_total = 0usize;
    let labels = &period_labels;
    let n = labels.len();

    if n == 0 {
        return FrameTape {
            fps: opts.fps,
            width: opts.width,
            height: opts.height,
            top_n: opts.top_n,
            frames_per_transition: opts.frames_per_transition,
            duration_in_frames: 0,
            period_labels: Vec::new(),
            entities: entities_meta,
            frames,
            notes: vec!["no rankable observations: nothing to render".to_string()],
        };
    }

    let transitions = n.saturating_sub(1).max(1);
    let mut frame_index = 0usize;
    let mut boundary_ranks = ranks_at(&labels[0]);

    for t_idx in 0..transitions {
        let from = &labels[t_idx];
        let to = &labels[(t_idx + 1).min(n - 1)];
        for k in 0..opts.frames_per_transition {
            let t = k as f64 / opts.frames_per_transition as f64;
            let mut vals: Vec<(String, f64, bool)> = Vec::new();
            for (id, series) in &filled {
                let a = series.get(from);
                let b = series.get(to);
                let (value, held) = match (a, b) {
                    // Both ends filled: interpolate. If either end is itself
                    // a carried value, the in-between frames are held too.
                    (Some(x), Some(y)) => (x.0 + (y.0 - x.0) * t, x.1 || y.1),
                    (Some(x), None) => match opts.policy {
                        InterpolationPolicy::CarryForward => (x.0, true),
                        InterpolationPolicy::Strict => continue,
                    },
                    (None, Some(y)) => match opts.policy {
                        InterpolationPolicy::CarryForward => (y.0, true),
                        InterpolationPolicy::Strict => continue,
                    },
                    (None, None) => continue,
                };
                vals.push((id.clone(), value, held));
            }
            vals.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.0.cmp(&b.0)));
            let max_value = vals.first().map(|v| v.1).unwrap_or(0.0).max(f64::EPSILON);
            let mut bars: Vec<BarState> = Vec::new();
            let mut ranks: BTreeMap<String, usize> = BTreeMap::new();
            for (rank_zero, (id, value, held)) in vals.iter().take(opts.top_n).enumerate() {
                let rank = rank_zero + 1;
                ranks.insert(id.clone(), rank);
                if *held {
                    held_total += 1;
                }
                let previous_rank = boundary_ranks.get(id).copied();
                let rank_delta = previous_rank.map(|p| p as i64 - rank as i64);
                bars.push(BarState {
                    entity_id: id.clone(),
                    value: *value,
                    rank,
                    previous_rank,
                    width: value / max_value,
                    held: *held,
                    rank_delta,
                    is_mover: rank_delta.map(|d| d.abs() >= opts.mover_threshold).unwrap_or(false),
                });
            }
            frames.push(FrameState {
                index: frame_index,
                label: if t < 0.5 { from.clone() } else { to.clone() },
                from_label: from.clone(),
                to_label: to.clone(),
                t,
                is_period_boundary: k == 0,
                max_value,
                bars,
            });
            frame_index += 1;
        }
        boundary_ranks = ranks_at(&labels[(t_idx + 1).min(n - 1)]);
    }

    // Hold the final period for one more transition worth of frames.
    if let Some(last) = labels.last().cloned() {
        let bars = frames.last().map(|f| f.bars.clone()).unwrap_or_default();
        let max_value = frames.last().map(|f| f.max_value).unwrap_or(1.0);
        for _ in 0..opts.frames_per_transition {
            frames.push(FrameState {
                index: frame_index,
                label: last.clone(),
                from_label: last.clone(),
                to_label: last.clone(),
                t: 1.0,
                is_period_boundary: false,
                max_value,
                bars: bars.clone(),
            });
            frame_index += 1;
        }
    }
    let mut notes = Vec::new();
    if held_total > 0 {
        notes.push(format!(
            "{} bar-frames carry a held (non-observed) value forward; these are drawn for visual continuity only and are flagged held=true",
            held_total
        ));
    }
    if ranking.dropped_missing_value > 0 {
        notes.push(format!(
            "{} observations had no value and were dropped (never fabricated)",
            ranking.dropped_missing_value
        ));
    }
    if ranking.dropped_unparsable_date > 0 {
        notes.push(format!(
            "{} observations had an unparsable date and were dropped",
            ranking.dropped_unparsable_date
        ));
    }
    if ranking.duplicate_cells > 0 {
        notes.push(format!(
            "{} entity/period cells had duplicate observations; the maximum was kept and the cell marked DUPLICATE",
            ranking.duplicate_cells
        ));
    }

    FrameTape {
        fps: opts.fps,
        width: opts.width,
        height: opts.height,
        top_n: opts.top_n,
        frames_per_transition: opts.frames_per_transition,
        duration_in_frames: frames.len(),
        period_labels,
        entities: entities_meta,
        frames,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntityInput, ObservationInput};

    fn ds() -> DatasetInput {
        let mut observations = Vec::new();
        for (year, a, b) in [(2000, 10.0, 5.0), (2001, 12.0, 9.0), (2002, 14.0, 20.0)] {
            observations.push(ObservationInput { entity: "India".into(), date: year.to_string(), value: Some(a), ..Default::default() });
            observations.push(ObservationInput { entity: "China".into(), date: year.to_string(), value: Some(b), ..Default::default() });
        }
        DatasetInput {
            entities: vec![
                EntityInput { name: "India".into(), color: Some("#ff8c00".into()), ..Default::default() },
                EntityInput { name: "China".into(), color: Some("#dc2626".into()), ..Default::default() },
            ],
            observations,
            ..Default::default()
        }
    }

    #[test]
    fn tape_has_frames_and_resolves_flags() {
        let tape = build_frame_tape(&ds(), &FrameOptions { frames_per_transition: 5, ..Default::default() });
        assert!(tape.duration_in_frames > 0);
        assert_eq!(tape.period_labels, vec!["2000", "2001", "2002"]);
        let india = tape.entities.iter().find(|e| e.id == "india").unwrap();
        assert_eq!(india.flag_code.as_deref(), Some("in"));
        assert_eq!(india.color, "#ff8c00");
    }

    #[test]
    fn widths_are_normalized_and_rank_changes_detected() {
        let tape = build_frame_tape(&ds(), &FrameOptions { frames_per_transition: 4, mover_threshold: 1, ..Default::default() });
        let first = &tape.frames[0];
        assert!((first.bars[0].width - 1.0).abs() < 1e-9);
        assert_eq!(first.bars[0].entity_id, "india");
        let last_period_frames: Vec<_> = tape.frames.iter().filter(|f| f.label == "2002").collect();
        let last = last_period_frames.last().unwrap();
        assert_eq!(last.bars[0].entity_id, "china");
        assert!(last.bars[0].is_mover);
    }
}