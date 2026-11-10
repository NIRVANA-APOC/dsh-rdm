use crate::state::merge_ranges;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
pub const MIN_STEAL_REMAINING: u64 = 2 * 1024 * 1024;
pub const COALESCE_MAX_BYTES: u64 = 4 * 1024 * 1024;
pub const COALESCE_MIN_BYTES: u64 = 16 * 1024 * 1024;
const STEAL_FRACTION_DIVISOR: u64 = 8;
const MIN_KEPT_BYTES: u64 = 1024;

/// Insert `[start, end)` into the sorted, merged range list in O(log n + moves)
/// instead of re-sorting every saved snapshot. Chunks usually complete near the
/// end of the list, so the common case is an append.
fn insert_done(done: &mut Vec<(u64, u64)>, start: u64, end: u64) {
    if start >= end {
        return;
    }
    let mut index = done.partition_point(|(range_start, _)| *range_start < start);
    if index > 0 && done[index - 1].1 >= start {
        index -= 1;
        if done[index].1 >= end {
            return;
        }
        done[index].1 = end;
    } else {
        done.insert(index, (start, end));
    }
    while index + 1 < done.len() && done[index].1 >= done[index + 1].0 {
        let next_end = done[index + 1].1;
        if next_end > done[index].1 {
            done[index].1 = next_end;
        }
        done.remove(index + 1);
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Segment {
    start: u64,
    end: u64,
}
struct Active {
    id: u64,
    start: u64,
    end: u64,
    progress: std::sync::Arc<AtomicU64>,
    steal_at: std::sync::Arc<AtomicU64>,
}
struct SchedState {
    pending: VecDeque<Segment>,
    active: Vec<Active>,
    done: Vec<(u64, u64)>,
    done_bytes: u64,
    next_id: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completion {
    Finished,
    Split { completed: u64 },
}
pub struct Scheduler {
    total: u64,
    state: Mutex<SchedState>,
    notify: Notify,
    /// Claims whose worker task dropped them without completing (0.3.4 hardening).
    abandoned: AtomicU64,
}
pub struct Claim {
    pub id: u64,
    pub start: u64,
    pub end: u64,
    progress: std::sync::Arc<AtomicU64>,
    steal_at: std::sync::Arc<AtomicU64>,
    /// Scheduler that issued this claim. A claim dropped without completing
    /// hands its unfinished bytes back to it (see `Drop` below).
    scheduler: Arc<Scheduler>,
    /// Cleared by `complete`. A claim still armed when dropped belongs to a
    /// worker task that ended unexpectedly (panic/cancel): `Drop` re-queues its
    /// unfinished prefix instead of leaving it stranded in `active` forever.
    armed: bool,
}
impl Claim {
    pub fn len(&self) -> u64 {
        self.end.saturating_sub(self.start)
    }
    pub fn is_empty(&self) -> bool {
        self.start >= self.end
    }
    pub fn update_progress(&self, covered: u64) {
        self.progress.store(covered.min(self.len()), Ordering::Release);
    }
    pub fn steal_target(&self) -> Option<u64> {
        let value = self.steal_at.load(Ordering::Acquire);
        (value != 0).then_some(value)
    }
}
impl Drop for Claim {
    /// Safety net for a worker task that stops running while holding a claim
    /// (panic, cancellation, or any future early return). Without this the
    /// claim stays in `Scheduler::active` with no worker driving it, so the
    /// engine spins forever at "running" with zero connections (the 20261110
    /// incident t_c88d0535089afb3c stalled at 98 %; its actual root cause was
    /// the silent 200/downgrade path, but this guard also converges every other
    /// way a worker can lose a claim). The whole range is re-queued because the
    /// task's buffered writes cannot be trusted to have reached the file.
    fn drop(&mut self) {
        if self.armed {
            self.armed = false;
            self.scheduler.abandon(self.id, self.progress.load(Ordering::Acquire));
        }
    }
}
impl Scheduler {
    pub fn new(total: u64, done: Vec<(u64, u64)>, missing: Vec<(u64, u64)>, chunk_size: u64) -> Self {
        let chunk_size = chunk_size.max(1);
        let done = merge_ranges(done);
        let done_bytes: u64 = done.iter().map(|(start, end)| end - start).sum();
        let mut pending = VecDeque::new();
        for (start, end) in missing {
            let mut cursor = start;
            while cursor < end {
                let next = (cursor + chunk_size).min(end);
                pending.push_back(Segment { start: cursor, end: next });
                cursor = next;
            }
        }
        Self { total, state: Mutex::new(SchedState { pending, active: Vec::new(), done, done_bytes, next_id: 1 }), notify: Notify::new(), abandoned: AtomicU64::new(0) }
    }
    pub fn claim_with(self: &Arc<Self>, keep_pending: usize, max_span: u64) -> Option<Claim> {
        let mut state = self.state.lock().expect("scheduler mutex poisoned");
        let mut segment = state.pending.pop_front()?;
        while max_span > 0 && state.pending.len() > keep_pending {
            let Some(next) = state.pending.front() else {
                break;
            };
            let span = segment.end - segment.start;
            let next_len = next.end - next.start;
            if next.start != segment.end || span.saturating_add(next_len) > max_span {
                break;
            }
            segment.end = next.end;
            state.pending.pop_front();
        }
        let id = state.next_id;
        state.next_id += 1;
        let progress = std::sync::Arc::new(AtomicU64::new(0));
        let steal_at = std::sync::Arc::new(AtomicU64::new(0));
        state.active.push(Active { id, start: segment.start, end: segment.end, progress: std::sync::Arc::clone(&progress), steal_at: std::sync::Arc::clone(&steal_at) });
        Some(Claim { id, start: segment.start, end: segment.end, progress, steal_at, scheduler: Arc::clone(self), armed: true })
    }
    pub fn try_request_steal(&self) -> bool {
        let state = self.state.lock().expect("scheduler mutex poisoned");
        let mut best: Option<(usize, u64)> = None;
        for (index, active) in state.active.iter().enumerate() {
            let progress = active.progress.load(Ordering::Acquire);
            let remaining = active.end.saturating_sub(active.start).saturating_sub(progress);
            if remaining < MIN_STEAL_REMAINING {
                continue;
            }
            match best {
                Some((_, best_remaining)) if remaining <= best_remaining => {}
                _ => best = Some((index, remaining)),
            }
        }
        let Some((index, remaining)) = best else {
            return false;
        };
        let active = &state.active[index];
        let progress = active.progress.load(Ordering::Acquire);
        let kept = (remaining / STEAL_FRACTION_DIVISOR).max(MIN_KEPT_BYTES);
        let split = active.start + progress + kept;
        if split <= active.start || split >= active.end {
            return false;
        }
        active.steal_at.compare_exchange(0, split, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }
    pub fn complete(&self, mut claim: Claim, completed: u64) -> Completion {
        // Disarm first: the claim is being settled here, so its `Drop` must not
        // re-queue it a second time.
        claim.armed = false;
        let mut state = self.state.lock().expect("scheduler mutex poisoned");
        let covered = completed.min(claim.len());
        if let Some(index) = state.active.iter().position(|active| active.id == claim.id) {
            state.active.swap_remove(index);
        }
        let prefix_end = claim.start + covered;
        if covered > 0 {
            insert_done(&mut state.done, claim.start, prefix_end);
            state.done_bytes += covered;
        }
        let completion = if prefix_end < claim.end {
            state.pending.push_front(Segment { start: prefix_end, end: claim.end });
            Completion::Split { completed: covered }
        } else {
            Completion::Finished
        };
        drop(state);
        self.notify.notify_waiters();
        completion
    }
    /// Re-queue a claim that its worker dropped without completing (`Claim::drop`).
    ///
    /// The whole claim range is queued again: `update_progress` advances after a
    /// write has been handed to `tokio::fs::File`, whose internal buffer is *not*
    /// flushed when the worker task is dropped or unwound mid-write, so marking
    /// that prefix as done could leave a hole only the checksum would catch.
    /// Re-downloading at most one claim is cheap and always correct; the byte
    /// counter may stay up to one claim high until the engine reports `total`
    /// at the end (the view clamps percent at 100 %).
    fn abandon(&self, id: u64, _completed: u64) -> bool {
        // A drop can run while unwinding from a panic that poisoned the mutex.
        // `PoisonError::into_inner` keeps the safety net working there (there is
        // no re-entrancy: no scheduler method drops a claim while holding the
        // lock, and `complete` disarms its claim before locking) instead of
        // letting an ordinary `try_lock` contention loss reinstate the stall.
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(index) = state.active.iter().position(|active| active.id == id) else { return false };
        let active = state.active.swap_remove(index);
        state.pending.push_front(Segment { start: active.start, end: active.end });
        drop(state);
        self.abandoned.fetch_add(1, Ordering::Relaxed);
        self.notify.notify_waiters();
        true
    }
    pub fn is_finished(&self) -> bool {
        let state = self.state.lock().expect("scheduler mutex poisoned");
        state.done_bytes >= self.total && state.active.is_empty() && state.pending.is_empty()
    }
    pub fn done_bytes(&self) -> u64 {
        self.state.lock().expect("scheduler mutex poisoned").done_bytes
    }
    pub fn remaining_units(&self) -> usize {
        let state = self.state.lock().expect("scheduler mutex poisoned");
        (state.pending.len() + state.active.len()).max(1)
    }
    /// Number of claims reclaimed from worker tasks that ended without
    /// completing them. Non-zero means a worker task died mid-transfer; the
    /// download survives (the range was re-queued) but the event is worth
    /// surfacing in the task timeline.
    pub fn abandoned(&self) -> u64 {
        self.abandoned.load(Ordering::Relaxed)
    }
    pub fn has_work(&self) -> bool {
        !self.state.lock().expect("scheduler mutex poisoned").pending.is_empty()
    }
    pub fn completed_ranges(&self) -> Vec<(u64, u64)> {
        let state = self.state.lock().expect("scheduler mutex poisoned");
        state.done.clone()
    }
    pub async fn wait_for_change(&self, timeout: Duration) {
        let _ = tokio::time::timeout(timeout, self.notify.notified()).await;
    }
}
