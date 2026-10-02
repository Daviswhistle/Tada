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
    assert_eq!(h.store.lock().unwrap().task("ipc-task").unwrap().execution_status,tada_contracts::ExecutionStatus::Cancelled);
    assert_eq!(h.close().await.failed,0);
}
