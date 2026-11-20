//! RFC3339 helpers over jiff that keep the exact string shapes chrono's
//! `to_rfc3339()` family used to produce (2026-11 jiff migration — see the
//! workspace Cargo.toml comment for why chrono left). The fractional
//! seconds are rendered by hand because chrono's AutoSi precision (nothing
//! when zero, else 3/6/9 digits by alignment, truncating) is NOT what
//! jiff's `%.f` emits — jiff trims trailing zeros, so a micro-aligned
//! clock would print `.1005` where chrono printed `.100500`, and stored
//! stamps would change shape mid-stream.

use std::time::SystemTime;

/// chrono's AutoSi fractional rendering: empty when zero, else 3/6/9
/// digits by alignment (truncation, never rounding).
///
/// jiff's `subsec_nanosecond` is SIGNED (a pre-1970 instant reports a
/// negative sub-second part), so the magnitude is rendered — chrono's own
/// `to_rfc3339` did the same, formatting the wall-clock digits.
fn auto_si_fraction(nanos: i32) -> String {
    let nanos = nanos.unsigned_abs();
    if nanos == 0 {
        String::new()
    } else if nanos % 1_000_000 == 0 {
        format!(".{:03}", nanos / 1_000_000)
    } else if nanos % 1_000 == 0 {
        format!(".{:06}", nanos / 1_000)
    } else {
        format!(".{nanos:09}")
    }
}

/// `chrono::Utc::now().to_rfc3339()`: UTC now, `+00:00` suffix, AutoSi
/// fraction.
pub(crate) fn now_utc_rfc3339() -> String {
    rfc3339_utc(jiff::Timestamp::now())
}

/// RFC3339 for a UTC instant with the `+00:00` spelling and AutoSi
/// fraction — byte-identical to chrono's `DateTime<Utc>::to_rfc3339()`.
/// Consumers parse both spellings (`Z` included) with
/// `string.parse::<jiff::Timestamp>()`.
pub(crate) fn rfc3339_utc(ts: jiff::Timestamp) -> String {
    format!(
        "{}{}+00:00",
        ts.strftime("%Y-%m-%dT%H:%M:%S"),
        auto_si_fraction(ts.subsec_nanosecond()),
    )
}

/// `chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()` for a file /
/// clock `SystemTime`. jiff's conversion is fallible where chrono's
/// `From` was not, but the failure needs a `SystemTime` outside any
/// file-system or clock range; the fallback renders the error honestly
/// instead of a plausible-looking stamp.
pub(crate) fn rfc3339_utc_from(t: SystemTime) -> String {
    match jiff::Timestamp::try_from(t) {
        Ok(ts) => rfc3339_utc(ts),
        Err(e) => format!("invalid-system-time: {e}"),
    }
}

/// `Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)`: always three
/// fraction digits and a `Z` suffix. The millisecond precision is
/// load-bearing (consecutive installs must compare distinct — see
/// commands/resources.rs) — keep it exact.
pub(crate) fn now_utc_rfc3339_millis() -> String {
    let ts = jiff::Timestamp::now();
    // nano → milli is a plain /1_000_000 (nanos < 1e9, so the result is
    // 0..=999); chrono truncates, never rounds. `unsigned_abs` keeps a
    // pre-1970 instant's negative sub-second part out of the digit run.
    let millis = ts.subsec_nanosecond().unsigned_abs() / 1_000_000;
    format!("{}.{millis:03}Z", ts.strftime("%Y-%m-%dT%H:%M:%S"))
}

/// `chrono::Local::now().to_rfc3339()`: RFC3339 with the machine's local
/// offset (`+08:00` and friends), AutoSi fraction.
pub(crate) fn now_local_rfc3339() -> String {
    let zdt = jiff::Zoned::now();
    format!(
        "{}{}{}",
        zdt.strftime("%Y-%m-%dT%H:%M:%S"),
        auto_si_fraction(zdt.subsec_nanosecond()),
        zdt.strftime("%:z"),
    )
}

/// `chrono::Local::now().format("%Y%m%d-%H%M%S")` — the local file-name
/// stem shared by the log bundle, tab dump and crash report writers.
pub(crate) fn now_local_compact() -> String {
    jiff::Zoned::now().strftime("%Y%m%d-%H%M%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// chrono's AutoSi contract, pinned digit by digit: the shapes below
    /// are what the previous `DateTime<Utc>::to_rfc3339()` emitted for
    /// each alignment class of the sub-second part.
    #[test]
    fn rfc3339_utc_matches_chrono_autosi_shapes() {
        // 1_742_716_800 == 2025-03-23T08:00:00Z.
        let cases = [
            (0_i32, "2025-03-23T08:00:00+00:00"),
            (123_000_000, "2025-03-23T08:00:00.123+00:00"),
            (123_456_000, "2025-03-23T08:00:00.123456+00:00"),
            (123_456_789, "2025-03-23T08:00:00.123456789+00:00"),
            // A micro-aligned value must keep its trailing zero — jiff's
            // own `%.f` would print `.1005` here, chrono printed `.100500`.
            (100_500_000, "2025-03-23T08:00:00.100500+00:00"),
        ];
        for (nanos, expected) in cases {
            let ts = jiff::Timestamp::new(1_742_716_800, nanos).unwrap();
            assert_eq!(rfc3339_utc(ts), expected, "nanos={nanos}");
        }
    }

    #[test]
    fn utc_millis_always_carries_three_digits() {
        let cases = [
            (0_i32, ".000Z"),
            (5_000_000, ".005Z"),
            (123_000_000, ".123Z"),
            // Sub-millisecond precision is truncated, never rounded.
            (123_999_999, ".123Z"),
        ];
        for (nanos, expected) in cases {
            let ts = jiff::Timestamp::new(1_742_716_800, nanos).unwrap();
            let millis = ts.subsec_nanosecond().unsigned_abs() / 1_000_000;
            let rendered = format!("{}.{millis:03}Z", ts.strftime("%Y-%m-%dT%H:%M:%S"));
            assert!(rendered.ends_with(expected), "nanos={nanos}: {rendered}");
        }
    }

    /// A pre-1970 instant reports a NEGATIVE sub-second part in jiff; the
    /// helpers must still render plain digits (chrono did the same).
    #[test]
    fn pre_epoch_instants_render_unsigned_digits() {
        let ts = jiff::Timestamp::new(-5, -999_999_999).unwrap();
        let got = rfc3339_utc(ts);
        assert!(!got.contains("--"), "no double sign: {got}");
        assert!(got.ends_with(".999999999+00:00"), "{got}");
    }

    #[test]
    fn parsed_stamps_round_trip_through_both_suffix_shapes() {
        // The stored ecosystem carries both spellings (`to_rfc3339_opts`
        // produced `Z`-suffixed stamps, `to_rfc3339` produced `+00:00`):
        // the jiff parser must accept both and agree on the instant.
        let a: jiff::Timestamp = "2026-11-20T12:00:00.123+00:00".parse().unwrap();
        let b: jiff::Timestamp = "2026-11-20T12:00:00.123Z".parse().unwrap();
        assert_eq!(a, b);
    }
}
