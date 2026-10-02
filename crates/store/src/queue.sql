-- Additive v1 -> v2 migration; the original v1 schema remains byte-identical.
CREATE TABLE work_queue (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    record TEXT NOT NULL CHECK(json_valid(record)),
    version INTEGER GENERATED ALWAYS AS (json_extract(record,'$.version')) STORED NOT NULL CHECK(version > 0),
    state TEXT GENERATED ALWAYS AS (json_extract(record,'$.state')) STORED NOT NULL CHECK(state IN ('ready','leased','parked','finished','cancelled')),
    kind TEXT GENERATED ALWAYS AS (json_extract(record,'$.kind')) STORED NOT NULL CHECK(kind IN ('advance','reconcile')),
    priority INTEGER GENERATED ALWAYS AS (json_extract(record,'$.priority')) STORED NOT NULL CHECK(priority IN (0,10,20)),
    run_after INTEGER GENERATED ALWAYS AS (json_extract(record,'$.run_after_ms')) STORED NOT NULL CHECK(run_after BETWEEN 0 AND 9007199254740991),
    ordinal INTEGER GENERATED ALWAYS AS (json_extract(record,'$.ordinal')) STORED NOT NULL CHECK(ordinal > 0),
    CHECK(task_id = json_extract(record,'$.task_id'))
) STRICT;
CREATE INDEX queue_ready ON work_queue(state,priority,run_after,ordinal,task_id);
CREATE TABLE work_checkpoints (
    hash TEXT PRIMARY KEY CHECK(length(hash)=64),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    record TEXT NOT NULL CHECK(json_valid(record))
) STRICT;
CREATE TRIGGER retain_queue BEFORE DELETE ON work_queue BEGIN SELECT RAISE(ABORT,'retain queue history'); END;
CREATE TRIGGER immutable_checkpoint_update BEFORE UPDATE ON work_checkpoints BEGIN SELECT RAISE(ABORT,'immutable checkpoint'); END;
CREATE TRIGGER immutable_checkpoint_delete BEFORE DELETE ON work_checkpoints BEGIN SELECT RAISE(ABORT,'immutable checkpoint'); END;
PRAGMA user_version=2;
