use serde_json::Value;
use tada_contracts::{worker::*, Contract};

fn roundtrip<T: Contract>(value: &Value) {
    let typed = tada_contracts::decode::<T>(value).unwrap();
    let encoded = tada_contracts::encode(&typed).unwrap();
    let restored = tada_contracts::decode::<T>(&encoded).unwrap();
    assert_eq!(tada_contracts::encode(&restored).unwrap(), encoded);
    // 1.0 is a valid JSON-Schema integer and normalizes through SafeInteger.
    let input: Value = serde_json::from_str(&serde_json::to_string(value).unwrap()).unwrap();
    assert!(tada_contracts::validate(T::NAME, &input).is_ok());
}
#[test]
fn shared_worker_wire_cases_and_typed_roundtrips() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("../../../fixtures/worker/v1/cases.json")).unwrap();
    assert_eq!(cases.len(), 41, "fixed worker wire denominator");
    for case in cases {
        let name = case["contract"].as_str().unwrap();
        let value = &case["value"];
        assert_eq!(tada_contracts::validate(name, value).is_ok(), case["valid"].as_bool().unwrap(), "{}", case["name"]);
        if case["valid"] == true {
            match name {
                "WorkerRule" => roundtrip::<WorkerRule>(value),
                "WorkerPolicy" => roundtrip::<WorkerPolicy>(value),
                "WorkerArguments" => roundtrip::<WorkerArguments>(value),
                "WorkerProposal" => roundtrip::<WorkerProposal>(value),
                "WorkerGrant" => roundtrip::<WorkerGrant>(value),
                "WorkerAuthorization" => roundtrip::<WorkerAuthorization>(value),
                "WorkerCall" => roundtrip::<WorkerCall>(value),
                "WorkerRequest" => roundtrip::<WorkerRequest>(value),
                "WorkerResult" => roundtrip::<WorkerResult>(value),
                "WorkerReply" => roundtrip::<WorkerReply>(value),
                _ => panic!("unhandled fixture contract"),
            }
        }
        println!("worker fixture {}: passed", case["name"]);
    }
}
