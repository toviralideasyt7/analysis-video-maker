//! Raw ingestion for CSV / TSV / JSON / JSONL / XLSX.
//!
//! Ingestion never interprets meaning: it only produces a rectangular table of
//! strings plus its column names, so every later interpretation stays auditable.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTable {
    pub source_file: String,
    pub sheet: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

impl RawTable {
    pub fn new(source_file: String, sheet: Option<String>, columns: Vec<String>) -> Self {
        RawTable {
            source_file,
            sheet,
            columns,
            rows: Vec::new(),
        }
    }

    /// Index of a column, case/space insensitive.
    pub fn column_index(&self, name: &str) -> Option<usize> {
        let want = crate::entities::norm_key(name);
        self.columns
            .iter()
            .position(|c| crate::entities::norm_key(c) == want)
    }
}

const MAX_ROWS: usize = 2_000_000;

pub fn ingest_file(path: &Path) -> Result<Vec<RawTable>> {
    if !path.exists() {
        bail!("input file does not exist: {}", path.display());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "csv" => Ok(vec![ingest_delimited(path, b',')?]),
        "tsv" | "tab" => Ok(vec![ingest_delimited(path, b'\t')?]),
        "txt" => Ok(vec![ingest_delimited(path, b',')?]),
        "json" => ingest_json(path),
        "jsonl" | "ndjson" => Ok(vec![ingest_jsonl(path)?]),
        "xlsx" | "xlsm" | "xls" | "ods" => ingest_workbook(path),
        other => bail!("unsupported input extension: .{}", other),
    }
}

fn ingest_delimited(path: &Path, delimiter: u8) -> Result<RawTable> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .flexible(true)
        .has_headers(true)
        .from_path(path)
        .with_context(|| format!("opening {}", path.display()))?;
    let columns: Vec<String> = reader
        .headers()
        .with_context(|| format!("reading header of {}", path.display()))?
        .iter()
        .map(|h| h.trim().to_string())
        .collect();
    let mut table = RawTable::new(
        path.file_name().and_then(|f| f.to_str()).unwrap_or("").to_string(),
        None,
        columns,
    );
    for (i, rec) in reader.records().enumerate() {
        if i >= MAX_ROWS {
            break;
        }
        let rec = rec.with_context(|| format!("row {} of {}", i, path.display()))?;
        table.rows.push(rec.iter().map(|v| v.trim().to_string()).collect());
    }
    Ok(table)
}

fn json_value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn table_from_json_objects(
    path: &Path,
    objects: &[serde_json::Value],
    sheet: Option<String>,
) -> RawTable {
    let mut columns: Vec<String> = Vec::new();
    for o in objects {
        if let Some(map) = o.as_object() {
            for k in map.keys() {
                if !columns.iter().any(|c| c == k) {
                    columns.push(k.clone());
                }
            }
        }
    }
    let mut table = RawTable::new(
        path.file_name().and_then(|f| f.to_str()).unwrap_or("").to_string(),
        sheet,
        columns,
    );
    for o in objects {
        if let Some(map) = o.as_object() {
            let row: Vec<String> = table
                .columns
                .iter()
                .map(|c| map.get(c).map(json_value_to_string).unwrap_or_default())
                .collect();
            table.rows.push(row);
        }
    }
    table
}

fn ingest_json(path: &Path) -> Result<Vec<RawTable>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("parsing JSON {}", path.display()))?;
    let objects: Vec<serde_json::Value> = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(map) => {
            // Accept `{ "rows": [...] }` style envelopes without guessing further.
            let mut found = None;
            for key in ["rows", "data", "records", "observations", "items", "results"] {
                if let Some(serde_json::Value::Array(items)) = map.get(key) {
                    found = Some(items.clone());
                    break;
                }
            }
            found.unwrap_or_else(|| vec![serde_json::Value::Object(map)])
        }
        other => vec![other],
    };
    Ok(vec![table_from_json_objects(path, &objects, None)])
}

fn ingest_jsonl(path: &Path) -> Result<RawTable> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let mut objects = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        objects.push(serde_json::from_str(line).with_context(|| format!("parsing JSONL line in {}", path.display()))?);
    }
    Ok(table_from_json_objects(path, &objects, None))
}

fn ingest_workbook(path: &Path) -> Result<Vec<RawTable>> {
    use calamine::{open_workbook_auto, Reader};
    let mut wb = open_workbook_auto(path).with_context(|| format!("opening workbook {}", path.display()))?;
    let names = wb.sheet_names().to_vec();
    let mut tables = Vec::new();
    for name in names {
        let range = match wb.worksheet_range(&name) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut iter = range.rows();
        let header_row = match iter.next() {
            Some(r) => r,
            None => continue,
        };
        let columns: Vec<String> = header_row
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let s = cell_to_string(c);
                if s.trim().is_empty() {
                    format!("column{}", i + 1)
                } else {
                    s
                }
            })
            .collect();
        let mut table = RawTable::new(
            path.file_name().and_then(|f| f.to_str()).unwrap_or("").to_string(),
            Some(name.clone()),
            columns,
        );
        for row in iter {
            if table.rows.len() >= MAX_ROWS {
                break;
            }
            table.rows.push(row.iter().map(cell_to_string).collect());
        }
        tables.push(table);
    }
    if tables.is_empty() {
        bail!("workbook {} contained no readable sheets", path.display());
    }
    Ok(tables)
}

fn cell_to_string(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{:?}", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    #[test]
    fn reads_csv_fixture() {
        let tables = ingest_file(&fixture("phone_brands.csv")).unwrap();
        assert_eq!(tables.len(), 1);
        let t = &tables[0];
        assert_eq!(t.columns[0], "brand");
        assert_eq!(t.rows.len(), 6);
        assert_eq!(t.column_index("Brand"), Some(0));
    }

    #[test]
    fn reads_json_fixture() {
        let tables = ingest_file(&fixture("phone_brands.json")).unwrap();
        assert_eq!(tables[0].rows.len(), 3);
        assert!(tables[0].columns.contains(&"value".to_string()));
    }

    #[test]
    fn rejects_unknown_extension() {
        assert!(ingest_file(std::path::Path::new("nope.pdf")).is_err());
    }
}