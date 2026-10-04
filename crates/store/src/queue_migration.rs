//! Explicit, backed-up v1 -> v2 queue migration. No automatic downgrade.
use crate::{digest, event, Error, Result, Store, SCHEMA};
use rusqlite::{params, Connection};
use serde_json::json;
use std::path::Path;

pub(crate) fn version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}
pub(crate) fn schema_hash(version: i64) -> Result<String> {
    match version {
        1 => Ok(digest(SCHEMA.as_bytes())),
        2 => Ok(digest(
            format!("{SCHEMA}\n{}", crate::queue::SCHEMA).as_bytes(),
        )),
        3 => Ok(digest(
            format!(
                "{SCHEMA}\n{}\n{}",
                crate::queue::SCHEMA,
                crate::model_migration::FORMAT
            )
            .as_bytes(),
        )),
        _ => Err(Error::RecoveryRequired),
    }
}
impl Store {
    /// Caller must stop the old daemon and supply a NEW backup destination.
    /// An independent witness is retained; restoring both together is not safe.
    /// Existing external effects must be reconciled using the compatible v1
    /// binary before migration. This operation does not run any queued work.
    pub fn migrate_queue_v2(root: &Path, backup: &Path) -> Result<()> {
        if !root.join("state.sqlite").is_file() {
            return Err(Error::Denied("MIGRATION_SOURCE_MISSING"));
        }
        let mut store = Self::open_unrecovered(root, true)?;
        if version(&store.conn)? != 1 {
            return Err(Error::Denied("MIGRATION_NOT_NEEDED"));
        }
        let unfinished:bool=store.conn.query_row("SELECT EXISTS(SELECT 1 FROM actions WHERE state IN ('DISPATCHING','ACKNOWLEDGED','UNCERTAIN')) OR EXISTS(SELECT 1 FROM tasks WHERE execution IN ('VERIFYING','PUBLISHING'))",[],|r|r.get(0))?;
        if unfinished {
            return Err(Error::Denied("MIGRATION_RECONCILIATION_REQUIRED"));
        }
        store.backup_state(backup)?;
        crate::checkpoint("queue_migrate.backup");
        let checksum = schema_hash(2)?;
        store.transact("queue_migrate", |tx| {
            tx.execute_batch(crate::queue::SCHEMA)?;
            crate::queue::recover(tx)?;
            tx.execute(
                "UPDATE metadata SET schema_hash=?1 WHERE singleton=1",
                params![checksum],
            )?;
            event(
                tx,
                "schema",
                "schema.queue_v2",
                &json!({"from":1,"to":2,"checksum":checksum,"backup_required":true}),
            )?;
            Ok(())
        })?;
        store.audit()?;
        Ok(())
    }
}
