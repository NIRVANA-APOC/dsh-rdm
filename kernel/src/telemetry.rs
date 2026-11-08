//! Bounded speed-sample ring and the derived kernel telemetry (§2.4, §5.1).
//!
//! The reporter tick (≤ 100 ms) pushes cumulative downloaded bytes into a ring
//! capped at 3000 samples (300 s of history). Window rates are measured over
//! the trailing samples inside each window; a window with fewer than two
//! samples reports `null` instead of fabricating a rate. Peak and average are
//! kept by the task so pause/resume does not lose the high-water mark.

use crate::protocol::{EtaConfidence, Trend, WindowRates};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Sampling cadence; also the reporter tick.
pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(100);
/// 300 s at 100 ms cadence.
pub const MAX_SAMPLES: usize = 3000;
pub const MAX_WINDOW: Duration = Duration::from_secs(300);
/// A transfer is reported as stalled after this long without a byte.
pub const STALL_THRESHOLD_MS: u64 = 5_000;
/// `high` ETA confidence needs at least this many samples...
pub const HIGH_CONFIDENCE_MIN_SAMPLES: usize = 5;
/// ...and a coefficient of variation below this.
pub const HIGH_CONFIDENCE_MAX_CV: f64 = 0.35;
/// The EWMA byte-rate smoothing window.
const EWMA_TAU_SECS: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    pub at: Instant,
    pub bytes: u64,
}

#[derive(Debug, Default, Clone)]
pub struct SpeedRing {
    samples: VecDeque<Sample>,
}

impl SpeedRing {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new run starts a fresh measurement window; the ring records only
    /// within-run throughput.
    pub fn reset(&mut self) {
        self.samples.clear();
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    pub fn last(&self) -> Option<Sample> {
        self.samples.back().copied()
    }

    /// The reporter tick asks before every push; keeping the ring at
    /// ≤ 1 sample / 100 ms bounds memory without adding a timer.
    pub fn should_sample(&self, now: Instant) -> bool {
        match self.samples.back() {
            Some(last) => now.saturating_duration_since(last.at) >= SAMPLE_INTERVAL,
            None => true,
        }
    }

    pub fn push(&mut self, at: Instant, bytes: u64) {
        if let Some(last) = self.samples.back() {
            // Cumulative bytes never decrease inside a run; ignore duplicate
            // timestamps from a coarser clock.
            if at < last.at {
                return;
            }
        }
        self.samples.push_back(Sample { at, bytes });
        // Keep one sample just outside the 300 s window so the longest window
        // still has an anchor, then hard-cap the ring.
        while self.samples.len() > 2 {
            let front = self.samples.front().copied().expect("non-empty");
            if at.saturating_duration_since(front.at) > MAX_WINDOW {
                self.samples.pop_front();
            } else {
                break;
            }
        }
        while self.samples.len() > MAX_SAMPLES {
            self.samples.pop_front();
        }
    }

    /// Byte rate over the trailing window ending at `now`, or `null` when the
    /// window holds fewer than two samples (no measurement, no guess).
    pub fn window_rate(&self, now: Instant, window: Duration) -> Option<u64> {
        let newest = self.samples.back().copied()?;
        if self.samples.len() < 2 {
            return None;
        }
        let cutoff = now.checked_sub(window)?;
        // Oldest sample still inside the window (the reverse scan stops at the
        // first sample older than the cutoff).
        let mut anchor: Option<Sample> = None;
        for sample in self.samples.iter().rev() {
            if sample.at < cutoff {
                break;
            }
            anchor = Some(*sample);
        }
        let anchor = anchor?;
        if anchor.at >= newest.at {
            return None;
        }
        let elapsed = newest.at.saturating_duration_since(anchor.at).as_secs_f64();
        if elapsed <= 0.0 {
            return None;
        }
        let bytes = newest.bytes.saturating_sub(anchor.bytes);
        Some((bytes as f64 / elapsed).min(u64::MAX as f64) as u64)
    }

    pub fn windows(&self, now: Instant) -> WindowRates {
        WindowRates { w1s: self.window_rate(now, Duration::from_secs(1)), w5s: self.window_rate(now, Duration::from_secs(5)), w30s: self.window_rate(now, Duration::from_secs(30)), w300s: self.window_rate(now, Duration::from_secs(300)) }
    }

    /// Instantaneous delta rates for the most recent `max_deltas` intervals,
    /// used for the ETA-confidence coefficient of variation.
    pub fn coefficient_of_variation(&self, max_deltas: usize) -> Option<f64> {
        if self.samples.len() < 3 || max_deltas == 0 {
            return None;
        }
        let start = self.samples.len().saturating_sub(max_deltas + 1);
        let slice: Vec<Sample> = self.samples.iter().skip(start).copied().collect();
        let mut rates: Vec<f64> = Vec::with_capacity(slice.len().saturating_sub(1));
        for pair in slice.windows(2) {
            let dt = pair[1].at.saturating_duration_since(pair[0].at).as_secs_f64();
            if dt <= 0.0 {
                continue;
            }
            rates.push(pair[1].bytes.saturating_sub(pair[0].bytes) as f64 / dt);
        }
        if rates.len() < 2 {
            return None;
        }
        let mean = rates.iter().sum::<f64>() / rates.len() as f64;
        if mean <= 0.0 {
            return None;
        }
        let variance = rates.iter().map(|rate| (rate - mean).powi(2)).sum::<f64>() / rates.len() as f64;
        Some(variance.sqrt() / mean)
    }
}

/// `f64` EWMA update for the flat `speedBps` field. Time-based so the alpha is
/// stable across reporter tick jitter.
pub fn ewma_step(previous: f64, instant_bps: f64, dt: Duration) -> f64 {
    let dt = dt.as_secs_f64().max(1e-6);
    let alpha = 1.0 - (-dt / EWMA_TAU_SECS).exp();
    if previous <= 0.0 {
        instant_bps
    } else {
        previous + alpha * (instant_bps - previous)
    }
}

pub fn trend_of(windows: &WindowRates, stalled_ms: u64, samples: usize) -> Trend {
    if stalled_ms >= STALL_THRESHOLD_MS {
        return Trend::Stalled;
    }
    if samples < 2 {
        return Trend::Unknown;
    }
    match (windows.w1s, windows.w5s, windows.w30s) {
        (Some(w1), Some(w5), _) if w5 > 0 => {
            let ratio = w1 as f64 / w5 as f64;
            if ratio >= 1.15 {
                Trend::Rising
            } else if ratio <= 0.85 {
                Trend::Falling
            } else {
                Trend::Steady
            }
        }
        (Some(w1), Some(w5), _) if w5 == 0 && w1 > 0 => Trend::Rising,
        (Some(w1), None, Some(w30)) if w30 > 0 => {
            let ratio = w1 as f64 / w30 as f64;
            if ratio >= 1.15 {
                Trend::Rising
            } else if ratio <= 0.85 {
                Trend::Falling
            } else {
                Trend::Steady
            }
        }
        (Some(_), _, _) => Trend::Steady,
        (None, _, _) => Trend::Unknown,
    }
}

pub fn eta_confidence_of(total_known: bool, paused: bool, stalled_ms: u64, samples: usize, cv: Option<f64>) -> EtaConfidence {
    if !total_known || paused {
        return EtaConfidence::Unknown;
    }
    if stalled_ms >= STALL_THRESHOLD_MS || samples < 2 {
        return EtaConfidence::Low;
    }
    match cv {
        Some(cv) if samples >= HIGH_CONFIDENCE_MIN_SAMPLES && cv < HIGH_CONFIDENCE_MAX_CV => EtaConfidence::High,
        _ => EtaConfidence::Medium,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring_with_rates(rates_bps: &[u64]) -> (SpeedRing, Instant, u64) {
        let start = Instant::now();
        let mut ring = SpeedRing::new();
        let mut bytes = 0u64;
        for (index, rate) in rates_bps.iter().enumerate() {
            ring.push(start + SAMPLE_INTERVAL * index as u32, bytes);
            bytes += rate / 10; // 100 ms of this rate
        }
        let now = start + SAMPLE_INTERVAL * rates_bps.len().max(1) as u32;
        (ring, now, bytes)
    }

    #[test]
    fn constant_rate_yields_matching_windows() {
        let (ring, now, _bytes) = ring_with_rates(&[1_000_000; 40]);
        let windows = ring.windows(now);
        assert_eq!(windows.w1s, Some(1_000_000));
        assert_eq!(windows.w5s, Some(1_000_000));
        assert_eq!(windows.w30s, Some(1_000_000));
        // 40 samples ≈ 4 s of history inside the 300 s window.
        let w300 = windows.w300s.expect("300s window over available span");
        assert!((w300 as i64 - 1_000_000).abs() <= 100_000, "w300={w300}");
        assert!(ring.coefficient_of_variation(16).unwrap() < 0.01);
    }

    #[test]
    fn windows_are_null_without_samples() {
        let ring = SpeedRing::new();
        let windows = ring.windows(Instant::now());
        assert_eq!(windows.w1s, None);
        assert_eq!(windows.w300s, None);
        let mut ring = SpeedRing::new();
        ring.push(Instant::now(), 10);
        assert_eq!(ring.windows(Instant::now()).w1s, None);
    }

    #[test]
    fn ring_is_bounded_and_forgets_stale_samples() {
        let mut ring = SpeedRing::new();
        let start = Instant::now();
        for index in 0..(MAX_SAMPLES + 500) {
            ring.push(start + SAMPLE_INTERVAL * index as u32, index as u64 * 1000);
        }
        assert!(ring.len() <= MAX_SAMPLES);
        let now = start + SAMPLE_INTERVAL * (MAX_SAMPLES + 500) as u32;
        // No anchor inside the expired windows.
        let after = now + Duration::from_secs(400);
        let windows = ring.windows(after);
        assert_eq!(windows.w1s, None);
        assert_eq!(windows.w300s, None);
    }

    #[test]
    fn idle_ring_decays_to_null_windows() {
        let (ring, now, _) = ring_with_rates(&[2_000_000; 10]);
        assert!(ring.windows(now).w1s.is_some());
        let later = now + Duration::from_secs(2);
        assert_eq!(ring.windows(later).w1s, None);
    }

    #[test]
    fn reset_clears_samples() {
        let mut ring = SpeedRing::new();
        ring.push(Instant::now(), 1);
        ring.reset();
        assert_eq!(ring.len(), 0);
    }

    #[test]
    fn stall_and_confidence_rules() {
        assert_eq!(tip(0, Some(1.0)), EtaConfidence::Low);
        assert_eq!(tip(10, Some(0.2)), EtaConfidence::High);
        assert_eq!(tip(10, Some(0.8)), EtaConfidence::Medium);
        assert_eq!(eta_confidence_of(false, false, 0, 10, Some(0.1)), EtaConfidence::Unknown);
        assert_eq!(eta_confidence_of(true, true, 0, 10, Some(0.1)), EtaConfidence::Unknown);
    }

    fn tip(samples: usize, cv: Option<f64>) -> EtaConfidence {
        eta_confidence_of(true, false, 0, samples, cv)
    }

    #[test]
    fn trend_rising_falling_stalled() {
        let rising = WindowRates { w1s: Some(2_000_000), w5s: Some(1_000_000), w30s: Some(900_000), w300s: None };
        assert_eq!(trend_of(&rising, 0, 10), Trend::Rising);
        let falling = WindowRates { w1s: Some(400_000), w5s: Some(1_000_000), w30s: Some(900_000), w300s: None };
        assert_eq!(trend_of(&falling, 0, 10), Trend::Falling);
        let steady = WindowRates { w1s: Some(1_000_000), w5s: Some(1_000_000), w30s: Some(900_000), w300s: None };
        assert_eq!(trend_of(&steady, 0, 10), Trend::Steady);
        assert_eq!(trend_of(&steady, STALL_THRESHOLD_MS, 10), Trend::Stalled);
        assert_eq!(trend_of(&WindowRates::default(), 0, 0), Trend::Unknown);
    }

    #[test]
    fn ewma_is_time_based() {
        let value = ewma_step(0.0, 1_000.0, Duration::from_millis(100));
        assert_eq!(value, 1_000.0);
        let slow = ewma_step(1_000.0, 0.0, Duration::from_millis(100));
        assert!(slow < 1_000.0 && slow > 800.0, "slow={slow}");
    }
}
