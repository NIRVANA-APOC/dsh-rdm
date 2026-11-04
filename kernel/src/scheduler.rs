use crate::state::merge_ranges;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::Notify;
pub const MIN_STEAL_REMAINING: u64 = 2 * 1024 * 1024;
pub const COALESCE_MAX_BYTES: u64 = 4 * 1024 * 1024;
pub const COALESCE_MIN_BYTES: u64 = 16 * 1024 * 1024;
const STEAL_FRACTION_DIVISOR: u64 = 8;
const MIN_KEPT_BYTES: u64 = 1024;
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
}
pub struct Claim {
    pub id: u64,
    pub start: u64,
    pub end: u64,
    progress: std::sync::Arc<AtomicU64>,
    steal_at: std::sync::Arc<AtomicU64>,
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
        Self { total, state: Mutex::new(SchedState { pending, active: Vec::new(), done, done_bytes, next_id: 1 }), notify: Notify::new() }
    }
    pub fn claim_with(&self, keep_pending: usize, max_span: u64) -> Option<Claim> {
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
        Some(Claim { id, start: segment.start, end: segment.end, progress, steal_at })
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
    pub fn complete(&self, claim: Claim, completed: u64) -> Completion {
        let mut state = self.state.lock().expect("scheduler mutex poisoned");
        let covered = completed.min(claim.len());
        if let Some(index) = state.active.iter().position(|active| active.id == claim.id) {
            state.active.swap_remove(index);
        }
        let prefix_end = claim.start + covered;
        if covered > 0 {
            state.done.push((claim.start, prefix_end));
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
    pub fn has_work(&self) -> bool {
        !self.state.lock().expect("scheduler mutex poisoned").pending.is_empty()
    }
    pub fn completed_ranges(&self) -> Vec<(u64, u64)> {
        let state = self.state.lock().expect("scheduler mutex poisoned");
        merge_ranges(state.done.clone())
    }
    pub async fn wait_for_change(&self, timeout: Duration) {
        let _ = tokio::time::timeout(timeout, self.notify.notified()).await;
    }
}
