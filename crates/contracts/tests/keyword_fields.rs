use serde_json::json;
use tada_contracts::{decode, encode, InputSnapshot};

#[test]
fn raw_identifier_retains_the_original_wire_key() {
    let wire = json!({
        "ref": "fs://grant/input",
        "snapshot": format!("sha256:{}", "a".repeat(64))
    });
    let input = decode::<InputSnapshot>(&wire).unwrap();
    assert_eq!(input.r#ref, "fs://grant/input");
    assert_eq!(encode(&input).unwrap(), wire);
}

#[test]
fn rust_spelling_is_not_an_alternate_wire_field() {
    for key in ["r#ref", "ref_"] {
        let mut wire = json!({
            "ref": "fs://grant/input",
            "snapshot": format!("sha256:{}", "a".repeat(64))
        });
        let value = wire.as_object_mut().unwrap().remove("ref").unwrap();
        wire[key] = value;
        assert!(decode::<InputSnapshot>(&wire).is_err());
    }
}
