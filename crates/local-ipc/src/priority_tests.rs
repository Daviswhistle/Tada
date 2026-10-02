// Included inside the existing supported-platform native test module.
#[tokio::test]
async fn authenticated_native_cancel_overtakes_queued_probe_completion() {
    use tada_store::priority::Priority;
    let h=Harness::new(Access::Controller,limits());
    let mut client=h.client().await;
    assert!(call(&mut client,&submit()).await.get("result").is_some());
    let lease=h.store.lock().unwrap().claim_work("probe-worker",0,Duration::from_secs(60)).unwrap().unwrap();
    let gate=h.store.lock().unwrap().admission_gate();
    let owner=gate.enter(Priority::Ordinary).unwrap();
    let ordinary=gate.register(Priority::Ordinary).unwrap();
    let store=Arc::clone(&h.store);
    let worker=tokio::task::spawn_blocking(move || {
        let _permit=ordinary.wait().unwrap();
        store.lock().unwrap().finish_probe(&lease,lease.contract_hash())
    });
    let cancel_job=tokio::spawn(async move { call(&mut client,&cancel()).await });
    timeout(Duration::from_secs(2),async {
        loop {
            if gate.pending_count(Priority::Cancellation).unwrap()==1 { break; }
            sleep(Duration::from_millis(2)).await;
        }
    }).await.unwrap();
    drop(owner);
    assert!(cancel_job.await.unwrap().get("result").is_some());
    assert!(matches!(worker.await.unwrap(),Err(tada_store::Error::Denied("STALE_QUEUE_LEASE"))));
    assert_eq!(serde_json::to_value(h.store.lock().unwrap().task("ipc-task").unwrap()).unwrap()["execution_status"], "CANCELLED");
    h.close().await;
}

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
