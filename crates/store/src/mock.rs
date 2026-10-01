//! Independent persistent, deliberately non-idempotent mock target.
//! This module never opens sockets or calls a real external account.
use crate::{configure, Dispatch, Error, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MockPayload {
    pub target: String,
    pub value: String,
}
impl MockPayload {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.target.is_empty() || self.target.len() > 128 || self.value.len() > 16_384 {
            return Err(Error::Invalid("MOCK_PAYLOAD_LIMIT"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
pub enum MockMode {
    Normal,
    DropResponse,
    AppliedMismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Receipt {
    pub sequence: i64,
    pub action_id: String,
    pub request_hash: String,
    pub actual: MockPayload,
    pub charged: i64,
}
impl Receipt {
    pub fn reference(&self) -> String {
        format!("mock-receipt:{}", self.sequence)
    }
}

pub struct MockService {
    conn: Connection,
    hidden: bool,
}
impl MockService {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        configure(&conn)?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS effects(sequence INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, request_hash TEXT NOT NULL, actual TEXT NOT NULL CHECK(json_valid(actual)), charged INTEGER NOT NULL CHECK(charged>=0)) STRICT;
CREATE TRIGGER IF NOT EXISTS immutable_effect_update BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT,'immutable effect'); END;
CREATE TRIGGER IF NOT EXISTS immutable_effect_delete BEFORE DELETE ON effects BEGIN SELECT RAISE(ABORT,'immutable effect'); END;")?;
        Ok(Self {
            conn,
            hidden: false,
        })
    }
    pub fn effect_count(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT count(*) FROM effects", [], |r| r.get(0))?)
    }
    /// Model eventual consistency/unavailable observation without deleting effects.
    pub fn hide_observations(&mut self, hidden: bool) {
        self.hidden = hidden;
    }
    pub(crate) fn apply(&mut self, request: &Dispatch, mode: MockMode) -> Result<Option<Receipt>> {
        let mut actual = request.payload.clone();
        if matches!(mode, MockMode::AppliedMismatch) {
            actual.value.push_str(" [wrong-result]");
        }
        // No UNIQUE(action_id), no idempotency cache: an accidental second send
        // must be visible as a second row to the fault tests.
        self.conn.execute(
            "INSERT INTO effects(action_id,request_hash,actual,charged) VALUES(?1,?2,?3,?4)",
            params![
                request.action_id,
                request.hash,
                serde_json::to_string(&actual)?,
                request.reserved
            ],
        )?;
        let sequence = self.conn.last_insert_rowid();
        if matches!(mode, MockMode::DropResponse) {
            return Ok(None);
        }
        Ok(Some(Receipt {
            sequence,
            action_id: request.action_id.clone(),
            request_hash: request.hash.clone(),
            actual,
            charged: request.reserved,
        }))
    }
    pub(crate) fn observe(&self, id: &str) -> Result<Option<Receipt>> {
        if self.hidden {
            return Ok(None);
        }
        let count: i64 = self.conn.query_row(
            "SELECT count(*) FROM effects WHERE action_id=?1",
            [id],
            |r| r.get(0),
        )?;
        // Neither zero hits nor more than one hit is a proof of exact application.
        if count != 1 {
            return Ok(None);
        }
        let (sequence, request_hash, raw, charged): (i64, String, String, i64) =
            self.conn.query_row(
                "SELECT sequence,request_hash,actual,charged FROM effects WHERE action_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?;
        Ok(Some(Receipt {
            sequence,
            action_id: id.to_owned(),
            request_hash,
            actual: serde_json::from_str(&raw)?,
            charged,
        }))
    }
}
