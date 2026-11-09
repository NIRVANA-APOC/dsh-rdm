//! Adaptive worker-count controller (0.2.2 policy).
//!
//! Policy was re-derived from the 20261109 real session:
//!
//! * **Grow on aggregate headroom.** A growth probe from 64 → 72 workers kept
//!   aggregate throughput at 112–114 MiB/s while per-connection rate diluted
//!   from 1.8 to 1.6 MiB/s. Judging probes by per-connection rate reverted five
//!   times in one minute (64↔72 jitter). 0.2.2 keeps a probe while the
//!   **aggregate** rate holds ≥95 % of the pre-probe rate.
//! * **Revert with a real cooldown.** An aggregate drop reverts, and growth
//!   stays off for 30 ticks so the same probe cannot immediately repeat.
//! * **Saturation backoff.** If two consecutive kept probes raise aggregate by
//!   less than 2 %, the transfer is at its ceiling: freeze growth until the rate
//!   falls below 90 % of the frozen peak (or 120 ticks pass). This stops
//!   64→72→102 growth while throughput is flat.
//! * **Tail freeze.** When the remaining claim units are ≤ the target workers,
//!   every worker already has work: hold the target (no grow/shrink/collapse)
//!   instead of misreading the decreasing worker count as "average rate
//!   falling".
//! * **Collapse recovery** (from 0.2.1) still rebuilds the HTTP pool and probes
//!   extra workers when throughput steps down with the pool pinned.
//! * **Pushback** (429/503) halves the target.

/// Minimum run time before collapse detection is armed.
pub const WARMUP_TICKS: u64 = 8;
/// A collapse needs the instant rate below this fraction of the peak.
pub const COLLAPSE_RATIO: f64 = 0.5;
/// ...and the slow (EWMA) rate below this fraction of the peak (a one-sample
/// blip is not a sustained collapse).
pub const COLLAPSE_SLOW_RATIO: f64 = 0.75;
/// Collapse detection needs a run peak at least this fast (4 MiB/s) so a small
/// or very slow transfer never triggers pool churn.
pub const COLLAPSE_MIN_PEAK_BPS: f64 = 4.0 * 1024.0 * 1024.0;
/// How many ticks the rebuild probe is judged over.
pub const COLLAPSE_PROBE_TICKS: u32 = 10;
/// After a collapse probe, wait this many ticks before probing again.
pub const COLLAPSE_COOLDOWN_TICKS: u32 = 30;
/// Maximum pool rebuilds per transfer.
pub const MAX_REBUILDS: u32 = 3;
/// A growth probe is kept while aggregate throughput holds this fraction of the
/// pre-probe rate; otherwise it is reverted.
pub const GROWTH_KEEP_RATE_RATIO: f64 = 0.95;
/// After a revert, growth is disabled for this many ticks (≈30 s).
pub const REVERT_COOLDOWN_TICKS: u32 = 30;
/// Minimum ticks between growth probes when they keep working.
pub const GROWTH_STEP_COOLDOWN_TICKS: u32 = 3;
/// Two consecutive kept probes with aggregate gain below this fraction mark the
/// transfer as saturated.
pub const SATURATION_MIN_GAIN: f64 = 0.02;
/// Consecutive low-gain kept probes before growth freezes.
pub const SATURATION_HITS: u32 = 2;
/// A saturation freeze ends after this many ticks even if the rate stays flat.
pub const SATURATION_FREEZE_TICKS: u32 = 120;
/// ...or earlier when the rate falls below this fraction of the frozen peak.
pub const SATURATION_UNFREEZE_RATIO: f64 = 0.90;
/// Slow-rate EWMA time constant: long enough to ignore a single blip, short
/// enough that a real step-down is recognised within a few seconds.
pub const SLOW_TAU_SECS: f64 = 6.0;
/// Pushback backoff cooldown.
pub const PUSHBACK_COOLDOWN_TICKS: u32 = 10;

/// One second of observations fed to the controller.
#[derive(Debug, Clone, Copy)]
pub struct ControllerTick {
    /// Bytes transferred during the tick (net of any resumed baseline).
    pub delta_bytes: u64,
    /// Wall time of the tick in seconds (≈1.0, but measured, not assumed).
    pub elapsed_secs: f64,
    /// Sampled number of workers inside a network slot.
    pub active_avg: f64,
    /// The server asked us to back off (429/503 `Retry-After` seen this tick).
    pub pushback: bool,
    /// Highest target the engine can run right now
    /// (`max_workers.min(remaining claim units)`).
    pub cap: usize,
    /// Claim units still pending or active. `remaining_units <= target` means
    /// every remaining chunk already has a worker: tail.
    pub remaining_units: usize,
}

impl ControllerTick {
    pub fn instant_bps(&self) -> f64 {
        if self.elapsed_secs > 0.0 {
            self.delta_bytes as f64 / self.elapsed_secs
        } else {
            0.0
        }
    }
}

/// What the engine should do after a tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControllerEffect {
    /// Set the worker target and emit a `controller` event with this message.
    SetTarget { target: usize, message: String },
    /// Rebuild the HTTP connection pool (fresh TCP/TLS connections).
    RebuildPool { message: String },
    /// Emit an informational `controller` event without changing the target.
    Note { message: String },
}

#[derive(Debug, Clone, Copy)]
struct GrowthProbe {
    previous_target: usize,
    instant_before: f64,
}

/// Mutable controller state for one transfer.
pub struct Controller {
    target: usize,
    max_workers: usize,
    ticks: u64,
    instant_bps: f64,
    slow_bps: f64,
    peak_bps: f64,
    last_instant_bps: f64,
    last_per_conn_bps: f64,
    growth_cooldown: u32,
    growth_probe: Option<GrowthProbe>,
    saturation_hits: u32,
    growth_frozen: bool,
    frozen_peak_bps: f64,
    frozen_until_tick: u64,
    collapse_cooldown: u32,
    rebuilds: u32,
    pre_collapse_target: usize,
    collapse_probe_remaining: u32,
    collapse_probe_baseline_bps: f64,
    collapse_probe_started: bool,
    tail_announced: bool,
}

impl Controller {
    pub fn new(initial_target: usize, max_workers: usize) -> Self {
        let max_workers = max_workers.max(1);
        Self {
            target: initial_target.clamp(1, max_workers),
            max_workers,
            ticks: 0,
            instant_bps: 0.0,
            slow_bps: 0.0,
            peak_bps: 0.0,
            last_instant_bps: 0.0,
            last_per_conn_bps: 0.0,
            growth_cooldown: 0,
            growth_probe: None,
            saturation_hits: 0,
            growth_frozen: false,
            frozen_peak_bps: 0.0,
            frozen_until_tick: 0,
            collapse_cooldown: 0,
            rebuilds: 0,
            pre_collapse_target: initial_target.max(1),
            collapse_probe_remaining: 0,
            collapse_probe_baseline_bps: 0.0,
            collapse_probe_started: false,
            tail_announced: false,
        }
    }

    pub fn target(&self) -> usize {
        self.target
    }

    pub fn max_workers(&self) -> usize {
        self.max_workers
    }

    pub fn rebuilds(&self) -> u32 {
        self.rebuilds
    }

    pub fn growth_frozen(&self) -> bool {
        self.growth_frozen
    }

    fn grow_step(&self, cap: usize) -> usize {
        let step = (self.target / 8).max(1);
        self.target.saturating_add(step).min(cap)
    }

    fn shrink_step(&mut self) -> usize {
        let step = (self.target / 8).max(1);
        self.target.saturating_sub(step).max(1)
    }

    fn set_target(&mut self, target: usize, message: String, effects: &mut Vec<ControllerEffect>) {
        let target = target.clamp(1, self.max_workers);
        if target != self.target {
            self.target = target;
            effects.push(ControllerEffect::SetTarget { target, message });
        }
    }

    fn note(&mut self, message: String, effects: &mut Vec<ControllerEffect>) {
        effects.push(ControllerEffect::Note { message });
    }

    /// Advance one tick and return the effects the engine must apply, in order.
    pub fn step(&mut self, tick: &ControllerTick) -> Vec<ControllerEffect> {
        self.ticks += 1;
        let mut effects: Vec<ControllerEffect> = Vec::new();
        let instant = tick.instant_bps();
        self.instant_bps = instant;
        let elapsed = tick.elapsed_secs.max(1e-6);
        let alpha = 1.0 - (-elapsed / SLOW_TAU_SECS).exp();
        self.slow_bps = if self.slow_bps <= 0.0 && instant > 0.0 { instant } else { self.slow_bps + alpha * (instant - self.slow_bps) };
        self.peak_bps = self.peak_bps.max(instant);
        let per_conn = if tick.active_avg > 0.0 { instant / tick.active_avg } else { instant };
        let cap = tick.cap.clamp(1, self.max_workers);
        // Tail: every remaining claim already has a worker, so the active count
        // falling is completion, not a throughput problem. Freeze the target.
        let tail = tick.remaining_units <= self.target;
        if tail && !self.tail_announced && self.ticks > 1 {
            self.tail_announced = true;
            self.note(format!("tail: target frozen at {} workers (remaining claim units {})", self.target, cap), &mut effects);
        }
        if !tail {
            self.tail_announced = false;
        }

        self.growth_cooldown = self.growth_cooldown.saturating_sub(1);
        self.collapse_cooldown = self.collapse_cooldown.saturating_sub(1);

        // ── Server pushback: halve and cool down. ──────────────────────────
        if tick.pushback {
            let target = (self.target / 2).max(1);
            self.growth_probe = None;
            self.collapse_probe_started = false;
            self.collapse_probe_remaining = 0;
            self.set_target(target, format!("backoff to {target}: server pushback (429/503)"), &mut effects);
            self.growth_cooldown = PUSHBACK_COOLDOWN_TICKS;
            self.slow_bps = self.slow_bps.min(instant.max(0.0) * 0.5);
            self.last_instant_bps = instant;
            self.last_per_conn_bps = per_conn;
            return effects;
        }

        // ── Judge a rebuild probe in flight. ───────────────────────────────
        if self.collapse_probe_started {
            self.collapse_probe_remaining = self.collapse_probe_remaining.saturating_sub(1);
            if self.collapse_probe_remaining == 0 {
                self.collapse_probe_started = false;
                let recovered = instant >= self.collapse_probe_baseline_bps * 1.2;
                if !recovered {
                    let revert = self.pre_collapse_target.clamp(1, cap);
                    self.set_target(revert, format!("revert to {revert}: pool rebuild and probe did not recover throughput"), &mut effects);
                }
                self.collapse_cooldown = COLLAPSE_COOLDOWN_TICKS;
            }
            self.last_instant_bps = instant;
            self.last_per_conn_bps = per_conn;
            return effects;
        }

        // ── Collapse detection: throughput step-down with the pool pinned. ──
        let pinned = self.target >= 2 && tick.active_avg >= self.target as f64 * 0.9;
        let armed = !tail && self.ticks >= WARMUP_TICKS && self.collapse_cooldown == 0 && self.rebuilds < MAX_REBUILDS;
        let collapse = armed
            && pinned
            && self.peak_bps >= COLLAPSE_MIN_PEAK_BPS
            && instant < self.peak_bps * COLLAPSE_RATIO
            && self.slow_bps < self.peak_bps * COLLAPSE_SLOW_RATIO
            && self.last_instant_bps < self.peak_bps * COLLAPSE_RATIO;
        if collapse {
            self.rebuilds += 1;
            self.pre_collapse_target = self.target;
            self.growth_probe = None;
            self.growth_frozen = false;
            self.saturation_hits = 0;
            effects.push(ControllerEffect::RebuildPool { message: format!("pool rebuild #{}: {:.1} -> {:.1} MiB/s at {} workers", self.rebuilds, mib(self.peak_bps), mib(instant), self.target) });
            let grown = self.grow_step(cap);
            if grown > self.target {
                let target = grown;
                self.set_target(target, format!("grow to {target}: probe after pool rebuild"), &mut effects);
            }
            self.collapse_probe_started = true;
            self.collapse_probe_remaining = COLLAPSE_PROBE_TICKS;
            self.collapse_probe_baseline_bps = instant.max(1.0);
            self.last_instant_bps = instant;
            self.last_per_conn_bps = per_conn;
            return effects;
        }

        // ── Saturation freeze: aggregate gain has plateaued. ────────────────
        if self.growth_frozen {
            let rate_fell = self.frozen_peak_bps > 0.0 && instant < self.frozen_peak_bps * SATURATION_UNFREEZE_RATIO;
            if rate_fell || self.ticks >= self.frozen_until_tick {
                self.growth_frozen = false;
                self.saturation_hits = 0;
                if !tail {
                    self.note(format!("growth unfrozen: aggregate {:.1} MiB/s vs frozen peak {:.1} MiB/s", mib(instant), mib(self.frozen_peak_bps)), &mut effects);
                }
            }
        }

        // ── Judge a growth probe from the previous tick (aggregate only). ───
        if let Some(probe) = self.growth_probe.take() {
            let kept = instant >= probe.instant_before * GROWTH_KEEP_RATE_RATIO;
            if !kept {
                let revert = probe.previous_target.clamp(1, cap);
                self.set_target(revert, format!("revert to {revert}: growth dropped aggregate rate ({:.1} -> {:.1} MiB/s)", mib(probe.instant_before), mib(instant)), &mut effects);
                self.growth_cooldown = REVERT_COOLDOWN_TICKS;
                self.saturation_hits = 0;
                self.last_instant_bps = instant;
                self.last_per_conn_bps = per_conn;
                return effects;
            }
            let gain = if probe.instant_before > 0.0 { instant / probe.instant_before - 1.0 } else { 0.0 };
            if gain < SATURATION_MIN_GAIN {
                self.saturation_hits += 1;
            } else {
                self.saturation_hits = 0;
            }
            if self.saturation_hits >= SATURATION_HITS && !self.growth_frozen {
                self.growth_frozen = true;
                self.frozen_peak_bps = self.peak_bps.max(instant);
                self.frozen_until_tick = self.ticks + u64::from(SATURATION_FREEZE_TICKS);
                self.note(format!("growth frozen: aggregate gain < {:.0}% at {:.1} MiB/s over {} probes", SATURATION_MIN_GAIN * 100.0, mib(instant), self.saturation_hits), &mut effects);
            }
            self.growth_cooldown = GROWTH_STEP_COOLDOWN_TICKS;
        }

        // ── Grow when the aggregate has headroom (not in a tail). ────────────
        let busy = tick.active_avg >= self.target as f64 * 0.75;
        if !tail && !self.growth_frozen && self.growth_cooldown == 0 && self.target < cap && busy && instant > 0.0 && self.peak_bps >= COLLAPSE_MIN_PEAK_BPS {
            let next = self.grow_step(cap);
            if next > self.target {
                self.growth_probe = Some(GrowthProbe { previous_target: self.target, instant_before: instant });
                self.set_target(next, format!("grow to {next}: aggregate {:.1} MiB/s, per-connection {:.1} MiB/s", mib(instant), mib(per_conn)), &mut effects);
                self.last_instant_bps = instant;
                self.last_per_conn_bps = per_conn;
                return effects;
            }
        }

        // ── Shrink when workers are not pinned and the rate keeps falling. ───
        let falling = self.last_instant_bps > 0.0 && instant * 10.0 < self.last_instant_bps * 7.0;
        if !tail && self.target > 1 && !pinned && falling && per_conn < self.last_per_conn_bps * 0.85 {
            let next = self.shrink_step();
            self.set_target(next, format!("shrink to {next}: average rate falling"), &mut effects);
        }

        self.last_instant_bps = instant;
        self.last_per_conn_bps = per_conn;
        effects
    }
}

fn mib(bytes_per_second: f64) -> f64 {
    bytes_per_second / (1024.0 * 1024.0)
}

/// Convenience for a target-change event message ("active workers -> N").
pub fn target_event_message(target: usize) -> String {
    format!("active workers -> {target}")
}

impl Default for Controller {
    fn default() -> Self {
        Self::new(1, 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: f64 = 1024.0 * 1024.0;

    fn tick(delta_mib: f64, active: f64, cap: usize) -> ControllerTick {
        ControllerTick { delta_bytes: (delta_mib * MIB) as u64, elapsed_secs: 1.0, active_avg: active, pushback: false, cap, remaining_units: cap }
    }

    fn targets(effects: &[ControllerEffect]) -> Vec<usize> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                ControllerEffect::SetTarget { target, .. } => Some(*target),
                _ => None,
            })
            .collect()
    }

    fn has_rebuild(effects: &[ControllerEffect]) -> bool {
        effects.iter().any(|effect| matches!(effect, ControllerEffect::RebuildPool { .. }))
    }

    fn notes(effects: &[ControllerEffect]) -> Vec<String> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                ControllerEffect::Note { message } => Some(message.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn grows_when_aggregate_rate_holds() {
        let mut controller = Controller::new(8, 128);
        let mut grown = None;
        for _ in 0..3 {
            let effects = controller.step(&tick(40.0, 8.0, 128));
            if !targets(&effects).is_empty() {
                grown = targets(&effects).first().copied();
            }
        }
        assert!(grown.expect("should probe upward") > 8);
        assert!(controller.target() > 8);
    }

    /// 20261109 regression: aggregate stays flat while per-connection dilutes
    /// (64 → 72 workers at 112–114 MiB/s). The probe must be KEPT.
    #[test]
    fn keeps_growth_that_dilutes_per_connection_but_holds_aggregate() {
        let mut controller = Controller::new(64, 128);
        let before = controller.step(&tick(112.0, 64.0, 128));
        assert_eq!(targets(&before), vec![72], "expected a probe to 72");
        // Next tick: aggregate 113 MiB/s (holds), per-connection 113/72 = 1.57.
        let judged = controller.step(&tick(113.0, 72.0, 128));
        assert!(targets(&judged).is_empty(), "must not revert on aggregate hold: {judged:?}");
        assert_eq!(controller.target(), 72);
        assert!(!notes(&judged).iter().any(|note| note.starts_with("revert")), "{judged:?}");
    }

    #[test]
    fn reverts_growth_that_drops_aggregate_rate() {
        let mut controller = Controller::new(64, 128);
        let _ = controller.step(&tick(112.0, 64.0, 128));
        assert_eq!(controller.target(), 72);
        let effects = controller.step(&tick(100.0, 72.0, 128)); // -10.7 %
        assert!(targets(&effects).contains(&64), "expected revert to 64: {effects:?}");
        assert_eq!(controller.target(), 64);
    }

    #[test]
    fn revert_sets_a_30_tick_growth_cooldown() {
        let mut controller = Controller::new(64, 128);
        let _ = controller.step(&tick(112.0, 64.0, 128));
        let _ = controller.step(&tick(100.0, 72.0, 128)); // revert to 64
        assert_eq!(controller.target(), 64);
        // For the next 29 ticks, flat-perfect aggregate must NOT trigger growth.
        for index in 0..(REVERT_COOLDOWN_TICKS - 1) {
            let effects = controller.step(&tick(112.0, 64.0, 128));
            assert!(targets(&effects).is_empty(), "grew during revert cooldown at tick {index}: {effects:?}");
        }
        // After the cooldown, growth is allowed again.
        let mut grew = false;
        for _ in 0..4 {
            if !targets(&controller.step(&tick(112.0, 64.0, 128))).is_empty() {
                grew = true;
                break;
            }
        }
        assert!(grew, "growth should resume after cooldown");
    }

    /// Flat aggregate at the line ceiling: two kept probes with <2 % gain freeze
    /// growth instead of walking 64→72→…→102.
    #[test]
    fn saturation_freezes_growth_at_a_flat_ceiling() {
        let mut controller = Controller::new(64, 128);
        // Grow 64→72 and judge it flat (113 → 113.5, +0.4 %).
        let _ = controller.step(&tick(112.0, 64.0, 128));
        let _ = controller.step(&tick(113.0, 72.0, 128));
        // Grow 72→81 and judge it flat too.
        let mut grew = false;
        for _ in 0..5 {
            let effects = controller.step(&tick(113.0, 72.0, 128));
            if !targets(&effects).is_empty() {
                grew = true;
                break;
            }
        }
        assert!(grew, "second probe should happen");
        let frozen_effects = controller.step(&tick(114.0, 81.0, 128));
        assert!(controller.growth_frozen(), "saturation should freeze growth: {frozen_effects:?}");
        assert!(notes(&frozen_effects).iter().any(|note| note.contains("growth frozen")), "{frozen_effects:?}");
        let target_now = controller.target();
        for _ in 0..20 {
            let effects = controller.step(&tick(114.0, target_now as f64, 128));
            assert!(targets(&effects).is_empty(), "growth while frozen: {effects:?}");
        }
        assert_eq!(controller.target(), target_now);
    }

    #[test]
    fn saturation_unfreezes_when_rate_falls() {
        let mut controller = Controller::new(64, 128);
        let _ = controller.step(&tick(112.0, 64.0, 128));
        let _ = controller.step(&tick(113.0, 72.0, 128));
        for _ in 0..5 {
            if !targets(&controller.step(&tick(113.0, 72.0, 128))).is_empty() {
                break;
            }
        }
        let _ = controller.step(&tick(114.0, 81.0, 128));
        assert!(controller.growth_frozen());
        // Rate falls >10 % below the frozen peak -> unfreeze note, growth allowed.
        let effects = controller.step(&tick(90.0, 81.0, 128));
        assert!(notes(&effects).iter().any(|note| note.contains("growth unfrozen")), "{effects:?}");
        assert!(!controller.growth_frozen());
    }

    #[test]
    fn tail_holds_target_and_never_shrinks() {
        let mut controller = Controller::new(128, 128);
        // Fill the fast phase so the peak is high.
        for _ in 0..12 {
            let _ = controller.step(&tick(112.0, 128.0, 128));
        }
        // Tail: only 70 claim units remain (cap 70 <= target 128) and the rate
        // drops as workers finish — must hold, not shrink below the tail.
        for _ in 0..4 {
            let effects = controller.step(&tick(20.0, 60.0, 70));
            assert!(targets(&effects).is_empty(), "tail must hold target: {effects:?}");
        }
        assert_eq!(controller.target(), 128);
    }

    #[test]
    fn detects_collapse_and_rebuilds_pool_with_more_workers() {
        let mut controller = Controller::new(32, 128);
        // Warmup at a flat fast rate; cap == target keeps growth (and tail) out
        // of the way so the collapse is the first thing that happens.
        for _ in 0..12 {
            let _ = controller.step(&tick(56.0, 32.0, 32));
        }
        assert_eq!(controller.target(), 32);
        // Step down to ~9 MiB/s with every target worker still busy.
        let mut rebuild = None;
        for _ in 0..8 {
            let active = controller.target() as f64;
            let effects = controller.step(&tick(9.0, active, 128));
            if has_rebuild(&effects) {
                rebuild = Some(effects);
                break;
            }
        }
        let rebuild = rebuild.expect("collapse should trigger a pool rebuild");
        assert!(targets(&rebuild).iter().any(|target| *target > 32), "probe should grow: {rebuild:?}");
        assert_eq!(controller.rebuilds(), 1);
    }

    #[test]
    fn rebuild_that_does_not_recover_reverts() {
        let mut controller = Controller::new(32, 128);
        for _ in 0..12 {
            let _ = controller.step(&tick(56.0, 32.0, 32));
        }
        let mut pre_collapse = 32;
        let mut grown_to = 32;
        for _ in 0..8 {
            let before = controller.target();
            let active = before as f64;
            let effects = controller.step(&tick(9.0, active, 128));
            if has_rebuild(&effects) {
                pre_collapse = before;
                grown_to = targets(&effects).first().copied().unwrap_or(before);
                break;
            }
        }
        assert!(grown_to >= pre_collapse, "probe should grow after rebuild: pre={pre_collapse} grown={grown_to}");
        // Probe window: throughput stays low -> revert to the pre-collapse target.
        let mut reverted = None;
        for _ in 0..COLLAPSE_PROBE_TICKS {
            let active = controller.target() as f64;
            let effects = controller.step(&tick(9.0, active, 128));
            if let Some(target) = targets(&effects).first().copied() {
                reverted = Some(target);
            }
        }
        assert_eq!(reverted, Some(pre_collapse));
        assert_eq!(controller.target(), pre_collapse);
    }

    #[test]
    fn pushback_halves_and_cools_down() {
        let mut controller = Controller::new(32, 128);
        for _ in 0..12 {
            let _ = controller.step(&tick(56.0, 32.0, 32));
        }
        assert_eq!(controller.target(), 32);
        let effects = controller.step(&ControllerTick { delta_bytes: (20.0 * MIB) as u64, elapsed_secs: 1.0, active_avg: 32.0, pushback: true, cap: 128, remaining_units: 128 });
        assert_eq!(targets(&effects).len(), 1);
        assert!(controller.target() < 32);
        let halved = controller.target();
        // No growth during the pushback cooldown even with a perfect rate.
        for _ in 0..(PUSHBACK_COOLDOWN_TICKS - 1) {
            let _ = controller.step(&tick(56.0, halved as f64, 128));
        }
        let mut grew = false;
        for _ in 0..6 {
            let active = controller.target() as f64;
            if !targets(&controller.step(&tick(56.0, active, 128))).is_empty() {
                grew = true;
                break;
            }
        }
        assert!(grew, "growth should resume after pushback cooldown");
    }

    #[test]
    fn growth_never_exceeds_cap_or_max_workers() {
        let mut controller = Controller::new(2, 4);
        for _ in 0..10 {
            let effects = controller.step(&tick(5.0, 2.0, 4));
            for target in targets(&effects) {
                assert!(target <= 4);
            }
        }
        assert!(controller.target() <= 4);
    }

    #[test]
    fn small_peaks_never_trigger_collapse() {
        let mut controller = Controller::new(8, 64);
        for _ in 0..12 {
            let _ = controller.step(&tick(1.0, 8.0, 64)); // below the 4 MiB/s floor
        }
        let effects = controller.step(&tick(0.1, 8.0, 64));
        assert!(!has_rebuild(&effects));
    }
}
