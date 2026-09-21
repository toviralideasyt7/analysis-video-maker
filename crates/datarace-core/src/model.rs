//! Core data model shared by every stage of the pipeline.
//!
//! Invariant: a missing value is represented as `None` + status `UNKNOWN`.
//! The core never invents numbers.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Frequency {
    Annual,
    Quarterly,
    Monthly,
    Weekly,
    Daily,
    Unknown,
}

impl Frequency {
    /// Parse a frequency hint from the serialized vocabulary.
    pub fn from_hint(raw: &str) -> Option<Frequency> {
        match raw.trim().to_lowercase().as_str() {
            "annual" | "yearly" | "year" => Some(Frequency::Annual),
            "quarterly" | "quarter" => Some(Frequency::Quarterly),
            "monthly" | "month" => Some(Frequency::Monthly),
            "weekly" | "week" => Some(Frequency::Weekly),
            "daily" | "day" => Some(Frequency::Daily),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Frequency::Annual => "annual",
            Frequency::Quarterly => "quarterly",
            Frequency::Monthly => "monthly",
            Frequency::Weekly => "weekly",
            Frequency::Daily => "daily",
            Frequency::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ObsStatus {
    Verified,
    Supported,
    Estimated,
    Unknown,
    Conflicting,
    Rejected,
}

impl ObsStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ObsStatus::Verified => "VERIFIED",
            ObsStatus::Supported => "SUPPORTED",
            ObsStatus::Estimated => "ESTIMATED",
            ObsStatus::Unknown => "UNKNOWN",
            ObsStatus::Conflicting => "CONFLICTING",
            ObsStatus::Rejected => "REJECTED",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EntityRef {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iso2: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ObservationInput {
    pub entity: String,
    pub date: String,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    /// Optional frequency hint. When the caller already knows the data is
    /// annual, this stops "1960-01-01" from rendering as a daily date.
    #[serde(default)]
    pub frequency: Option<String>,
    #[serde(default)]
    pub geography: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EntityInput {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub logo: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DatasetInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub metric: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub entities: Vec<EntityInput>,
    #[serde(default)]
    pub observations: Vec<ObservationInput>,
}