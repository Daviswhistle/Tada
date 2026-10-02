//! Bounded-host admission ordering. No operation is preempted after admission.
//! Native callers await tickets without occupying a blocking executor thread;
//! synchronous host workers may wait on the same predicate via Condvar.
use crate::{Error, Result};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Condvar, Mutex},
    task::{Context, Poll, Waker},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority { Cancellation, Reconciliation, Ordinary }
#[derive(Default)]
struct State {
    next: u64,
    active: bool,
    waiting: BTreeSet<(Priority, u64)>,
    wakers: BTreeMap<(Priority, u64), Waker>,
}
#[derive(Default)]
pub struct AdmissionGate { state: Mutex<State>, changed: Condvar }
pub struct Ticket { gate: Arc<AdmissionGate>, key: Option<(Priority, u64)> }
pub struct Permit { gate: Arc<AdmissionGate> }
impl AdmissionGate {
    /// Count only; no command body, credential or principal is exposed.
    pub fn pending_count(&self, priority: Priority) -> Result<usize> {
        let state = self.state.lock().map_err(|_| Error::RecoveryRequired)?;
        Ok(state.waiting.iter().filter(|(kind, _)| *kind == priority).count())
    }
    pub fn register(self: &Arc<Self>, priority: Priority) -> Result<Ticket> {
        let mut state = self.state.lock().map_err(|_| Error::RecoveryRequired)?;
        if state.waiting.len() >= 1024 { return Err(Error::Denied("ADMISSION_CAPACITY")); }
        let ticket = state.next;
        state.next = state.next.checked_add(1).ok_or(Error::RecoveryRequired)?;
        let key = (priority, ticket);
        state.waiting.insert(key);
        Ok(Ticket { gate: Arc::clone(self), key: Some(key) })
    }
    /// Synchronous host use only. Native async code awaits register()'s ticket.
    pub fn enter(self: &Arc<Self>, priority: Priority) -> Result<Permit> { self.register(priority)?.wait() }
    fn notify_waiters(&self) {
        self.changed.notify_all();
        let wakers = match self.state.lock() {
            Ok(mut state) => std::mem::take(&mut state.wakers),
            Err(_) => return,
        };
        // Wake outside the mutex: executors may poll immediately or reenter.
        for (_, waker) in wakers { waker.wake(); }
    }
}
impl Ticket {
    pub fn wait(mut self) -> Result<Permit> {
        let key = self.key.ok_or(Error::RecoveryRequired)?;
        let mut state = self.gate.state.lock().map_err(|_| Error::RecoveryRequired)?;
        while state.active || state.waiting.first() != Some(&key) {
            state = self.gate.changed.wait(state).map_err(|_| Error::RecoveryRequired)?;
        }
        state.waiting.remove(&key);
        state.wakers.remove(&key);
        state.active = true;
        self.key = None;
        Ok(Permit { gate: Arc::clone(&self.gate) })
    }
}
impl Future for Ticket {
    type Output = Result<Permit>;
    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let Some(key) = self.key else { return Poll::Ready(Err(Error::RecoveryRequired)); };
        let gate = Arc::clone(&self.gate);
        let mut state = match gate.state.lock() {
            Ok(state) => state,
            Err(_) => return Poll::Ready(Err(Error::RecoveryRequired)),
        };
        if state.active || state.waiting.first() != Some(&key) {
            state.wakers.insert(key, context.waker().clone());
            return Poll::Pending;
        }
        state.waiting.remove(&key);
        state.wakers.remove(&key);
        state.active = true;
        self.key = None;
        Poll::Ready(Ok(Permit { gate: Arc::clone(&gate) }))
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            if let Ok(mut state) = self.gate.state.lock() {
                state.waiting.remove(&key);
                state.wakers.remove(&key);
            }
            self.gate.notify_waiters();
        }
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.state.lock() { state.active = false; }
        self.gate.notify_waiters();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_precedes_queued_observation_and_ordinary_work_without_preempting_owner() {
        let gate = Arc::new(AdmissionGate::default());
        let owner = gate.enter(Priority::Ordinary).unwrap();
        let normal = gate.register(Priority::Ordinary).unwrap();
        let observe = gate.register(Priority::Reconciliation).unwrap();
        let cancel = gate.register(Priority::Cancellation).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let handles = [(normal, 2), (observe, 1), (cancel, 0)].into_iter().map(|(ticket, n)| {
            let tx = tx.clone();
            std::thread::spawn(move || { let _permit = ticket.wait().unwrap(); tx.send(n).unwrap(); })
        }).collect::<Vec<_>>();
        assert!(rx.try_recv().is_err());
        drop(owner);
        for n in 0..3 { assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(), n); }
        for handle in handles { handle.join().unwrap(); }
    }
    #[test]
    fn same_class_fifo_and_dropped_ticket_do_not_leave_a_permanent_waiter() {
        let gate = Arc::new(AdmissionGate::default());
        let owner = gate.enter(Priority::Ordinary).unwrap();
        let first = gate.register(Priority::Ordinary).unwrap();
        let lost = gate.register(Priority::Cancellation).unwrap();
        let second = gate.register(Priority::Ordinary).unwrap();
        drop(lost); drop(owner);
        let p = first.wait().unwrap(); drop(p); drop(second.wait().unwrap());
        assert!(gate.state.lock().unwrap().waiting.is_empty());
    }
    #[test]
    fn saturated_gate_is_bounded_and_recovers_after_ticket_drop() {
        let gate = Arc::new(AdmissionGate::default());
        let tickets = (0..1024).map(|_| gate.register(Priority::Ordinary).unwrap()).collect::<Vec<_>>();
        assert!(matches!(gate.register(Priority::Ordinary), Err(Error::Denied("ADMISSION_CAPACITY"))));
        drop(tickets); assert!(gate.enter(Priority::Cancellation).is_ok());
    }
    struct WakeCount(std::sync::atomic::AtomicUsize);
    impl std::task::Wake for WakeCount {
        fn wake(self: Arc<Self>) { self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
    }
    #[test]
    fn async_ticket_wakes_after_release_and_dropping_priority_waiter_unblocks_next() {
        let gate = Arc::new(AdmissionGate::default());
        let owner = gate.enter(Priority::Ordinary).unwrap();
        let mut normal = Box::pin(gate.register(Priority::Ordinary).unwrap());
        let mut cancel = Box::pin(gate.register(Priority::Cancellation).unwrap());
        let count = Arc::new(WakeCount(std::sync::atomic::AtomicUsize::new(0)));
        let waker = Waker::from(Arc::clone(&count));
        let mut cx = Context::from_waker(&waker);
        assert!(normal.as_mut().poll(&mut cx).is_pending());
        assert!(cancel.as_mut().poll(&mut cx).is_pending());
        drop(owner);
        assert_eq!(count.0.load(std::sync::atomic::Ordering::Relaxed), 2);
        assert!(normal.as_mut().poll(&mut cx).is_pending());
        drop(cancel);
        assert_eq!(count.0.load(std::sync::atomic::Ordering::Relaxed), 3);
        let Poll::Ready(Ok(permit)) = normal.as_mut().poll(&mut cx) else { panic!("next waiter not released"); };
        assert!(gate.state.lock().unwrap().wakers.is_empty());
        drop(permit);
        assert!(gate.enter(Priority::Cancellation).is_ok());
    }
}
