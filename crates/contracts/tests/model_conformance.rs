use tada_contracts::{decode, encode, model::ModelEvent, validate};

#[test]
fn shared_model_event_fixtures_and_typed_roundtrips() {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../../fixtures/model-events.v1.json")).unwrap();
    assert_eq!(rows.len(), 36, "fixed model-wire denominator");
    for row in rows {
        let name = row["name"].as_str().unwrap();
        let expected = row["valid"].as_bool().unwrap();
        let value = &row["value"];
        assert_eq!(validate("ModelEvent", value).is_ok(), expected, "{name}");
        if expected {
            let event: ModelEvent = decode(value).unwrap();
            validate("ModelEvent", &encode(&event).unwrap()).unwrap();
        } else {
            assert!(decode::<ModelEvent>(value).is_err(), "{name}");
        }
        println!("model fixture {name}: passed");
    }
}
