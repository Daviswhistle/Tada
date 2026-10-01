-- CORE-02 mock-only durable store. Schema identity is checked on every open.
CREATE TABLE metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    store_id TEXT NOT NULL,
    schema_hash TEXT NOT NULL,
    witness_seq INTEGER NOT NULL CHECK(witness_seq >= 0),
    generation INTEGER NOT NULL CHECK(generation >= 0),
    policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
    denied INTEGER NOT NULL CHECK(denied IN (0,1))
) STRICT;
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    contract TEXT NOT NULL CHECK(json_valid(contract)),
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
    version INTEGER GENERATED ALWAYS AS (json_extract(snapshot,'$.version')) STORED NOT NULL CHECK(version > 0),
    cancel_epoch INTEGER GENERATED ALWAYS AS (json_extract(snapshot,'$.cancel_epoch')) STORED NOT NULL CHECK(cancel_epoch >= 0),
    execution TEXT GENERATED ALWAYS AS (json_extract(snapshot,'$.execution_status')) STORED NOT NULL
        CHECK(execution IN ('RECEIVED','READY','RUNNING','WAITING','VERIFYING','PUBLISHING','CANCELLING','CANCELLED','STOPPED')),
    fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
    budget_micro_usd INTEGER NOT NULL CHECK(budget_micro_usd BETWEEN 0 AND 9007199254740991),
    CHECK(id = json_extract(contract,'$.task_id')),
    CHECK(id = json_extract(snapshot,'$.task_id'))
) STRICT;
CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    generation INTEGER NOT NULL CHECK(generation > 0),
    fence INTEGER NOT NULL CHECK(fence > 0),
    expires_tick INTEGER NOT NULL CHECK(expires_tick > 0),
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    UNIQUE(task_id,fence)
) STRICT;
CREATE UNIQUE INDEX one_active_run ON runs(task_id) WHERE active = 1;
CREATE TABLE payloads (
    hash TEXT PRIMARY KEY CHECK(length(hash) = 64),
    content BLOB NOT NULL
) STRICT;
CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    payload_hash TEXT NOT NULL REFERENCES payloads(hash),
    record TEXT NOT NULL CHECK(json_valid(record)),
    version INTEGER GENERATED ALWAYS AS (json_extract(record,'$.version')) STORED NOT NULL CHECK(version > 0),
    state TEXT GENERATED ALWAYS AS (json_extract(record,'$.state')) STORED NOT NULL
        CHECK(state IN ('PROPOSED','AUTHORIZED','PREPARED','DISPATCHING','ACKNOWLEDGED','VERIFIED','REJECTED','FAILED','UNCERTAIN','COMPENSATED')),
    CHECK(id = json_extract(record,'$.action_id')),
    CHECK(task_id = json_extract(record,'$.task_id'))
) STRICT;
CREATE INDEX reconcile_actions ON actions(task_id,state);
CREATE TABLE grants (
    action_id TEXT PRIMARY KEY REFERENCES actions(id),
    run_id INTEGER NOT NULL REFERENCES runs(id),
    policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
    cancel_epoch INTEGER NOT NULL CHECK(cancel_epoch >= 0),
    fence INTEGER NOT NULL CHECK(fence > 0),
    revoked INTEGER NOT NULL CHECK(revoked IN (0,1))
) STRICT;
CREATE TABLE attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
    generation INTEGER NOT NULL,
    fence INTEGER NOT NULL,
    payload_hash TEXT NOT NULL REFERENCES payloads(hash)
) STRICT;
CREATE TABLE reservations (
    action_id TEXT PRIMARY KEY REFERENCES actions(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    reserved INTEGER NOT NULL CHECK(reserved BETWEEN 0 AND 9007199254740991),
    charged INTEGER CHECK(charged BETWEEN 0 AND reserved),
    status TEXT NOT NULL CHECK(status IN ('reserved','uncertain','settled')),
    CHECK((status = 'settled' AND charged IS NOT NULL) OR (status != 'settled' AND charged IS NULL))
) STRICT;
CREATE TABLE receipts (
    action_id TEXT PRIMARY KEY REFERENCES actions(id),
    receipt TEXT NOT NULL CHECK(json_valid(receipt))
) STRICT;
CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;
CREATE TABLE outbox (
    key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    task_version INTEGER NOT NULL CHECK(task_version > 0),
    kind TEXT NOT NULL CHECK(kind IN ('decision_required','stopped')),
    delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),
    UNIQUE(task_id,task_version,kind)
) STRICT;
CREATE TRIGGER immutable_payload_update BEFORE UPDATE ON payloads BEGIN SELECT RAISE(ABORT,'immutable payload'); END;
CREATE TRIGGER immutable_payload_delete BEFORE DELETE ON payloads BEGIN SELECT RAISE(ABORT,'immutable payload'); END;
CREATE TRIGGER immutable_attempt_update BEFORE UPDATE ON attempts BEGIN SELECT RAISE(ABORT,'immutable attempt'); END;
CREATE TRIGGER immutable_attempt_delete BEFORE DELETE ON attempts BEGIN SELECT RAISE(ABORT,'immutable attempt'); END;
CREATE TRIGGER immutable_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
CREATE TRIGGER immutable_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
CREATE TRIGGER immutable_receipt_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
CREATE TRIGGER immutable_receipt_delete BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
PRAGMA user_version = 1;
