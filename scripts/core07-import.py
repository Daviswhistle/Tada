"""Integrate the fixed foreground probe without changing the public wire/DB schema.
One-shot preparation helper; the preparation commit removes this file.
"""
from pathlib import Path

def change(path, old, new):
    p = Path(path)
    s = p.read_text()
    assert s.count(old) == 1, (path, old)
    p.write_text(s.replace(old, new))

p = Path('crates/agentd/src/lib.rs')
s = p.read_text()
assert 'pub mod foreground;' not in s
p.write_text(s + '\npub mod foreground;\npub mod worker_wire;\nmod process_runner;\nmod process_scope;\n')
p = Path('crates/store/src/queue.rs')
s = p.read_text()
assert 'mod process;' not in s
p.write_text(s + '\nmod process;\n')
p = Path('crates/credential/src/lib.rs')
s = p.read_text()
assert 'mod store_directory;' not in s
p.write_text(s + '\nmod store_directory;\npub use store_directory::StoreDirectory;\n')

runner = 'crates/agentd/src/process_runner.rs'
change(runner, 'queue::{WorkKind,WorkLease,WorkState}', 'queue::{WorkKind,WorkState}')
change(runner, 'time::{sleep,timeout,Instant}', 'time::{sleep,timeout}')
change(runner,
    '    let gate = store.lock().map_err(|_|Error::RecoveryRequired)?.admission_gate();',
    '''    let gate = loop {
        let attempt = match store.try_lock() {
            Ok(owner) => Some(owner.admission_gate()),
            Err(std::sync::TryLockError::WouldBlock) => None,
            Err(std::sync::TryLockError::Poisoned(_)) => return Err(Error::RecoveryRequired),
        };
        if let Some(gate) = attempt { break gate; }
        sleep(Duration::from_millis(2)).await;
    };''')
change(runner,
    '    let mut storage_error=None;',
    '''    let monitor = async {
        loop {
            sleep(Duration::from_millis(25)).await;
            let current = lease.clone();
            if let Err(error) = with_store(Arc::clone(&store),Priority::Ordinary,
                move |s|s.check_work_lease(&current)).await { break error; }
        }
    };
    let mut storage_error=None;''')
change(runner, '        let mut poll=tokio::time::interval(Duration::from_millis(25));', '        tokio::pin!(monitor);')
change(runner,
    '''                _=poll.tick()=>{
                    let current=lease.clone();
                    match with_store(Arc::clone(&store),Priority::Ordinary,move |s|s.check_work_lease(&current)).await {
                        Ok(())=>(),
                        Err(Error::Denied(_))=>break Cause::OwnershipLost,
                        Err(error)=>{storage_error=Some(error);break Cause::OwnershipLost;},
                    }
                },''',
    '''                error=&mut monitor=>{
                    if !matches!(error,Error::Denied(_)) { storage_error=Some(error); }
                    break Cause::OwnershipLost;
                },''')
change(runner, 's.retire_stopped_probe(&current,None)?;', 's.retire_stopped_probe(&current,pid,None)?;')
change(runner, 's.retire_stopped_probe(&current,retry)?;', 's.retire_stopped_probe(&current,pid,retry)?;')
change(runner, '    if cancelled {cause=Cause::Cancelled;}',
    '''    if cancelled {cause=Cause::Cancelled;}
    else if cause==Cause::Completed && checkpoint.is_none() {cause=Cause::OwnershipLost;}''')

host = 'crates/agentd/src/foreground.rs'
change(host, 'io::{Read,Write}', 'io::Read')
change(host, 'use tokio::sync::{watch,oneshot};',
    'use tokio::sync::{watch,oneshot};\n#[cfg(feature="process-fixtures")]\nuse std::io::Write;')
change(host,
    'deadline:if mode=="timeout"{Duration::from_millis(500)}else{Duration::from_secs(10)},',
    'deadline:if ["timeout","reply-hang"].contains(&mode){Duration::from_millis(500)}else{Duration::from_secs(30)},')
change('crates/agentd/tests/process_host.rs', 'thread,io::{Read,Write}', 'thread,io::Write')

# Final CI keeps its existing read-only permissions and full regression matrix.
ci = '.github/workflows/ci.yml'
change(ci,
    '      - name: Reject uncommitted generated changes\n',
    '''      - name: Test fixed worker process failures and parent death
        run: cargo test --locked -p tada-agentd --features process-fixtures -- --nocapture
      - name: Run foreground native-control and worker example
        run: cargo run --locked -p tada-agentd --bin tada-agentd -- demo "${{ runner.temp }}/tada-core07-demo"
      - name: Reject uncommitted generated changes
''')
Path(__file__).unlink()
