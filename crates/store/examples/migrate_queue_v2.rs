//! Explicit local schema migration, not a daemon or automatic recovery command.
use std::path::PathBuf;
use tada_store::Store;
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(args.next().ok_or("Usage: migrate_queue_v2 EXISTING_STORE NEW_BACKUP_FILE")?);
    let backup = PathBuf::from(args.next().ok_or("Usage: migrate_queue_v2 EXISTING_STORE NEW_BACKUP_FILE")?);
    if args.next().is_some() { return Err("Usage: migrate_queue_v2 EXISTING_STORE NEW_BACKUP_FILE".into()); }
    Store::migrate_queue_v2(&root, &backup)?;
    println!("queue schema v2 committed; v1 backup created; independent witness retained; no work executed");
    Ok(())
}
fn main() { if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); } }
