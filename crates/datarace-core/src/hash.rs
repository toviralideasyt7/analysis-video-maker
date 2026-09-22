//! Stable content hashing for the research cache and provenance checks.

use sha2::{Digest, Sha256};
use std::path::Path;

/// SHA-256 of arbitrary bytes, hex encoded.
pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// SHA-256 of a file's contents (used for cache keys / asset integrity).
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(sha256_bytes(&bytes))
}

/// Canonical hash of a JSON value: object keys are sorted first so that key
/// order never changes the hash.
pub fn sha256_json(value: &serde_json::Value) -> String {
    let canonical = canonicalize(value);
    sha256_bytes(canonical.to_string().as_bytes())
}

fn canonicalize(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonicalize(map.get(k).unwrap()));
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(canonicalize).collect())
        }
        other => other.clone(),
    }
}