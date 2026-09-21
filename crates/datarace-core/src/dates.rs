//! Date normalization. Internal representation is ISO-ish plus an explicit
//! `frequency` so a renderer never implies monthly precision for annual data.

use crate::model::Frequency;
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedDate {
    pub iso: String,
    pub frequency: Frequency,
    /// Monotonic sort key: year * 10000 + month * 100 + day.
    pub sort_key: i64,
}

fn rx(pat: &str) -> Regex {
    Regex::new(pat).expect("valid date regex")
}

fn re_year() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| rx(r"^(-?\d{1,4})$"))
}
fn re_ym() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| rx(r"^(\d{4})[-/.](\d{1,2})$"))
}
fn re_my() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| rx(r"^(\d{1,2})[-/.](\d{4})$"))
}
fn re_q_ym() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| rx(r"(?i)^(\d{4})[-/ ]?[qQ](\d)$"))
}
fn re_q_my() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| rx(r"(?i)^[qQ](\d)[-/ ]?(\d{4})$"))
}
fn re_ymd() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| rx(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})"))
}
fn re_monthname() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| rx(r"(?i)^([a-z]{3,9})[ ,\-]+(\d{4})$"))
}
fn re_monthname_first() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| rx(r"(?i)^(\d{4})[ ,\-]+([a-z]{3,9})$"))
}

fn month_from_name(name: &str) -> Option<u32> {
    let n = name.to_lowercase();
    let idx = [
        "january", "february", "march", "april", "may", "june", "july", "august", "september",
        "october", "november", "december",
    ]
    .iter()
    .position(|m| m.starts_with(&n[..n.len().min(3)]) && n.len() >= 3);
    idx.map(|i| i as u32 + 1)
}

fn key(year: i64, month: u32, day: u32) -> i64 {
    year * 10000 + (month as i64) * 100 + day as i64
}

/// Parse a wide range of date spellings. Returns `None` when the value cannot
/// be interpreted, so callers can mark the observation UNKNOWN instead of
/// guessing.
pub fn parse_date(raw: &str) -> Option<ParsedDate> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    // Drop time components, keep the date.
    let head: String = s
        .split(|c| c == 'T' || c == ' ')
        .next()
        .unwrap_or(s)
        .trim()
        .to_string();

    if let Some(c) = re_ymd().captures(&head) {
        let y: i64 = c[1].parse().ok()?;
        let m: u32 = c[2].parse().ok()?;
        let d: u32 = c[3].parse().ok()?;
        return Some(ParsedDate {
            iso: format!("{:04}-{:02}-{:02}", y, m, d),
            frequency: Frequency::Daily,
            sort_key: key(y, m, d),
        });
    }
    if let Some(c) = re_q_ym().captures(s) {
        let y: i64 = c[1].parse().ok()?;
        let q: u32 = c[2].parse().ok()?;
        if (1..=4).contains(&q) {
            let m = (q - 1) * 3 + 1;
            return Some(ParsedDate {
                iso: format!("{:04}-Q{}", y, q),
                frequency: Frequency::Quarterly,
                sort_key: key(y, m, 1),
            });
        }
    }
    if let Some(c) = re_q_my().captures(s) {
        let q: u32 = c[1].parse().ok()?;
        let y: i64 = c[2].parse().ok()?;
        if (1..=4).contains(&q) {
            let m = (q - 1) * 3 + 1;
            return Some(ParsedDate {
                iso: format!("{:04}-Q{}", y, q),
                frequency: Frequency::Quarterly,
                sort_key: key(y, m, 1),
            });
        }
    }
    if let Some(c) = re_ym().captures(&head) {
        let y: i64 = c[1].parse().ok()?;
        let m: u32 = c[2].parse().ok()?;
        if (1..=12).contains(&m) {
            return Some(ParsedDate {
                iso: format!("{:04}-{:02}", y, m),
                frequency: Frequency::Monthly,
                sort_key: key(y, m, 1),
            });
        }
    }
    if let Some(c) = re_my().captures(&head) {
        let m: u32 = c[1].parse().ok()?;
        let y: i64 = c[2].parse().ok()?;
        if (1..=12).contains(&m) {
            return Some(ParsedDate {
                iso: format!("{:04}-{:02}", y, m),
                frequency: Frequency::Monthly,
                sort_key: key(y, m, 1),
            });
        }
    }
    if let Some(c) = re_monthname().captures(s) {
        if let Some(m) = month_from_name(&c[1]) {
            let y: i64 = c[2].parse().ok()?;
            return Some(ParsedDate {
                iso: format!("{:04}-{:02}", y, m),
                frequency: Frequency::Monthly,
                sort_key: key(y, m, 1),
            });
        }
    }
    if let Some(c) = re_monthname_first().captures(s) {
        if let Some(m) = month_from_name(&c[2]) {
            let y: i64 = c[1].parse().ok()?;
            return Some(ParsedDate {
                iso: format!("{:04}-{:02}", y, m),
                frequency: Frequency::Monthly,
                sort_key: key(y, m, 1),
            });
        }
    }
    if let Some(c) = re_year().captures(&head) {
        let y: i64 = c[1].parse().ok()?;
        return Some(ParsedDate {
            iso: format!("{:04}-01-01", y),
            frequency: Frequency::Annual,
            sort_key: key(y, 1, 1),
        });
    }
    None
}

/// Today's date as YYYY-MM-DD (used as the default temporal ceiling).
pub fn today_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Human label used by the renderer, e.g. `2020`, `05/2020`, `Q2 2020`.
pub fn display_label(iso: &str, freq: Frequency) -> String {
    match freq {
        Frequency::Annual => iso.get(0..4).unwrap_or(iso).to_string(),
        Frequency::Quarterly => {
            let y = iso.get(0..4).unwrap_or("");
            let q = match iso.find('Q') { Some(i) => iso.get(i + 1..).unwrap_or(""), None => "" };
            if q.is_empty() {
                iso.to_string()
            } else {
                format!("Q{} {}", q, y)
            }
        }
        Frequency::Monthly => {
            let y = iso.get(0..4).unwrap_or("");
            let m = iso.get(5..7).unwrap_or("");
            if m.is_empty() {
                iso.to_string()
            } else {
                format!("{}/{}", m, y)
            }
        }
        _ => iso.to_string(),
    }
}