//! # datarace-core
//!
//! Deterministic, high-performance core for the analysis-video-maker platform.
//!
//! The TypeScript orchestration layer owns narrative and network concerns; this
//! crate owns the CPU-bound, reproducibility-critical work:
//!
//! | module     | responsibility                                            |
//! |------------|-----------------------------------------------------------|
//! | `ingest`   | CSV/TSV/JSON/JSONL/XLSX -> rectangular string tables       |
//! | `dates`    | date parsing + explicit frequency + sort keys              |
//! | `units`    | unit normalization / auditable conversion                 |
//! | `entities` | slugging, ISO-3166 resolution, flag codes                 |
//! | `rank`     | reproducible per-period rankings                          |
//! | `frames`   | per-frame bar-chart-race tape (the hot path)              |
//! | `validate` | specification data-quality tests                          |
//! | `hash`     | stable content hashing for the research cache             |
//! | `probe`    | MP4 validation through ffprobe                            |
//!
//! Hard rule: this crate never invents a value. A missing value stays missing.

pub mod dates;
pub mod entities;
pub mod frames;
pub mod hash;
pub mod ingest;
pub mod model;
pub mod probe;
pub mod rank;
pub mod units;
pub mod validate;

/// Version of the frame-tape contract consumed by the renderer.
pub const FRAME_TAPE_VERSION: &str = "1.0";
/// Version of the core library.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");