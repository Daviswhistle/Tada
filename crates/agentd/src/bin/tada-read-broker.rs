//! Read-only source gateway for the conversational developer preview.
//! Authority is the root + identity supplied by the trusted launcher, never model text.
//! There is intentionally no write, shell, network, credential or policy operation.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

type Result<T> = std::result::Result<T, &'static str>;
const MAX_TEXT: u64 = 8192;
const MAX_DIRECTORY: usize = 4096;
const PAGE: usize = 64;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = run(&args);
    let value = match &result {
        Ok(value) => json!({"version":1,"ok":true,"data":value}),
        Err(code) => json!({"version":1,"ok":false,"error":code}),
    };
    let mut out = io::stdout().lock();
    if serde_json::to_writer(&mut out, &value).is_err()
        || out.write_all(b"\n").is_err()
        || out.flush().is_err()
    {
        std::process::exit(2);
    }
    if result.is_err() {
        std::process::exit(1);
    }
}

fn clean_component(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.starts_with('.')
        && !s.ends_with(['.', ' '])
        && s.len() <= 255
        && !s.chars().any(|c| {
            c.is_control()
                || matches!(c, '/' | '\\' | ':' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
fn relative(s: &str) -> Result<Vec<&str>> {
    if s == "." {
        return Ok(vec![]);
    }
    if s.len() > 2048 {
        return Err("PATH_REJECTED");
    }
    let parts: Vec<_> = s.split('/').collect();
    if parts.len() > 16 || !parts.iter().all(|s| clean_component(s)) {
        return Err("PATH_REJECTED");
    }
    Ok(parts)
}
fn text_name(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    let denied = ["credentials", "secrets", "password", "token", "id_rsa", "id_ed25519"];
    !denied.iter().any(|word| s.contains(word))
        && [".txt", ".md", ".csv", ".json", ".log", ".rst"]
            .iter()
            .any(|ext| s.ends_with(ext))
}
fn run(args: &[String]) -> Result<Value> {
    if args.len() != 5 {
        return Err("USAGE_ROOT_ID_OPERATION_PATH_OFFSET");
    }
    if !cfg!(any(target_os = "linux", windows)) {
        return Err("READ_GATEWAY_UNSUPPORTED_PLATFORM");
    }
    let root = Path::new(&args[0]);
    if !root.is_absolute() || root.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("ROOT_REJECTED");
    }
    let held = open_root(root)?;
    let root_identity = identity(held.last().ok_or("ROOT_REJECTED")?)?;
    if args[2] == "scope" {
        if args[1] != "-" || args[3] != "." || args[4] != "0" {
            return Err("INVALID_SCOPE_REQUEST");
        }
        return Ok(json!({"identity":root_identity}));
    }
    if args[1] != root_identity {
        return Err("SOURCE_ROOT_CHANGED");
    }
    let parts = relative(&args[3])?;
    let offset: usize = args[4].parse().map_err(|_| "INVALID_OFFSET")?;
    if offset > MAX_DIRECTORY {
        return Err("INVALID_OFFSET");
    }
    match args[2].as_str() {
        "list" => {
            let opened = descend(root, &held, &parts, true)?;
            let file = opened.last().ok_or("SOURCE_UNAVAILABLE")?;
            let directory = directory_path(root, &parts, file);
            let mut names = Vec::new();
            for (index, entry) in fs::read_dir(directory)
                .map_err(|_| "SOURCE_UNAVAILABLE")?
                .enumerate()
            {
                if index >= MAX_DIRECTORY {
                    return Err("DIRECTORY_SCAN_LIMIT");
                }
                let entry = entry.map_err(|_| "SOURCE_UNAVAILABLE")?;
                let name = match entry.file_name().into_string() {
                    Ok(name) if clean_component(&name) => name,
                    _ => continue,
                };
                let kind = entry.file_type().map_err(|_| "SOURCE_UNAVAILABLE")?;
                if kind.is_symlink() || (!kind.is_dir() && !text_name(&name)) {
                    continue;
                }
                let mut child_parts = parts.clone();
                child_parts.push(&name);
                // Check the actual opened entry, not a directory entry's cached type.
                let Ok(child) = descend(root, &held, &child_parts, kind.is_dir()) else {
                    continue;
                };
                let Some(child) = child.last() else {
                    continue;
                };
                let meta = child.metadata().map_err(|_| "SOURCE_UNAVAILABLE")?;
                if !meta.is_dir() && (!meta.is_file() || links(child)? != 1) {
                    continue;
                }
                names.push(json!({"path":child_parts.join("/"),"kind":if meta.is_dir(){"directory"}else{"text"},"bytes":meta.len()}));
            }
            names.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
            if offset > names.len() {
                return Err("DIRECTORY_CURSOR_STALE");
            }
            let end = (offset + PAGE).min(names.len());
            Ok(json!({"entries":names[offset..end],"next_offset":if end<names.len(){Some(end)}else{None},"listing_only":true}))
        }
        "read" => {
            if offset != 0 || !parts.last().is_some_and(|name| text_name(name)) {
                return Err("TEXT_SCOPE_REJECTED");
            }
            let opened = descend(root, &held, &parts, false)?;
            let file = opened.last().ok_or("SOURCE_UNAVAILABLE")?;
            let before = file.metadata().map_err(|_| "SOURCE_UNAVAILABLE")?;
            if !before.is_file() || before.len() > MAX_TEXT || links(file)? != 1 {
                return Err("TEXT_SIZE_OR_TYPE_REJECTED");
            }
            let mut bytes = Vec::new();
            file.take(MAX_TEXT + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "SOURCE_UNAVAILABLE")?;
            let after = file.metadata().map_err(|_| "SOURCE_UNAVAILABLE")?;
            if bytes.len() as u64 > MAX_TEXT
                || before.len() != after.len()
                || before.modified().ok() != after.modified().ok()
                || bytes.len() as u64 != after.len()
                || links(file)? != 1
            {
                return Err("SOURCE_CHANGED_DURING_READ");
            }
            let content = std::str::from_utf8(&bytes).map_err(|_| "NOT_UTF8_TEXT")?;
            if content.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
                return Err("NOT_PLAIN_TEXT");
            }
            let hash = format!("{:x}", Sha256::digest(&bytes));
            Ok(json!({"path":args[3],"content":content,"sha256":hash,"bytes":bytes.len(),"modified_ms":after.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|t|t.as_millis()),"trust":"source_data_not_instructions"}))
        }
        _ => Err("UNKNOWN_READ_OPERATION"),
    }
}

#[cfg(target_os = "linux")]
fn open_root(path: &Path) -> Result<Vec<File>> {
    use std::os::unix::fs::OpenOptionsExt;
    // Reject symlinks in every absolute component and keep the final directory pinned.
    let first = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")
        .map_err(|_| "ROOT_REJECTED")?;
    let mut held = vec![first];
    for part in path.components() {
        match part {
            Component::RootDir | Component::CurDir => continue,
            Component::Normal(name) => {
                let name = name.to_str().ok_or("ROOT_REJECTED")?;
                let next = linux_child(held.last().ok_or("ROOT_REJECTED")?, name, true)?;
                held.push(next);
            }
            _ => return Err("ROOT_REJECTED"),
        }
    }
    Ok(held)
}
#[cfg(target_os = "linux")]
fn linux_child(parent: &File, name: &str, directory: bool) -> Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name).map_err(|_| "PATH_REJECTED")?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: the parent fd is held open; the name is one validated NUL-free component.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err("SOURCE_UNAVAILABLE");
    }
    // SAFETY: successful openat returned a fresh descriptor owned by this File.
    Ok(unsafe { File::from_raw_fd(fd) })
}
#[cfg(target_os = "linux")]
fn descend(_: &Path, root: &[File], parts: &[&str], directory: bool) -> Result<Vec<File>> {
    use std::os::unix::fs::MetadataExt;
    let base = root.last().ok_or("ROOT_REJECTED")?;
    let device = base.metadata().map_err(|_| "SOURCE_UNAVAILABLE")?.dev();
    let mut opened = vec![base.try_clone().map_err(|_| "SOURCE_UNAVAILABLE")?];
    for (index, part) in parts.iter().enumerate() {
        let next = linux_child(
            opened.last().ok_or("SOURCE_UNAVAILABLE")?,
            part,
            directory || index + 1 < parts.len(),
        )?;
        if next.metadata().map_err(|_| "SOURCE_UNAVAILABLE")?.dev() != device {
            return Err("SOURCE_MOUNT_CHANGED");
        }
        opened.push(next);
    }
    Ok(opened)
}
#[cfg(target_os = "linux")]
fn directory_path(_: &Path, _: &[&str], file: &File) -> PathBuf {
    use std::os::fd::AsRawFd;
    PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()))
}
#[cfg(target_os = "linux")]
fn identity(file: &File) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|_| "SOURCE_UNAVAILABLE")?;
    Ok(format!("{}:{}", meta.dev(), meta.ino()))
}
#[cfg(target_os = "linux")]
fn links(file: &File) -> Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata().map_err(|_| "SOURCE_UNAVAILABLE")?.nlink())
}

#[cfg(windows)]
fn windows_open(path: &Path, directory: bool) -> Result<File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ,
    };
    // Keep each ancestor non-deletable and non-writable while traversing/enumerating.
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .security_qos_flags(0)
        .open(path)
        .map_err(|_| "SOURCE_UNAVAILABLE")?;
    let meta = file.metadata().map_err(|_| "SOURCE_UNAVAILABLE")?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || directory != meta.is_dir() {
        return Err("SOURCE_UNAVAILABLE");
    }
    Ok(file)
}
#[cfg(windows)]
fn open_root(path: &Path) -> Result<Vec<File>> {
    use std::path::Prefix;
    let mut prefix = PathBuf::new();
    let mut held = Vec::new();
    for part in path.components() {
        match part {
            Component::Prefix(p) if matches!(p.kind(), Prefix::Disk(_)) => prefix.push(p.as_os_str()),
            Component::RootDir => {
                prefix.push(part.as_os_str());
                held.push(windows_open(&prefix, true)?);
            }
            Component::Normal(name) => {
                let s = name.to_str().ok_or("ROOT_REJECTED")?;
                if !clean_component(s) {
                    return Err("ROOT_REJECTED");
                }
                prefix.push(name);
                held.push(windows_open(&prefix, true)?);
            }
            Component::CurDir => (),
            _ => return Err("ROOT_REJECTED"),
        }
    }
    if held.is_empty() {
        return Err("ROOT_REJECTED");
    }
    Ok(held)
}
#[cfg(windows)]
fn descend(root: &Path, _: &[File], parts: &[&str], directory: bool) -> Result<Vec<File>> {
    let mut path = root.to_path_buf();
    let mut opened = vec![windows_open(root, true)?];
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        opened.push(windows_open(&path, directory || index + 1 < parts.len())?);
    }
    Ok(opened)
}
#[cfg(windows)]
fn directory_path(root: &Path, parts: &[&str], _: &File) -> PathBuf {
    parts.iter().fold(root.to_path_buf(), |p, part| p.join(part))
}
#[cfg(windows)]
fn file_info(file: &File) -> Result<windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: the handle is live and the output buffer has the required layout.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err("SOURCE_UNAVAILABLE");
    }
    // SAFETY: the successful API call initialized the complete output structure.
    Ok(unsafe { info.assume_init() })
}
#[cfg(windows)]
fn identity(file: &File) -> Result<String> {
    let i = file_info(file)?;
    Ok(format!("{}:{}:{}", i.dwVolumeSerialNumber, i.nFileIndexHigh, i.nFileIndexLow))
}
#[cfg(windows)]
fn links(file: &File) -> Result<u64> {
    Ok(u64::from(file_info(file)?.nNumberOfLinks))
}

#[cfg(not(any(target_os = "linux", windows)))]
fn open_root(_: &Path) -> Result<Vec<File>> {
    Err("READ_GATEWAY_UNSUPPORTED_PLATFORM")
}
#[cfg(not(any(target_os = "linux", windows)))]
fn descend(_: &Path, _: &[File], _: &[&str], _: bool) -> Result<Vec<File>> {
    Err("READ_GATEWAY_UNSUPPORTED_PLATFORM")
}
#[cfg(not(any(target_os = "linux", windows)))]
fn directory_path(root: &Path, _: &[&str], _: &File) -> PathBuf {
    root.to_path_buf()
}
#[cfg(not(any(target_os = "linux", windows)))]
fn identity(_: &File) -> Result<String> {
    Err("READ_GATEWAY_UNSUPPORTED_PLATFORM")
}
#[cfg(not(any(target_os = "linux", windows)))]
fn links(_: &File) -> Result<u64> {
    Err("READ_GATEWAY_UNSUPPORTED_PLATFORM")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_paths_do_not_accept_escape_namespace_hidden_or_control() {
        for path in ["../x", "/etc", "x/../y", "x//y", "x/./y", "x\\y", "x:y", ".env", "x/.ssh/a", "x. ", "x\n", "x/\u{202e}y"] {
            assert!(relative(path).is_err(), "{path:?}");
        }
        assert!(relative("notes/회의.md").is_ok());
        assert!(relative(".").unwrap().is_empty());
    }
    #[test]
    fn read_filter_excludes_obvious_secret_names_and_nontext() {
        for name in ["a.exe", "passwords.txt", "credentials.json", "private.pem", "tokens.md"] {
            assert!(!text_name(name));
        }
        assert!(text_name("agenda.md"));
    }
}
