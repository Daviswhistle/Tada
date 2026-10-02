"""Exact lint correction, preserving the lease predicate, then remove helper."""
from pathlib import Path
p=Path('crates/store/src/queue.rs');s=p.read_text()
old='''        && entry.cancel_epoch == epoch
    {
        if kind == WorkKind::Reconcile || value["execution_status"] == "RUNNING" {
            state = WorkState::Leased;
        }
    }'''
new='''        && entry.cancel_epoch == epoch
        && (kind == WorkKind::Reconcile || value["execution_status"] == "RUNNING")
    {
        state = WorkState::Leased;
    }'''
assert s.count(old)==1;s=s.replace(old,new);p.write_text(s)
Path(__file__).unlink()
