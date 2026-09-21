//! End-to-end core pipeline smoke test: ingest a real fixture, normalize it,
//! rank it, build a frame tape, validate it and hash it.
//!
//! The fixture is small and explicitly synthetic - it exercises the machinery,
//! it is NOT a data source.

use datarace_core::frames::{build_frame_tape, FrameOptions};
use datarace_core::model::{DatasetInput, EntityInput, ObservationInput};
use datarace_core::{entities, hash, ingest, rank, validate};
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

fn dataset_from_fixture() -> DatasetInput {
    let tables = ingest::ingest_file(&fixture("phone_brands.csv")).expect("fixture ingests");
    let table = &tables[0];
    let brand = table.column_index("brand").expect("brand column");
    let year = table.column_index("year").expect("year column");
    let share = table.column_index("share").expect("share column");
    let observations = table
        .rows
        .iter()
        .map(|r| ObservationInput {
            entity: r[brand].clone(),
            date: r[year].clone(),
            value: r[share].parse::<f64>().ok(),
            unit: Some("percent".into()),
            source: Some("fixture".into()),
            source_url: Some("https://example.invalid/fixture.csv".into()),
            ..Default::default()
        })
        .collect::<Vec<_>>();
    DatasetInput {
        name: Some("phone brands fixture".into()),
        metric: Some("global market share".into()),
        unit: Some("percent".into()),
        entities: vec![
            EntityInput { name: "Nokia".into(), color: Some("#1f3d99".into()), ..Default::default() },
            EntityInput { name: "Samsung".into(), color: Some("#1428a0".into()), ..Default::default() },
            EntityInput { name: "Motorola".into(), color: Some("#6b7280".into()), ..Default::default() },
        ],
        observations,
    }
}

#[test]
fn full_core_pipeline_runs() {
    let ds = dataset_from_fixture();
    assert_eq!(ds.observations.len(), 6);

    let (ranking, _) = rank::rank_dataset(&ds, 10, 2);
    assert_eq!(ranking.periods.len(), 2);
    assert_eq!(ranking.rows.len(), 6);
    assert_eq!(ranking.rows[0].entity, "Nokia");
    assert_eq!(ranking.dropped_missing_value, 0);

    let tape = build_frame_tape(&ds, &FrameOptions { frames_per_transition: 6, ..Default::default() });
    assert!(tape.duration_in_frames >= 12);
    assert_eq!(tape.entities.len(), 3);

    let report = validate::validate_dataset(&ds, "2026-09-21");
    assert!(report.passed, "fixture should be clean: {:?}", report.checks);
    assert_eq!(report.violations, 0);

    let digest = hash::sha256_json(&serde_json::to_value(&ds).unwrap());
    assert_eq!(digest.len(), 64);

    let resolution = entities::resolve("Nokia");
    assert_eq!(resolution.status, "unresolved");
}

#[test]
fn missing_values_are_never_filled() {
    let mut ds = dataset_from_fixture();
    // Delete one value outright - it must stay missing, never interpolated.
    ds.observations[1].value = None;
    let tape = build_frame_tape(&ds, &FrameOptions { frames_per_transition: 4, ..Default::default() });
    assert!(tape.notes.iter().any(|n| n.contains("no value")));
    let (ranking, _) = rank::rank_dataset(&ds, 10, 2);
    assert_eq!(ranking.dropped_missing_value, 1);
}