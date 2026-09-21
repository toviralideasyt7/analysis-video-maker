//! Data-quality tests from the specification. The report is machine readable
//! and always exposes a `violations` count so CI can gate on it
//! (`violations == 0`).

use crate::dates::parse_date;
use crate::entities;
use crate::model::DatasetInput;
use crate::rank::rank_dataset;
use crate::units;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub name: String,
    pub passed: bool,
    pub violations: usize,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataQualityReport {
    pub observations: usize,
    pub entities: usize,
    pub checks: Vec<CheckResult>,
    pub violations: usize,
    pub passed: bool,
    pub generated_at: String,
}

fn check(name: &str, details: Vec<String>) -> CheckResult {
    CheckResult {
        name: name.to_string(),
        passed: details.is_empty(),
        violations: details.len(),
        details,
    }
}

pub fn validate_dataset(dataset: &DatasetInput, max_allowed_date: &str) -> DataQualityReport {
    let mut checks: Vec<CheckResult> = Vec::new();

    // --- schema ------------------------------------------------------------
    let mut d = Vec::new();
    if dataset.observations.is_empty() {
        d.push("no observations present".to_string());
    }
    for (i, o) in dataset.observations.iter().enumerate() {
        if o.entity.trim().is_empty() {
            d.push(format!("observation {} has an empty entity", i));
        }
        if o.date.trim().is_empty() {
            d.push(format!("observation {} has an empty date", i));
        }
    }
    checks.push(check("schema", d));

    // --- type --------------------------------------------------------------
    let mut d = Vec::new();
    for (i, o) in dataset.observations.iter().enumerate() {
        match o.value {
            Some(v) if v.is_finite() => {},
            Some(_) => d.push(format!("observation {} has a non-finite value", i)),
            None => {}
        }
    }
    checks.push(check("type", d));

    // --- date --------------------------------------------------------------
    let mut d = Vec::new();
    for (i, o) in dataset.observations.iter().enumerate() {
        if parse_date(&o.date).is_none() {
            d.push(format!("observation {} date {:?} cannot be parsed", i, o.date));
        }
    }
    checks.push(check("date", d));

    // --- unit --------------------------------------------------------------
    let mut d = Vec::new();
    for (i, o) in dataset.observations.iter().enumerate() {
        if let Some(u) = &o.unit {
            let info = units::normalize_unit(u);
            if !info.known {
                d.push(format!("observation {} uses an unknown unit {:?}", i, u));
            }
        } else if dataset.unit.is_none() {
            d.push(format!("observation {} has no unit and the dataset declares none", i));
        }
    }
    checks.push(check("unit", d));

    // --- entity ------------------------------------------------------------
    let mut d = Vec::new();
    let mut ambiguous = 0usize;
    let mut seen: HashSet<String> = HashSet::new();
    for o in &dataset.observations {
        let key = entities::slugify(&o.entity);
        if seen.insert(key) {
            let r = entities::resolve(&o.entity);
            if r.status == "ambiguous" {
                ambiguous += 1;
            }
        }
    }
    if ambiguous > 0 {
        d.push(format!("{} entity names are ambiguous and need an explicit mapping", ambiguous));
    }
    checks.push(check("entity", d));

    // --- duplicate ---------------------------------------------------------
    let mut d = Vec::new();
    let mut cells: HashSet<(String, String)> = HashSet::new();
    for o in &dataset.observations {
        let key = (entities::slugify(&o.entity), o.date.clone());
        if !cells.insert(key) {
            d.push(format!("duplicate entity/date cell: {} / {}", o.entity, o.date));
        }
    }
    checks.push(check("duplicate", d));

    // --- range -------------------------------------------------------------
    let mut d = Vec::new();
    for (i, o) in dataset.observations.iter().enumerate() {
        if let Some(v) = o.value {
            let dimension = o
                .unit
                .as_ref()
                .map(|u| units::normalize_unit(u).dimension)
                .unwrap_or_else(|| "count".to_string());
            if dimension == "count" && v < 0.0 {
                d.push(format!("observation {} is a negative count ({})", i, v));
            }
        }
    }
    checks.push(check("range", d));

    // --- source / provenance ----------------------------------------------
    let mut d = Vec::new();
    for (i, o) in dataset.observations.iter().enumerate() {
        if o.source.is_none() && o.source_url.is_none() {
            d.push(format!("observation {} has no provenance (source/sourceUrl)", i));
        }
        if let Some(url) = &o.source_url {
            if !url.starts_with("http") && !url.starts_with("file:") && !url.starts_with("upload:") {
                d.push(format!("observation {} has a malformed provenance url {:?}", i, url));
            }
        }
    }
    checks.push(check("source", d));

    // --- temporal ----------------------------------------------------------
    let mut d = Vec::new();
    let max_key = parse_date(max_allowed_date).map(|p| p.sort_key).unwrap_or(i64::MAX);
    for (i, o) in dataset.observations.iter().enumerate() {
        if let Some(p) = parse_date(&o.date) {
            if p.sort_key > max_key {
                let forecast = o
                    .status
                    .as_deref()
                    .map(|s| s.eq_ignore_ascii_case("forecast") || s.eq_ignore_ascii_case("estimated"))
                    .unwrap_or(false);
                if !forecast {
                    d.push(format!("observation {} is dated in the future ({}) without a forecast flag", i, o.date));
                }
            }
        }
    }
    checks.push(check("temporal", d));

    // --- ranking reproducibility ------------------------------------------
    let mut d = Vec::new();
    let (a, _) = rank_dataset(dataset, usize::MAX / 2, 2);
    let (b, _) = rank_dataset(dataset, usize::MAX / 2, 2);
    if a.rows.len() != b.rows.len() {
        d.push("ranking is not reproducible across two identical runs".to_string());
    } else {
        for (x, y) in a.rows.iter().zip(b.rows.iter()) {
            if x.entity_id != y.entity_id || x.period_index != y.period_index || x.rank != y.rank {
                d.push(format!("ranking differs for {} at {}", x.entity_id, x.period_iso));
                break;
            }
        }
    }
    for row in &a.rows {
        if row.rank == 0 {
            d.push("ranking produced a rank of zero".to_string());
        }
    }
    checks.push(check("ranking", d));

    // --- citation ----------------------------------------------------------
    let mut d = Vec::new();
    let important: Vec<_> = dataset.observations.iter().filter(|o| o.value.is_some()).collect();
    let with_source = important
        .iter()
        .filter(|o| o.source.is_some() || o.source_url.is_some())
        .count();
    if !important.is_empty() && with_source == 0 {
        d.push("no observation carries a source: every important claim needs a citation".to_string());
    }
    checks.push(check("citation", d));

    let violations: usize = checks.iter().map(|c| c.violations).sum();
    DataQualityReport {
        observations: dataset.observations.len(),
        entities: dataset
            .observations
            .iter()
            .map(|o| entities::slugify(&o.entity))
            .collect::<HashSet<_>>()
            .len(),
        checks,
        violations,
        passed: violations == 0,
        generated_at: chrono::Utc::now().to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ObservationInput;

    #[test]
    fn clean_dataset_passes() {
        let ds = DatasetInput {
            unit: Some("count".into()),
            observations: vec![ObservationInput {
                entity: "India".into(),
                date: "2000".into(),
                value: Some(1.0),
                unit: Some("count".into()),
                source: Some("World Bank".into()),
                source_url: Some("https://data.worldbank.org/".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let r = validate_dataset(&ds, "2026-09-21");
        assert!(r.passed, "expected clean pass, got {:?}", r.checks);
    }

    #[test]
    fn missing_provenance_is_a_violation() {
        let ds = DatasetInput {
            observations: vec![ObservationInput {
                entity: "India".into(),
                date: "2000".into(),
                value: Some(1.0),
                unit: Some("count".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let r = validate_dataset(&ds, "2026-09-21");
        assert!(!r.passed);
        assert!(r.violations > 0);
    }

    #[test]
    fn future_values_are_flagged() {
        let ds = DatasetInput {
            unit: Some("count".into()),
            observations: vec![ObservationInput {
                entity: "India".into(),
                date: "2099".into(),
                value: Some(1.0),
                unit: Some("count".into()),
                source: Some("x".into()),
                source_url: Some("https://example.com".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let r = validate_dataset(&ds, "2026-09-21");
        assert!(r.checks.iter().any(|c| c.name == "temporal" && !c.passed));
    }
}