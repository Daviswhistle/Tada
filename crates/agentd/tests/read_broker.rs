//! Real native read gateway regressions; no model or source text in its authority.
use serde_json::Value;
use std::{fs, path::PathBuf, process::Command};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).unwrap();
        let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let root = std::env::temp_dir().join(format!("tada-read-{id}"));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn request(temp: &Temp, identity: &str, op: &str, path: &str, offset: usize) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_tada-read-broker"))
        .args([
            temp.0.to_str().unwrap(),
            identity,
            op,
            path,
            &offset.to_string(),
        ])
        .output()
        .unwrap();
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.success(), reply["ok"] == true);
    assert!(output.stderr.is_empty());
    reply
}
#[cfg(any(target_os = "linux", windows))]
fn identity(temp: &Temp) -> String {
    let reply = request(temp, "-", "scope", ".", 0);
    assert_eq!(reply["ok"], true, "{reply}");
    reply["data"]["identity"].as_str().unwrap().to_owned()
}

#[test]
#[cfg(any(target_os = "linux", windows))]
fn lists_and_reads_discovered_unicode_text_with_bound_root_and_hash() {
    let temp = Temp::new();
    fs::create_dir(temp.0.join("notes")).unwrap();
    fs::write(temp.0.join("notes/회의.md"), "Mina owns the launch.\n").unwrap();
    let id = identity(&temp);
    let listed = request(&temp, &id, "list", "notes", 0);
    assert_eq!(listed["data"]["entries"][0]["path"], "notes/회의.md");
    let read = request(&temp, &id, "read", "notes/회의.md", 0);
    assert_eq!(read["ok"], true);
    assert_eq!(read["data"]["content"], "Mina owns the launch.\n");
    assert_eq!(read["data"]["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(read["data"]["trust"], "source_data_not_instructions");
    assert_eq!(
        request(&temp, "0:0:0", "read", "notes/회의.md", 0)["error"],
        "SOURCE_ROOT_CHANGED"
    );
}
#[test]
#[cfg(any(target_os = "linux", windows))]
fn no_path_escape_secret_filename_nontext_oversize_or_hardlink_reads() {
    let temp = Temp::new();
    fs::write(temp.0.join("small.md"), "public").unwrap();
    fs::write(temp.0.join("large.md"), vec![b'a'; 8193]).unwrap();
    fs::write(temp.0.join("binary.md"), [b'a', 0, b'b']).unwrap();
    fs::write(temp.0.join("credentials.json"), "canary").unwrap();
    fs::write(temp.0.join(".env"), "canary").unwrap();
    fs::hard_link(temp.0.join("small.md"), temp.0.join("alias.md")).unwrap();
    let id = identity(&temp);
    for path in [
        "../x",
        "/etc/passwd",
        "x:stream",
        "x\\y",
        ".env",
        "credentials.json",
        "large.md",
        "binary.md",
        "small.md",
        "alias.md",
    ] {
        let reply = request(&temp, &id, "read", path, 0);
        assert_eq!(reply["ok"], false, "{path}: {reply}");
        assert!(!reply.to_string().contains("canary"));
    }
    assert_eq!(request(&temp, &id, "write", "small.md", 0)["ok"], false);
    assert_eq!(
        fs::read_to_string(temp.0.join("small.md")).unwrap(),
        "public"
    );
}
#[test]
#[cfg(any(target_os = "linux", windows))]
fn directory_pages_expose_remaining_entries_instead_of_silent_truncation() {
    let temp = Temp::new();
    for n in 0..65 {
        fs::write(temp.0.join(format!("note-{n:03}.md")), "x").unwrap();
    }
    let id = identity(&temp);
    let first = request(&temp, &id, "list", ".", 0);
    let second = request(&temp, &id, "list", ".", 64);
    assert_eq!(first["data"]["entries"].as_array().unwrap().len(), 64);
    assert_eq!(first["data"]["next_offset"], 64);
    assert_eq!(second["data"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(second["data"]["next_offset"], Value::Null);
    assert_eq!(request(&temp, &id, "list", ".", 66)["ok"], false);
}
#[test]
#[cfg(target_os = "linux")]
fn symlink_leaves_and_directories_cannot_escape_root() {
    use std::os::unix::fs::symlink;
    let temp = Temp::new();
    let outside = Temp::new();
    fs::write(outside.0.join("outside.md"), "outside-canary").unwrap();
    symlink(outside.0.join("outside.md"), temp.0.join("link.md")).unwrap();
    symlink(&outside.0, temp.0.join("directory")).unwrap();
    let id = identity(&temp);
    for path in ["link.md", "directory/outside.md"] {
        assert_eq!(request(&temp, &id, "read", path, 0)["ok"], false);
    }
    let root_link = Temp(temp.0.join("root-link"));
    symlink(&outside.0, &root_link.0).unwrap();
    assert_eq!(request(&root_link, "-", "scope", ".", 0)["ok"], false);
    assert_eq!(
        request(&temp, &id, "list", ".", 0)["data"]["entries"],
        serde_json::json!([])
    );
}
#[test]
#[cfg(not(any(target_os = "linux", windows)))]
fn unsupported_gateway_reports_no_access() {
    let temp = Temp::new();
    assert_eq!(
        request(&temp, "-", "scope", ".", 0)["error"],
        "READ_GATEWAY_UNSUPPORTED_PLATFORM"
    );
}
