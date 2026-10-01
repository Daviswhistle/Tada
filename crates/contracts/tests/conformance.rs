use serde_json::Value;
use tada_contracts::*;

fn typed_roundtrip(name: &str, value: &Value) -> Value {
    match name {
        "TaskContract" => encode(&decode::<TaskContract>(value).unwrap()).unwrap(),
        "ControlRequest" => encode(&decode::<ControlRequest>(value).unwrap()).unwrap(),
        "TaskSnapshot" => encode(&decode::<TaskSnapshot>(value).unwrap()).unwrap(),
        "ActionRecord" => encode(&decode::<ActionRecord>(value).unwrap()).unwrap(),
        "PermissionGrant" => encode(&decode::<PermissionGrant>(value).unwrap()).unwrap(),
        "ProviderCapabilityManifest" => {
            encode(&decode::<ProviderCapabilityManifest>(value).unwrap()).unwrap()
        }
        "ArtifactManifest" => encode(&decode::<ArtifactManifest>(value).unwrap()).unwrap(),
        _ => panic!("missing typed roundtrip for {name}"),
    }
}

// JSON Schema treats 1 and 1.0 as the same integer. Compare numeric values,
// but do not relax string/array/object comparisons or optional-field presence.
fn semantic_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| semantic_equal(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|w| semantic_equal(v, w)))
        }
        _ => left == right,
    }
}

#[test]
fn shared_fixtures_and_typed_roundtrips() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../fixtures/contracts/v1/cases.json")).unwrap();
    assert!(
        cases.len() >= 70,
        "do not silently shrink the regression set"
    );
    for case in &cases {
        let name = case["contract"].as_str().unwrap();
        let value = &case["instance"];
        let result = validate(name, value);
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {:?}",
            case["name"],
            result
        );
        if let Err(error) = result {
            assert!(!error.to_string().contains("DO_NOT_LOG_THIS_SECRET"));
        } else {
            let roundtrip = typed_roundtrip(name, value);
            assert!(
                semantic_equal(value, &roundtrip),
                "roundtrip changed {}",
                case["name"]
            );
        }
        println!("fixture {}: passed", case["name"]);
    }
    println!("{} shared fixtures passed", cases.len());
}

#[test]
fn no_unprepared_or_uncertain_dispatch() {
    assert!(is_action_transition_allowed(
        ActionState::Prepared,
        ActionState::Dispatching
    ));
    for from in [
        ActionState::Proposed,
        ActionState::Authorized,
        ActionState::Uncertain,
        ActionState::Verified,
        ActionState::Compensated,
        ActionState::Rejected,
    ] {
        assert!(!is_action_transition_allowed(
            from,
            ActionState::Dispatching
        ));
    }
}

#[test]
fn invalid_contract_and_counter_fail_closed() {
    assert!(validate("Unknown", &serde_json::json!({})).is_err());
    assert!(SafeInteger::new(9_007_199_254_740_992).is_none());
    assert!(serde_json::from_str::<SafeInteger>("1.5").is_err());
    assert_eq!(serde_json::from_str::<SafeInteger>("1.0").unwrap().get(), 1);
}
