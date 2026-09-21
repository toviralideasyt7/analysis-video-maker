//! Entity normalization + resolution.
//!
//! Countries resolve against the bundled ISO-3166 reference table. Non-country
//! entities (brands, companies, products) fall back to a stable slug and are
//! reported as `resolved` only when the caller supplied them explicitly, which
//! keeps the resolver from inventing an identity it cannot verify.

use crate::model::EntityRef;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CountryEntry {
    pub name: String,
    pub iso2: String,
    pub iso3: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub region: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub status: String, // resolved | ambiguous | unresolved
    pub entity: EntityRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<String>>,
}

const COUNTRIES_JSON: &str = include_str!("../data/countries.json");

pub fn countries() -> &'static Vec<CountryEntry> {
    static C: OnceLock<Vec<CountryEntry>> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(COUNTRIES_JSON).expect("bundled countries.json is valid"))
}

fn index() -> &'static HashMap<String, Vec<usize>> {
    static I: OnceLock<HashMap<String, Vec<usize>>> = OnceLock::new();
    I.get_or_init(|| {
        let mut map: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, c) in countries().iter().enumerate() {
            let mut keys = vec![
                norm_key(&c.name),
                norm_key(&c.iso2),
                norm_key(&c.iso3),
            ];
            for a in &c.aliases {
                keys.push(norm_key(a));
            }
            for k in keys {
                if k.is_empty() {
                    continue;
                }
                let e = map.entry(k).or_default();
                if !e.contains(&i) {
                    e.push(i);
                }
            }
        }
        map
    })
}

/// Aggressive comparison key: lowercase, keep only alphanumerics.
pub fn norm_key(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// URL/file-safe slug for an entity name.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_dash = false;
    for c in s.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
            prev_dash = false;
        } else if !out.is_empty() && !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Regional-indicator flag emoji for a real ISO-3166 alpha-2 code.
pub fn flag_emoji(iso2: &str) -> Option<String> {
    let up = iso2.to_uppercase();
    let b = up.as_bytes();
    if b.len() != 2 || !b[0].is_ascii_uppercase() || !b[1].is_ascii_uppercase() {
        return None;
    }
    let mut s = String::new();
    for byte in b {
        let c = char::from_u32(0x1F1E6 + (byte - b'A') as u32)?;
        s.push(c);
    }
    Some(s)
}

/// `true` when the code maps to a real, fetchable flag asset (flagcdn style).
pub fn has_real_flag(iso2: &str) -> bool {
    let up = iso2.to_uppercase();
    let known_aggregates = ["XX", "XO", "XS", "XE", "AN", "XU", "OC"];
    known_aggregates.contains(&up.as_str()) == false && up.len() == 2
}

fn country_ref(c: &CountryEntry) -> EntityRef {
    EntityRef {
        id: slugify(&c.name),
        name: c.name.clone(),
        iso2: Some(c.iso2.clone()),
        flag_code: if has_real_flag(&c.iso2) {
            Some(c.iso2.to_lowercase())
        } else {
            None
        },
        group: Some(c.region.clone()),
    }
}

/// Resolve a raw entity name.
pub fn resolve(name: &str) -> Resolution {
    let key = norm_key(name);
    if key.is_empty() {
        return Resolution {
            status: "unresolved".into(),
            entity: EntityRef {
                id: String::new(),
                name: name.to_string(),
                ..Default::default()
            },
            candidates: None,
        };
    }
    match index().get(&key) {
        Some(hits) if hits.len() == 1 => Resolution {
            status: "resolved".into(),
            entity: country_ref(&countries()[hits[0]]),
            candidates: None,
        },
        Some(hits) if hits.len() > 1 => Resolution {
            status: "ambiguous".into(),
            entity: EntityRef {
                id: slugify(name),
                name: name.to_string(),
                ..Default::default()
            },
            candidates: Some(hits.iter().map(|i| countries()[*i].name.clone()).collect()),
        },
        _ => Resolution {
            status: "unresolved".into(),
            entity: EntityRef {
                id: slugify(name),
                name: name.to_string(),
                ..Default::default()
            },
            candidates: None,
        },
    }
}

/// Bulk resolve, preserving input order.
pub fn resolve_many(names: &[String]) -> Vec<Resolution> {
    names.iter().map(|n| resolve(n)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_aliases() {
        assert_eq!(resolve("USA").status, "resolved");
        assert_eq!(resolve("USA").entity.iso2.as_deref(), Some("US"));
        assert_eq!(resolve("uk").entity.iso2.as_deref(), Some("GB"));
        assert_eq!(resolve("Deutschland").entity.iso2.as_deref(), Some("DE"));
        assert_eq!(resolve("DR Congo").entity.iso2.as_deref(), Some("CD"));
    }

    #[test]
    fn unresolved_is_not_guessed() {
        let r = resolve("Nokia");
        assert_eq!(r.status, "unresolved");
        assert_eq!(r.entity.id, "nokia");
        assert!(r.entity.iso2.is_none());
    }

    #[test]
    fn flag_emoji_is_regional_indicators() {
        assert_eq!(flag_emoji("in").unwrap(), "\u{1F1EE}\u{1F1F3}");
        assert!(flag_emoji("X").is_none());
    }

    #[test]
    fn slugs_are_stable() {
        assert_eq!(slugify("Sony Ericsson"), "sony-ericsson");
        assert_eq!(slugify("  Cote d'Ivoire "), "cote-d-ivoire");
    }
}