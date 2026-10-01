//! Parse bounded JSON while rejecting duplicate keys, including escaped aliases.
//! Value::from_str alone would discard earlier duplicate members before validation.
use serde::{
    de::{Error as _, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{Map, Number, Value};
use std::fmt;

struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Unique;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("JSON with unique object keys")
            }
            fn visit_bool<E>(self, v: bool) -> Result<Unique, E> {
                Ok(Unique(Value::Bool(v)))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Unique, E> {
                Ok(Unique(Value::Number(v.into())))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Unique, E> {
                Ok(Unique(Value::Number(v.into())))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Unique, E> {
                Number::from_f64(v)
                    .map(|n| Unique(Value::Number(n)))
                    .ok_or_else(|| E::custom("NONFINITE_NUMBER"))
            }
            fn visit_str<E>(self, v: &str) -> Result<Unique, E> {
                Ok(Unique(Value::String(v.into())))
            }
            fn visit_string<E>(self, v: String) -> Result<Unique, E> {
                Ok(Unique(Value::String(v)))
            }
            fn visit_unit<E>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Unique, A::Error> {
                let mut values = Vec::new();
                while let Some(Unique(value)) = seq.next_element()? {
                    values.push(value);
                }
                Ok(Unique(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Unique, A::Error> {
                let mut values = Map::new();
                while let Some(key) = access.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(A::Error::custom("DUPLICATE_KEY"));
                    }
                    let Unique(value) = access.next_value()?;
                    values.insert(key, value);
                }
                Ok(Unique(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}
pub(super) fn parse(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    let mut parser = serde_json::Deserializer::from_slice(bytes);
    let Unique(value) = Unique::deserialize(&mut parser)?;
    parser.end()?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_keys_at_every_depth_and_escaped_aliases_are_rejected() {
        for input in [
            r#"{"id":"a","id":"b"}"#,
            r#"{"params":{"task_id":"a","task_id":"b"}}"#,
            r#"{"id":"a","\u0069d":"b"}"#,
            r#"{"x":[{"a":1,"a":2}]}"#,
        ] {
            assert!(parse(input.as_bytes()).is_err());
        }
    }
    #[test]
    fn trailing_partial_overdeep_and_nonfinite_json_are_rejected() {
        for input in [
            "{}{}".to_string(),
            "{\"a\":".into(),
            "[1e999]".into(),
            format!("{}0{}", "[".repeat(140), "]".repeat(140)),
        ] {
            assert!(parse(input.as_bytes()).is_err());
        }
    }
    #[test]
    fn ordinary_json_retains_values_and_canonical_key_order() {
        let first = parse(br#"{ "b": [null,true,1,1.5], "a":"value" }"#).unwrap();
        let second = parse(br#"{"a":"value","b":[null,true,1,1.5]}"#).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&second).unwrap()
        );
    }
}
