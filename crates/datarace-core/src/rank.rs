//! Ranking engine: observations in, reproducible per-period rankings out.
//!
//! Missing values are dropped, never filled. Interpolation is a separate,
//! explicitly requested step (see `frames`).

use crate::dates::{display_label, parse_date};
use crate::entities;
use crate::model::{DatasetInput, Frequency};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodMeta {
    pub index: usize,
    pub iso: String,
    pub label: String,
    pub sort_key: i64,
    pub frequency: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankRow {
    pub entity: String,
    pub entity_id: String,
    pub period_iso: String,
    pub period_label: String,
    pub period_index: usize,
    pub value: f64,
    pub rank: usize,
    pub rank_delta: Option<i64>,
    pub is_mover: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankingOutput {
    pub periods: Vec<PeriodMeta>,
    pub rows: Vec<RankRow>,
    pub entity_order: Vec<String>,
    pub dropped_unparsable_date: usize,
    pub dropped_missing_value: usize,
    pub duplicate_cells: usize,
    pub top_n: usize,
    pub mover_threshold: i64,
}

struct CellAcc {
    value: f64,
    status: String,
    count: usize,
}

/// Compute per-period rankings for a dataset.
///
/// * rows are sorted by value (descending) inside each period
/// * `rank_delta` compares against the previous period the entity appeared in
/// * `is_mover` is true when |rank_delta| >= `mover_threshold`
pub fn rank_dataset(
    dataset: &DatasetInput,
    top_n: usize,
    mover_threshold: i64,
) -> (RankingOutput, BTreeMap<String, Frequency>) {
    let mut dropped_date = 0usize;
    let mut dropped_value = 0usize;
    let mut cells: BTreeMap<i64, BTreeMap<String, CellAcc>> = BTreeMap::new();
    let mut meta: BTreeMap<i64, (String, Frequency)> = BTreeMap::new();

    for obs in &dataset.observations {
        let Some(parsed) = parse_date(&obs.date) else {
            dropped_date += 1;
            continue;
        };
        let Some(value) = obs.value else {
            dropped_value += 1;
            continue;
        };
        let frequency = obs
            .frequency
            .as_deref()
            .and_then(Frequency::from_hint)
            .unwrap_or(parsed.frequency);
        meta.entry(parsed.sort_key)
            .or_insert_with(|| (parsed.iso.clone(), frequency));
        let key = entities::slugify(&obs.entity_name());
        let period = cells.entry(parsed.sort_key).or_default();
        match period.get_mut(&key) {
            Some(existing) => {
                existing.count += 1;
                // Keep the maximum value and mark the cell as a duplicate so the
                // validator can surface it instead of hiding it.
                if value > existing.value {
                    existing.value = value;
                }
                existing.status = "DUPLICATE".to_string();
            }
            None => {
                period.insert(
                    key,
                    CellAcc {
                        value,
                        status: obs.status.clone().unwrap_or_else(|| "SUPPORTED".to_string()),
                        count: 1,
                    },
                );
            }
        }
    }

    let periods: Vec<PeriodMeta> = meta
        .iter()
        .enumerate()
        .map(|(i, (sort_key, (iso, freq)))| PeriodMeta {
            index: i,
            iso: iso.clone(),
            label: display_label(iso, *freq),
            sort_key: *sort_key,
            frequency: freq.as_str().to_string(),
        })
        .collect();

    let mut rows: Vec<RankRow> = Vec::new();
    let mut duplicate_cells = 0usize;
    let mut last_rank: BTreeMap<String, usize> = BTreeMap::new();
    let mut display_names: BTreeMap<String, String> = BTreeMap::new();
    let mut order_score: BTreeMap<String, f64> = BTreeMap::new();

    for period in &periods {
        let Some(cells_in_period) = cells.get(&period.sort_key) else {
            continue;
        };
        let mut sorted: Vec<(&String, &CellAcc)> = cells_in_period.iter().collect();
        sorted.sort_by(|a, b| {
            b.1.value
                .partial_cmp(&a.1.value)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(b.0))
        });
        for (rank_zero, (entity_id, acc)) in sorted.iter().enumerate() {
            let rank = rank_zero + 1;
            if acc.count > 1 {
                duplicate_cells += 1;
            }
            if rank > top_n {
                continue;
            }
            let raw_name = dataset
                .observations
                .iter()
                .find(|o| entities::slugify(&o.entity_name()) == **entity_id)
                .map(|o| o.entity_name())
                .unwrap_or_else(|| (*entity_id).clone());
            display_names.insert((*entity_id).clone(), raw_name.clone());
            *order_score.entry((*entity_id).clone()).or_insert(0.0) += acc.value;
            let prev = last_rank.get(*entity_id).copied();
            let delta = prev.map(|p| p as i64 - rank as i64);
            rows.push(RankRow {
                entity: raw_name,
                entity_id: (*entity_id).clone(),
                period_iso: period.iso.clone(),
                period_label: period.label.clone(),
                period_index: period.index,
                value: acc.value,
                rank,
                rank_delta: delta,
                is_mover: delta.map(|d| d.abs() >= mover_threshold).unwrap_or(false),
                status: acc.status.clone(),
            });
        }
        for (entity_id, _) in sorted.iter() {
            last_rank.insert((*entity_id).clone(), {
                let pos = sorted
                    .iter()
                    .position(|(e, _)| *e == *entity_id)
                    .unwrap_or(0);
                pos + 1
            });
        }
    }

    let mut entity_order: Vec<String> = order_score.keys().cloned().collect();
    entity_order.sort_by(|a, b| {
        order_score[b]
            .partial_cmp(&order_score[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    (
        RankingOutput {
            periods,
            rows,
            entity_order,
            dropped_unparsable_date: dropped_date,
            dropped_missing_value: dropped_value,
            duplicate_cells,
            top_n,
            mover_threshold,
        },
        meta.iter().map(|(k, (_, f))| (k.to_string(), *f)).collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ObservationInput;

    fn obs(entity: &str, date: &str, value: Option<f64>) -> ObservationInput {
        ObservationInput {
            entity: crate::model::EntityField::Name(entity.to_string()),
            date: date.to_string(),
            value,
            ..Default::default()
        }
    }

    #[test]
    fn ranks_descending_and_never_fills_missing() {
        let ds = DatasetInput {
            observations: vec![
                obs("China", "1990", Some(100.0)),
                obs("India", "1990", Some(80.0)),
                obs("China", "1991", Some(110.0)),
                obs("India", "1991", None),
            ],
            ..Default::default()
        };
        let (out, _) = rank_dataset(&ds, 10, 2);
        assert_eq!(out.periods.len(), 2);
        assert_eq!(out.rows.iter().filter(|r| r.period_iso == "1991-01-01").count(), 1);
        assert_eq!(out.dropped_missing_value, 1);
        assert_eq!(out.rows[0].rank, 1);
    }

    #[test]
    fn detects_movers() {
        let ds = DatasetInput {
            observations: vec![
                obs("A", "2000", Some(1.0)),
                obs("B", "2000", Some(2.0)),
                obs("A", "2001", Some(5.0)),
                obs("B", "2001", Some(4.0)),
            ],
            ..Default::default()
        };
        let (out, _) = rank_dataset(&ds, 10, 1);
        let a_2001 = out.rows.iter().find(|r| r.entity == "A" && r.period_label == "2001").unwrap();
        assert_eq!(a_2001.rank, 1);
        assert_eq!(a_2001.rank_delta, Some(1));
        assert!(a_2001.is_mover);
    }
}