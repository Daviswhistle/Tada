//! Versioned wire contracts. Successful validation is not authority or evidence.
//! Schema checks MUST run before typed decoding at an untrusted boundary.

use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, fmt};

// Generated layout is deterministic; do not let rustfmt rewrite generated files.
#[rustfmt::skip]
mod generated;
pub use generated::*;

pub(crate) mod sealed {
    pub trait Sealed {}
}

pub trait Contract: sealed::Sealed + DeserializeOwned + Serialize {
    const NAME: &'static str;
}

/// An unsigned, exactly representable JSON/JavaScript counter.
/// Accepts integral JSON numbers such as 1.0, as JSON Schema requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SafeInteger(u64);

impl SafeInteger {
    pub const MAX: u64 = 9_007_199_254_740_991;

    pub fn new(value: u64) -> Option<Self> {
        (value <= Self::MAX).then_some(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for SafeInteger {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let number = serde_json::Number::deserialize(deserializer)?;
        if let Some(value) = number.as_u64() {
            return Self::new(value)
                .ok_or_else(|| serde::de::Error::custom("integer exceeds wire maximum"));
        }
        let value = number
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0 && *n <= Self::MAX as f64 && n.fract() == 0.0)
            .ok_or_else(|| serde::de::Error::custom("expected safe unsigned integer"))?;
        Ok(Self(value as u64))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractError(pub &'static str);

impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ContractError {}

pub fn validate(name: &str, value: &Value) -> Result<(), ContractError> {
    if !CONTRACT_NAMES.contains(&name) {
        return Err(ContractError("UNKNOWN_CONTRACT"));
    }
    let mut schema: Value =
        serde_json::from_str(include_str!("../../../packages/contracts/schema/v1.json"))
            .map_err(|_| ContractError("INVALID_EMBEDDED_SCHEMA"))?;
    schema["$ref"] = Value::String(format!("#/$defs/{name}"));
    // No HTTP or filesystem reference features are enabled in Cargo.toml.
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&schema)
        .map_err(|_| ContractError("SCHEMA_COMPILATION_FAILED"))?;
    if !validator.is_valid(value) {
        return Err(ContractError("SCHEMA_VALIDATION_FAILED"));
    }
    if name == "ArtifactManifest" {
        validate_manifest(value)?;
    }
    Ok(())
}

pub fn decode<T: Contract>(value: &Value) -> Result<T, ContractError> {
    validate(T::NAME, value)?;
    serde_json::from_value(value.clone()).map_err(|_| ContractError("TYPED_DECODE_FAILED"))
}

pub fn encode<T: Contract>(value: &T) -> Result<Value, ContractError> {
    let json = serde_json::to_value(value).map_err(|_| ContractError("TYPED_ENCODE_FAILED"))?;
    validate(T::NAME, &json)?;
    Ok(json)
}

fn validate_manifest(value: &Value) -> Result<(), ContractError> {
    // Shape is checked above. Do not invoke this helper on unchecked input.
    let mut seen = BTreeSet::new();
    let mut passed = BTreeSet::new();
    for record in value["verification"].as_array().expect("validated array") {
        let id = record["criterion_id"].as_str().expect("validated string");
        if !seen.insert(id) {
            return Err(ContractError("DUPLICATE_VERIFICATION_CRITERION"));
        }
        if record["result"] == "pass" {
            passed.insert(id);
        }
    }
    let required: BTreeSet<&str> = value["required_criteria"]
        .as_array()
        .expect("validated array")
        .iter()
        .map(|v| v.as_str().expect("validated string"))
        .collect();
    let unmet: BTreeSet<&str> = required.difference(&passed).copied().collect();
    let declared: BTreeSet<&str> = value["unmet_required_criteria"]
        .as_array()
        .expect("validated array")
        .iter()
        .map(|v| v.as_str().expect("validated string"))
        .collect();
    if unmet != declared {
        return Err(ContractError("UNMET_CRITERIA_MISMATCH"));
    }
    let unresolved = !value["unresolved_effects"]
        .as_array()
        .expect("validated array")
        .is_empty();
    if value["status"] == "complete" && (!unmet.is_empty() || unresolved) {
        return Err(ContractError("UNVERIFIED_COMPLETE"));
    }
    if value["status"] == "partial" && unmet.is_empty() && !unresolved {
        return Err(ContractError("PARTIAL_WITHOUT_UNMET_CONDITION"));
    }
    Ok(())
}
