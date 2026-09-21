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

/// A field that arrives either as a bare string or as an object.
///
/// The Rust core has its own compact input shape, but the platform's dataset
/// file is richer (`entity: { id, name, iso2, ... }`, `source: { url, ... }`).
/// Accepting both means one file can be validated by the CLI, the API and CI
/// without a conversion step that could drift.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EntityField {
    Name(String),
    Object {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        name: Option<String>,
    },
}

impl Default for EntityField {
    fn default() -> Self {
        EntityField::Name(String::new())
    }
}

impl EntityField {
    /// The human-readable name, whichever shape was supplied.
    pub fn name(&self) -> String {
        match self {
            EntityField::Name(s) => s.clone(),
            EntityField::Object { id, name } => name
                .clone()
                .or_else(|| id.clone())
                .unwrap_or_default(),
        }
    }
}

impl From<&str> for EntityField {
    fn from(value: &str) -> Self {
        EntityField::Name(value.to_string())
    }
}

impl From<String> for EntityField {
    fn from(value: String) -> Self {
        EntityField::Name(value)
    }
}

impl From<&str> for TextOrObject {
    fn from(value: &str) -> Self {
        TextOrObject::Text(value.to_string())
    }
}

impl From<String> for TextOrObject {
    fn from(value: String) -> Self {
        TextOrObject::Text(value)
    }
}
/// A field that arrives either as a bare string or as an object with a
/// `publisher` / `title` / `url`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TextOrObject {
    Text(String),
    Object {
        #[serde(default)]
        publisher: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        url: Option<String>,
    },
}

impl TextOrObject {
    pub fn text(&self) -> Option<String> {
        match self {
            TextOrObject::Text(s) => Some(s.clone()),
            TextOrObject::Object { publisher, title, url } => {
                publisher.clone().or_else(|| title.clone()).or_else(|| url.clone())
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ObservationInput {
    pub entity: EntityField,
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
    pub source: Option<TextOrObject>,
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
impl ObservationInput {
    /// Resolved entity name, regardless of which input shape was used.
    pub fn entity_name(&self) -> String {
        self.entity.name()
    }
}
