"""Keep priority waiters out of Tokio's blocking thread pool; add liveness proof."""
from pathlib import Path
p=Path('crates/local-ipc/src/lib.rs');s=p.read_text()
old='''        let ticket = gate.register(prepared.priority())?;
        let owner = Arc::clone(&store);'''
new='''        let ticket = gate.register(prepared.priority())?;
        // Waiting consumes no blocking-pool slot. Otherwise an ordinary
        // waiter can occupy the last thread needed to run a queued cancel.
        let permit = tokio::select! {
            biased;
            _ = stopped.changed() => return Ok(()),
            permit = ticket => permit?,
        };
        let owner = Arc::clone(&store);'''
assert s.count(old)==1;s=s.replace(old,new)
old='            let _permit = ticket.wait()?;';assert s.count(old)==1;s=s.replace(old,'            let _permit = permit;');p.write_text(s)
p=Path('crates/store/src/priority.rs');s=p.read_text();s=s.replace('for (_, waker) in wakers { waker.wake(); }','for waker in wakers.into_values() { waker.wake(); }');p.write_text(s)
p=Path('crates/local-ipc/src/priority_tests.rs');s=p.read_text();s+='''
#[test]
fn one_blocking_thread_does_not_deadlock_queued_native_cancellation() {
    use tada_store::priority::Priority;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    // Bound a regression failure too: runtime drop must not wait forever for
    // the very blocked worker this test is intended to detect.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime.block_on(async {
            timeout(Duration::from_secs(5), async {
                let h = Harness::new(Access::Controller, limits());
                let mut writer = h.client().await;
                let mut reader = h.client().await;
                assert!(call(&mut writer, &submit()).await.get("result").is_some());
                let gate = h.store.lock().unwrap().admission_gate();
                let owner = gate.enter(Priority::Ordinary).unwrap();
                let ordinary = tokio::spawn(async move {
                    call(&mut reader, &json!({"jsonrpc":"2.0","id":"read","method":"task.get","params":{"task_id":"ipc-task"}})).await
                });
                while gate.pending_count(Priority::Ordinary).unwrap() != 1 {
                    sleep(Duration::from_millis(2)).await;
                }
                let cancellation = tokio::spawn(async move { call(&mut writer, &cancel()).await });
                while gate.pending_count(Priority::Cancellation).unwrap() != 1 {
                    sleep(Duration::from_millis(2)).await;
                }
                drop(owner);
                assert!(cancellation.await.unwrap().get("result").is_some());
                assert!(ordinary.await.unwrap().get("result").is_some());
                assert_eq!(serde_json::to_value(h.store.lock().unwrap().task("ipc-task").unwrap()).unwrap()["execution_status"], "CANCELLED");
                h.close().await;
            }).await
        })
    }));
    runtime.shutdown_timeout(Duration::from_secs(1));
    assert!(matches!(outcome, Ok(Ok(()))), "native admission deadlocked or failed with one blocking thread");
}
''';p.write_text(s)
p=Path('docs/queue-supervisor.md');s=p.read_text();old='Abandoned tickets are removed and the wait predicate is checked after every condition-variable wakeup.';new='Abandoned tickets are removed and the predicate is checked after every wakeup. Native connections await executor-neutral ticket futures before spawning a blocking database worker; waiting does not consume a blocking-pool thread. This avoids a priority inversion deadlock when an ordinary waiter would otherwise occupy the only thread needed for a higher-priority cancellation. Synchronous dedicated host threads use the same predicate via Condvar, and registered futures are woken outside the mutex.';assert s.count(old)==1;s=s.replace(old,new)
old='It is an ordering test, not a synthetic sleep-based latency claim.';new='It is an ordering test, not a synthetic sleep-based latency claim. Another native regression sets the entire Tokio blocking pool to one thread, queues a read followed by cancellation behind a held permit, then proves both complete without deadlock. A direct future test covers wakeup and abandoned-priority-ticket cleanup.';assert s.count(old)==1;s=s.replace(old,new)
s=s.replace('Rust [Condvar](https://doc.rust-lang.org/std/sync/struct.Condvar.html).','Rust [Condvar](https://doc.rust-lang.org/std/sync/struct.Condvar.html) and Tokio [spawn_blocking](https://docs.rs/tokio/1.53.1/tokio/task/fn.spawn_blocking.html).');p.write_text(s)
Path(__file__).unlink()
