//! Ctrl+V paste detection for the OUTGOING chat-translation hint
//! (Windows-only; the non-Windows build keeps a no-op monitor).
//!
//! While the outgoing hint is armed (see `chat_translate::outgoing`'s hint
//! watch), the overlay watcher's 30 ms tick samples the physical keyboard and
//! the Win32 clipboard sequence number:
//!
//! - a RISING edge of Ctrl+V (both keys down this tick, not both down on the
//!   previous tick) is a PASTE — the player pasted the prepared translation
//!   into the in-game chat input. Edges are debounced to at most one per
//!   [`PASTE_DEBOUNCE_MS`], so a key repeat (or the tail of a slower hold
//!   sampled across two ticks) can never dismiss two hint messages;
//! - a clipboard-sequence change that is NOT our own write is a THIRD-PARTY
//!   overwrite (another clipboard tool, or the player copying something
//!   else): the prepared translation is gone, so the hint must dismiss.
//!   `outgoing::clipboard_seq()` carries the sequence our last write
//!   produced ([`None`] while the hint has not written anything yet).
//!
//! The Win32 reads sit behind [`normalize_sample_windows`]; the decision
//! logic ([`PasteDetector`]) is pure and unit-tested with injected samples,
//! so neither the edge rule nor the debounce needs a live window station.

/// Minimum spacing between two RECOGNIZED pastes: the watcher ticks every
/// 30 ms, so two ticks must separate recognitions — a keyboard auto-repeat or
/// the tail of one hold cannot dismiss two consecutive hint messages.
pub(super) const PASTE_DEBOUNCE_MS: u64 = 60;

/// One tick's sampled inputs (injected verbatim in tests).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PasteSample {
    /// Physical Ctrl is down.
    pub ctrl_down: bool,
    /// Physical V is down.
    pub v_down: bool,
    /// `GetClipboardSequenceNumber` at sample time (changes on every
    /// clipboard write, by anyone).
    pub clipboard_seq: u32,
}

/// What one tick's sample means for the hint.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PasteEvent {
    /// Ctrl+V was pressed while the hint was armed — the prepared message
    /// was pasted.
    Pasted,
    /// The clipboard was overwritten by someone else while the hint was
    /// armed — the prepared message can no longer be pasted.
    ThirdParty,
}

/// How long an UNARMED rising edge stays latched: a press during the
/// next-message write window (between Pasted and the copy settling) is the
/// player queuing their NEXT paste — it must fire as soon as the hint
/// re-arms, not vanish.
pub(super) const PASTE_LATCH_MS: u64 = 500;

/// Pure edge/debounce/sequence decision logic (no Win32, unit-tested).
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Default)]
pub(super) struct PasteDetector {
    /// Whether Ctrl+V was down on the PREVIOUS sample (edge tracking).
    prev_combo_down: bool,
    /// When the last paste was recognized (debounce clock).
    last_paste_ms: Option<u64>,
    /// Clipboard sequence seen on the previous sample, armed or not.
    prev_seq: Option<u32>,
    /// A rising edge seen while UNARMED, with its timestamp: replayed (once)
    /// on the first armed tick that follows, within the latch window.
    latched_paste_ms: Option<u64>,
}

#[cfg(any(target_os = "windows", test))]
impl PasteDetector {
    /// Feed one sample. `armed` = the outgoing hint is showing (only then are
    /// pastes / overwrites meaningful); `our_seq` = the sequence number our
    /// last clipboard write produced; `writing` = our own clipboard write is
    /// in flight (its sequence will land under our own marker shortly — a
    /// change seen now is NOT a third-party overwrite). Returns at most ONE
    /// event per sample.
    pub(super) fn observe(
        &mut self,
        sample: PasteSample,
        now_ms: u64,
        armed: bool,
        our_seq: Option<u32>,
        writing: bool,
    ) -> Option<PasteEvent> {
        let combo_down = sample.ctrl_down && sample.v_down;
        let rising_edge = combo_down && !self.prev_combo_down;
        self.prev_combo_down = combo_down;
        let previous_seq = self.prev_seq.replace(sample.clipboard_seq);
        if !armed {
            // Nothing to dismiss — but the trackers keep running, and a press
            // in this window (the player queuing their next paste while the
            // next message's write is still in flight) is LATCHED instead of
            // dropped: it fires once the hint re-arms, within the window.
            if rising_edge {
                self.latched_paste_ms = Some(now_ms);
            }
            return None;
        }
        let queued_paste = self
            .latched_paste_ms
            .is_some_and(|at| now_ms.saturating_sub(at) < PASTE_LATCH_MS);
        if queued_paste {
            self.latched_paste_ms = None;
            self.last_paste_ms = Some(now_ms);
            return Some(PasteEvent::Pasted);
        }
        if rising_edge {
            let debounced = self
                .last_paste_ms
                .is_some_and(|at| now_ms.saturating_sub(at) < PASTE_DEBOUNCE_MS);
            if !debounced {
                self.last_paste_ms = Some(now_ms);
                return Some(PasteEvent::Pasted);
            }
        }
        if let Some(previous) = previous_seq
            && previous != sample.clipboard_seq
            && our_seq != Some(sample.clipboard_seq)
            && !writing
        {
            return Some(PasteEvent::ThirdParty);
        }
        None
    }
}

// ── Windows adapter ──────────────────────────────────────────────────────

/// The watcher-owned adapter: samples Win32 once per tick and feeds
/// [`PasteDetector`].
#[cfg(target_os = "windows")]
#[derive(Debug, Default)]
pub(super) struct PasteMonitor {
    detector: PasteDetector,
}

#[cfg(target_os = "windows")]
impl PasteMonitor {
    /// Sample the keyboard + clipboard once and answer the tick's event.
    /// `writing` = the outgoing pipeline's own clipboard write is in flight
    /// (suppresses third-party sequence detection for that tick).
    pub(super) fn tick(
        &mut self,
        now_ms: u64,
        armed: bool,
        our_seq: Option<u32>,
        writing: bool,
    ) -> Option<PasteEvent> {
        self.detector
            .observe(normalize_sample_windows(), now_ms, armed, our_seq, writing)
    }
}

/// The production sample: physical key states + the clipboard sequence.
#[cfg(target_os = "windows")]
fn normalize_sample_windows() -> PasteSample {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_V};

    let down = |virtual_key: i32| {
        let state = unsafe { GetAsyncKeyState(virtual_key) };
        (state as u16) & 0x8000 != 0
    };
    PasteSample {
        ctrl_down: down(VK_CONTROL.0 as i32),
        v_down: down(VK_V.0 as i32),
        clipboard_seq: unsafe { GetClipboardSequenceNumber() },
    }
}

// ── Non-Windows stub ─────────────────────────────────────────────────────

/// No clipboard monitoring on non-Windows targets: the tick answers
/// "nothing happened" (the outgoing hint is a desktop-Windows feature).
#[cfg(not(target_os = "windows"))]
#[derive(Debug, Default)]
pub(super) struct PasteMonitor;

#[cfg(not(target_os = "windows"))]
impl PasteMonitor {
    pub(super) fn tick(
        &mut self,
        _now_ms: u64,
        _armed: bool,
        _our_seq: Option<u32>,
        _writing: bool,
    ) -> Option<PasteEvent> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(ctrl: bool, v: bool, seq: u32) -> PasteSample {
        PasteSample {
            ctrl_down: ctrl,
            v_down: v,
            clipboard_seq: seq,
        }
    }

    /// A Ctrl+V rising edge while armed is one Paste; the held combo does not
    /// repeat, and a release/re-press after the debounce window pastes again.
    #[test]
    fn rising_edge_pastes_once_per_press() {
        let mut detector = PasteDetector::default();
        // Arming with the keys already up: no edge.
        assert_eq!(
            detector.observe(sample(false, false, 1), 0, true, None, false),
            None
        );
        // Ctrl down first (still not the combo), then V down = the edge.
        assert_eq!(
            detector.observe(sample(true, false, 1), 30, true, None, false),
            None
        );
        assert_eq!(
            detector.observe(sample(true, true, 1), 60, true, None, false),
            Some(PasteEvent::Pasted)
        );
        // The same hold on later ticks is NOT a new paste.
        assert_eq!(
            detector.observe(sample(true, true, 1), 90, true, None, false),
            None
        );
        assert_eq!(
            detector.observe(sample(true, true, 1), 120, true, None, false),
            None
        );
        // Release, then a second press after the debounce window pastes.
        assert_eq!(
            detector.observe(sample(true, false, 1), 150, true, None, false),
            None
        );
        assert_eq!(
            detector.observe(sample(true, true, 1), 180, true, None, false),
            Some(PasteEvent::Pasted)
        );
    }

    /// Two presses closer together than [`PASTE_DEBOUNCE_MS`] collapse to
    /// one paste (a chatter-prone tick cannot dismiss two hints).
    #[test]
    fn debounce_suppresses_a_second_press() {
        let mut detector = PasteDetector::default();
        assert_eq!(
            detector.observe(sample(true, true, 1), 0, true, None, false),
            Some(PasteEvent::Pasted)
        );
        // Released, re-pressed 30 ms later: inside the debounce window.
        assert_eq!(
            detector.observe(sample(false, false, 1), 10, true, None, false),
            None
        );
        assert_eq!(
            detector.observe(sample(true, true, 1), 30, true, None, false),
            None
        );
        // Past the window the next press counts again.
        assert_eq!(
            detector.observe(sample(false, false, 1), 70, true, None, false),
            None
        );
        assert_eq!(
            detector.observe(sample(true, true, 1), 90, true, None, false),
            Some(PasteEvent::Pasted)
        );
    }

    /// While armed, a clipboard sequence change that is not our own write is
    /// a ThirdParty overwrite; our own write's sequence is ignored.
    #[test]
    fn third_party_overwrite_is_detected_but_our_write_is_not() {
        let mut detector = PasteDetector::default();
        // Armed; the hint's own write produced seq 10 (our_seq = 10).
        assert_eq!(
            detector.observe(sample(false, false, 9), 0, true, Some(10), false),
            None
        );
        assert_eq!(
            detector.observe(sample(false, false, 10), 30, true, Some(10), false),
            None
        );
        // Somebody else overwrote the clipboard: 10 -> 11, not ours.
        assert_eq!(
            detector.observe(sample(false, false, 11), 60, true, Some(10), false),
            Some(PasteEvent::ThirdParty)
        );
        // With nothing written by us (our_seq None) any change is third-party.
        let mut detector = PasteDetector::default();
        assert_eq!(
            detector.observe(sample(false, false, 5), 0, true, None, false),
            None
        );
        assert_eq!(
            detector.observe(sample(false, false, 6), 30, true, None, false),
            Some(PasteEvent::ThirdParty)
        );
    }

    /// Nothing is reported while the hint is not armed, even for edges or
    /// clipboard churn — but the trackers still advance, so arming with a
    /// fresh sequence does not fire a phantom overwrite. An unarmed edge is
    /// LATCHED (see the next test); arming more than [`PASTE_LATCH_MS`]
    /// later lets it expire unheard.
    #[test]
    fn unarmed_ticks_never_report_but_keep_trackers_fresh() {
        let mut detector = PasteDetector::default();
        // Unarmed: a paste edge and a clipboard change are both silent.
        assert_eq!(
            detector.observe(sample(true, true, 1), 0, false, None, false),
            None
        );
        assert_eq!(
            detector.observe(sample(false, false, 2), 30, false, None, false),
            None
        );
        // Armed long after the latch window: neither the stale edge nor the
        // (already-tracked) sequence fires anything.
        assert_eq!(
            detector.observe(sample(false, false, 2), 600, true, None, false),
            None
        );
        // A fresh edge while armed is a real paste.
        assert_eq!(
            detector.observe(sample(true, true, 2), 630, true, None, false),
            Some(PasteEvent::Pasted)
        );
    }

    /// A press during the UNARMED write window (the player queuing their
    /// next paste while the next message's copy is still settling) is
    /// latched and replayed exactly once when the hint re-arms.
    #[test]
    fn an_unarmed_press_is_latched_and_replayed_on_arming() {
        let mut detector = PasteDetector::default();
        // Armed first press pastes normally.
        assert_eq!(
            detector.observe(sample(true, true, 1), 0, true, None, false),
            Some(PasteEvent::Pasted)
        );
        assert_eq!(
            detector.observe(sample(false, false, 1), 30, true, None, false),
            None
        );
        // Unarmed (copy of the next message in flight): the queued press is
        // silent NOW…
        assert_eq!(
            detector.observe(sample(true, true, 1), 60, false, None, false),
            None
        );
        assert_eq!(
            detector.observe(sample(false, false, 1), 90, false, None, false),
            None
        );
        // …and fires exactly once when the hint re-arms within the window.
        assert_eq!(
            detector.observe(sample(false, false, 1), 120, true, None, false),
            Some(PasteEvent::Pasted)
        );
        assert_eq!(
            detector.observe(sample(false, false, 1), 150, true, None, false),
            None
        );
    }

    /// While our own clipboard write is settling, a sequence change is NOT a
    /// third-party overwrite (the `writing` suppression).
    #[test]
    fn a_sequence_change_during_our_own_write_is_not_third_party() {
        let mut detector = PasteDetector::default();
        assert_eq!(
            detector.observe(sample(false, false, 1), 0, true, Some(1), false),
            None
        );
        // Our write lands: sequence moved to 2, our stored marker is still
        // the old 1 — without the suppression this would fire ThirdParty.
        assert_eq!(
            detector.observe(sample(false, false, 2), 30, true, Some(1), true),
            None
        );
        // Once the write settled (marker updated), silence continues.
        assert_eq!(
            detector.observe(sample(false, false, 2), 60, true, Some(2), false),
            None
        );
        // A later change by someone else still fires.
        assert_eq!(
            detector.observe(sample(false, false, 7), 90, true, Some(2), false),
            Some(PasteEvent::ThirdParty)
        );
    }
}
