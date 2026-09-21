//! Unit normalization. Every observation is converted to a canonical unit
//! inside its dimension, and the applied factor is reported back so the
//! transformation stays auditable.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitInfo {
    pub input: String,
    pub canonical: String,
    pub dimension: String,
    pub factor: f64,
    pub known: bool,
}

fn mk(input: &str, canonical: &str, dimension: &str, factor: f64, known: bool) -> UnitInfo {
    UnitInfo {
        input: input.to_string(),
        canonical: canonical.to_string(),
        dimension: dimension.to_string(),
        factor,
        known,
    }
}

/// Normalize a raw unit string. Unknown units are preserved verbatim with
/// `known = false` so downstream validation can flag them instead of silently
/// assuming a scale.
pub fn normalize_unit(raw: &str) -> UnitInfo {
    let s = raw.trim().to_lowercase();
    let s = s.trim_end_matches('.').trim().to_string();
    if s.is_empty() {
        return mk(raw, "count", "count", 1.0, true);
    }
    match s.as_str() {
        "count" | "counts" | "units" | "unit" | "number" | "no" | "qty" | "quantity"
        | "people" | "persons" | "users" | "user" | "subscribers" | "subscriber" | "passengers"
        | "passenger" | "visitors" | "downloads" | "sales" | "copies" | "installs" => {
            mk(raw, "count", "count", 1.0, true)
        }
        "k" | "thousand" | "thousands" | "k units" | "000" => mk(raw, "count", "count", 1e3, true),
        "m" | "mn" | "million" | "millions" | "mio" => mk(raw, "count", "count", 1e6, true),
        "bn" | "b" | "billion" | "billions" => mk(raw, "count", "count", 1e9, true),
        "tn" | "trillion" | "trillions" => mk(raw, "count", "count", 1e12, true),
        "%" | "percent" | "percent." | "pct" | "percentage" | "share" => {
            mk(raw, "percent", "ratio", 1.0, true)
        }
        "usd" | "$" | "us$" | "dollar" | "dollars" | "us dollar" | "current us$" => {
            mk(raw, "USD", "currency", 1.0, true)
        }
        "usd million" | "million usd" | "us$ million" | "mn usd" => {
            mk(raw, "USD", "currency", 1e6, true)
        }
        "usd billion" | "billion usd" | "us$ billion" | "bn usd" => {
            mk(raw, "USD", "currency", 1e9, true)
        }
        "inr" | "rs" | "rs." | "rupee" | "rupees" => mk(raw, "INR", "currency", 1.0, true),
        "eur" | "euro" | "euros" => mk(raw, "EUR", "currency", 1.0, true),
        "gbp" | "pound" | "pounds" => mk(raw, "GBP", "currency", 1.0, true),
        "kg" | "kilogram" | "kilograms" => mk(raw, "kg", "mass", 1.0, true),
        "t" | "tonne" | "tonnes" | "metric ton" | "metric tons" | "mt" => {
            mk(raw, "kg", "mass", 1e3, true)
        }
        "kt" | "kilotonne" | "kilotonnes" => mk(raw, "kg", "mass", 1e6, true),
        "g" | "gram" | "grams" => mk(raw, "kg", "mass", 1e-3, true),
        "lb" | "pound mass" | "pounds mass" => mk(raw, "kg", "mass", 0.453_592_37, true),
        "bbl" | "barrel" | "barrels" | "oil barrel" => mk(raw, "barrel", "volume", 1.0, true),
        "l" | "litre" | "litres" | "liter" | "liters" => mk(raw, "litre", "volume", 1.0, true),
        "m3" | "cubic metre" | "cubic metre" | "cubic meter" | "cubic meters" => {
            mk(raw, "m3", "volume", 1.0, true)
        }
        "km" | "kilometer" | "kilometers" => {
            mk(raw, "km", "distance", 1.0, true)
        }
        "mi" | "mile" | "miles" => mk(raw, "km", "distance", 1.609_344, true),
        "kwh" | "kilowatt hour" | "kilowatt hours" => mk(raw, "kWh", "energy", 1.0, true),
        "gwh" => mk(raw, "kWh", "energy", 1e6, true),
        "mwh" => mk(raw, "kWh", "energy", 1e3, true),
        "twh" => mk(raw, "kWh", "energy", 1e9, true),
        "w" | "watt" | "watts" => mk(raw, "W", "power", 1.0, true),
        "mw" => mk(raw, "W", "power", 1e6, true),
        "gw" => mk(raw, "W", "power", 1e9, true),
        "tw" => mk(raw, "W", "power", 1e12, true),
        "tco2" | "tonnes co2" | "tonnes of co2" | "tco2e" => mk(raw, "tco2", "emissions", 1.0, true),
        "ktco2" => mk(raw, "tco2", "emissions", 1e3, true),
        "mtco2" => mk(raw, "tco2", "emissions", 1e6, true),
        "ha" | "hectare" | "hectares" => mk(raw, "ha", "area", 1.0, true),
        "km2" | "square kilometre" | "square kilometer" => {
            mk(raw, "km2", "area", 1.0, true)
        }
        "years" | "year" | "yrs" => mk(raw, "years", "time", 1.0, true),
        "per 100 people" | "per 100" => mk(raw, "per 100 people", "rate", 1.0, true),
        _ => mk(raw, &s, "unknown", 1.0, false),
    }
}

/// Convert a value from `from` into `to` when both share a dimension.
/// Returns `None` when the conversion is not defined, so callers never apply an
/// invented factor.
pub fn convert(value: f64, from: &str, to: &str) -> Option<f64> {
    let a = normalize_unit(from);
    let b = normalize_unit(to);
    if !a.known || !b.known || a.dimension != b.dimension {
        return None;
    }
    Some(value * a.factor / b.factor)
}