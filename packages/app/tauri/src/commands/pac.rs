//! PAC (proxy auto-config) engine — the downloader's real FindProxyForURL
//! support behind the system-proxy channel.
//!
//! Until now a WinINET AutoConfigURL was only DETECTED
//! (network::system_proxy_context showed pacConfigured: true) and never
//! FOLLOWED: reqwest has no PAC support, so a PAC-only network that needs
//! the proxy to reach the internet read as "direct" and every lookup
//! failed. This module closes that gap:
//!
//!   1. configured_url() reads the AutoConfigURL (the single read site —
//!      network.rs must call THIS, never the registry itself).
//!   2. refresh_if_stale() / kick_refresh() fetch the PAC script over a
//!      deliberately DIRECT client (the bootstrap must never ride the very
//!      proxy it is about to discover), keep it fresh (15 min success TTL,
//!      10 min failed-retry window), and load it into a JS engine.
//!   3. resolve_for_url() evaluates FindProxyForURL(url, host) per request
//!      and returns the chosen route; network::http_builder_for wires that
//!      into a reqwest::Proxy::custom closure when the system channel is
//!      "pac".
//!
//! The PAC body is arbitrary JavaScript, so evaluation runs on an embedded
//! interpreter: boa_engine (pure Rust, no external JS runtime). boa's
//! Context is !Send (it holds Rc realm/job-executor hooks), so the context
//! can NEVER sit in a shared static — instead ONE dedicated OS thread owns
//! it for the whole process lifetime and answers Load/Resolve messages
//! over channels. The shared ENGINE state around it (configured URL,
//! script source + fetch instant, status, per-host resolution cache) is a
//! plain Mutex, exactly like the other registries in this crate.
//!
//! Degrade discipline (house rule: the diagnostics panel must explain,
//! the downloader must not die):
//!   - fetch/parse/eval failure -> status Unavailable; the system channel
//!     falls back to the WinINET manual proxy, then direct (WinINET's own
//!     fallback order) — and tracing::warn records why,
//!   - evaluation error/timeout per request -> that request goes DIRECT,
//!   - WPAD (AutoDetect) stays unsupported, exactly as before.
//!
//! The helper surface follows the Navigator Proxy Auto-Discovery File
//! Format: isPlainHostName, dnsDomainIs, localHostOrDomainIs, isResolvable
//! (+Ex), dnsResolve, myIpAddress, dnsDomainLevels, shExpMatch, isInNet
//! (+Ex), dateRange, timeRange, weekdayRange. dnsResolve / myIpAddress are
//! injectable function pointers so tests never touch a real resolver.
//!
//! Threading note for reviewers: the per-request path is SYNC (reqwest's
//! proxy intercept is a sync closure), and the helper DNS lookups are
//! blocking syscalls without a timeout surface — a script probing a
//! black-holed host can stall its one evaluation thread, which is why
//! resolve_for_url carries a 1s round-trip budget and degrades to direct
//! on expiry instead of hanging the connect.

use anyhow::anyhow;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use boa_engine::{
    JsArgs, JsObject, JsResult, JsString, JsValue, NativeFunction, Source, context::Context,
    js_string,
};
use chrono::{Datelike, Timelike};

use crate::commands::network::build_direct_http_client;

// ── Wire-level status ──────────────────────────────────────────────────────

/// IPC spellings of PacStatus for the pacStatus field (null when not
/// configured — the Option lives at the call site, never in this enum).
const PAC_STATUS_LOADED: &str = "loaded";
const PAC_STATUS_UNAVAILABLE: &str = "unavailable";

/// Whether the engine currently holds a WORKING evaluation of the
/// configured PAC script. Configured-but-never-attempted reads as
/// PacStatus::Unavailable on the wire (see engine_status_for).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PacStatus {
    Loaded,
    Unavailable,
}

impl PacStatus {
    fn wire(self) -> &'static str {
        match self {
            PacStatus::Loaded => PAC_STATUS_LOADED,
            PacStatus::Unavailable => PAC_STATUS_UNAVAILABLE,
        }
    }
}

// ── The single AutoConfigURL read site ─────────────────────────────────────

/// The WinINET PAC auto-config URL (HKCU Internet Settings value
/// AutoConfigURL), trimmed and non-empty — or None when unset. Every
/// reader in the app (system_proxy_context, the channel decision, the
/// refresh loop) comes through here so the key/value spelling lives in
/// exactly one place, like the rest of the WinINET reads in network.rs.
#[cfg(windows)]
pub(crate) fn configured_url() -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let url: String = key.get_value("AutoConfigURL").ok()?;
    let url = url.trim();
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

/// No WinINET off Windows: the PAC engine is structurally inert there and
/// the system channel never takes the "pac" route.
#[cfg(not(windows))]
pub(crate) fn configured_url() -> Option<String> {
    None
}

// ── Refresh cadence constants ──────────────────────────────────────────────

/// The PAC bootstrap fetch must resolve quickly: a proxy-only network
/// black-holes the DIRECT fetch, and every second of that delay happens
/// before the first request even starts (clients built meanwhile degrade
/// to the WinINET fallback until the script lands).
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// A successfully loaded script is re-fetched after this long: PAC files
/// change with network topology, and a stale one silently misroutes
/// everything. Matches the "refresh roughly every quarter hour" cadence
/// browsers use.
const SCRIPT_TTL: Duration = Duration::from_secs(15 * 60);

/// A FAILED attempt is retried sooner than a success expires: the network
/// may have recovered (or the PAC host may simply have had a hiccup), and
/// waiting the full 15 min to discover that would leave proxy-only users
/// on the degraded fallback for a quarter hour.
const FAILED_RETRY_TTL: Duration = Duration::from_secs(10 * 60);

/// Hard cap on a PAC script body. Real scripts are a few KB; anything over
/// a mebibyte is an attack or a misconfigured web server answering HTML —
/// either way it must not become the evaluation payload.
const MAX_SCRIPT_BYTES: usize = 1024 * 1024;

/// Per-host resolution cache cap (spec: ~512, simple FIFO eviction). Each
/// entry is one host string + one route string, so the ceiling is bytes,
/// not a concern.
const HOST_CACHE_CAP: usize = 512;

/// How long a DNS answer stays trustworthy for the PAC helpers. PAC
/// scripts resolve hosts at evaluation time; without a TTL a busy session
/// would hammer the resolver per request.
const DNS_TTL: Duration = Duration::from_secs(60);

/// DNS cache cap — same rationale as HOST_CACHE_CAP, smaller because PAC
/// scripts typically touch a handful of hosts.
const DNS_CACHE_CAP: usize = 256;

/// One FindProxyForURL evaluation budget. The helper DNS lookups are
/// blocking syscalls with no timeout surface; a script that probes a
/// black-holed host must not stall every connect behind it — the resolve
/// gives up and the request goes DIRECT instead.
const RESOLVE_BUDGET: Duration = Duration::from_secs(1);

/// How long a script Load may take before the refresh gives up on the
/// evaluator thread (compiling a <=1 MiB script is milliseconds; this
/// ceiling only matters when the thread is wedged).
const LOAD_BUDGET: Duration = Duration::from_secs(5);

// ── DNS plumbing (real + injectable) ───────────────────────────────────────

/// A DNS resolver the helper bindings call into. A plain fn pointer (not a
/// closure / trait object) is what lets the bindings register through
/// NativeFunction::from_copy_closure — Copy captures keep the whole
/// registration path free of unsafe and of GC-trace reasoning, and make
/// tests inject fixtures by passing a different function.
type DnsResolveFn = fn(&str) -> Option<String>;

/// The myIpAddress provider, same injectability story as DnsResolveFn.
type MyIpFn = fn() -> String;

/// One cached DNS answer: the picked IP (None = resolution failed) and the
/// moment it went in. Failures are cached too — a negative answer must not
/// re-storm the resolver per request on a host the script keeps probing.
#[derive(Debug, Clone)]
struct DnsEntry {
    ip: Option<String>,
    at: Instant,
}

/// FIFO + TTL cache, struct-owned so tests can drive it without a global
/// (and without a resolver).
#[derive(Debug, Default)]
struct DnsCache {
    map: HashMap<String, DnsEntry>,
    order: VecDeque<String>,
}

impl DnsCache {
    fn lookup(&self, host: &str) -> Option<Option<String>> {
        let entry = self.map.get(host)?;
        if entry.at.elapsed() > DNS_TTL {
            return None; // expired: caller re-resolves and re-inserts
        }
        Some(entry.ip.clone())
    }

    fn insert(&mut self, host: String, ip: Option<String>) {
        if !self.map.contains_key(&host) {
            self.order.push_back(host.clone());
        }
        self.map.insert(
            host,
            DnsEntry {
                ip,
                at: Instant::now(),
            },
        );
        while self.order.len() > DNS_CACHE_CAP {
            if let Some(oldest) = self.order.pop_front() {
                self.map.remove(&oldest);
            }
        }
    }
}

static DNS_CACHE: LazyLock<Mutex<DnsCache>> = LazyLock::new(|| Mutex::new(DnsCache::default()));

fn dns_cache_lock() -> MutexGuard<'static, DnsCache> {
    DNS_CACHE.lock().unwrap_or_else(|p| p.into_inner())
}

/// The real resolver: std::net::ToSocketAddrs through the OS resolver,
/// first IPv4 answer preferred (the dotted-quad PAC helpers — isInNet and
/// friends — are IPv4-shaped; returning v6 first would make classic
/// scripts misfire), cached per DNS_TTL.
fn real_dns_resolve(host: &str) -> Option<String> {
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    // IPv6 literals may arrive bracketed from PAC scripts; ToSocketAddrs
    // wants the bare literal.
    let probe = host.trim_start_matches('[').trim_end_matches(']');
    if let Some(hit) = dns_cache_lock().lookup(probe) {
        return hit;
    }
    let addrs: Vec<std::net::SocketAddr> =
        match std::net::ToSocketAddrs::to_socket_addrs(&(probe, 0u16)) {
            Ok(iter) => iter.collect(),
            Err(_) => Vec::new(),
        };
    let picked = addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or_else(|| addrs.first())
        .map(|a| a.ip().to_string());
    dns_cache_lock().insert(probe.to_string(), picked.clone());
    picked
}

/// The real myIpAddress: the classic UDP "connect" trick — binding an
/// unconnected socket and connecting it to a public address makes the
/// kernel pick the default route's source address WITHOUT sending any
/// packet (connect on a UDP socket is a pure routing-table lookup). Falls
/// back to loopback, the same answer a disconnected machine would give.
fn real_my_ip() -> String {
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect(("8.8.8.8", 80)).is_ok() {
            if let Ok(local) = sock.local_addr() {
                return local.ip().to_string();
            }
        }
    }
    "127.0.0.1".to_string()
}

// ── Civil time (the PAC helpers' clock) ────────────────────────────────────

/// The calendar fields the date/time helpers compare against, split out of
/// chrono so the pure cores are table-testable without a live clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Civil {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    /// Days since Sunday, 0..6 — the PAC helper convention.
    weekday: u32,
}

impl Civil {
    /// The wall-clock the helpers read: UTC when the script passed the
    /// "GMT" flag, LOCAL time otherwise (exactly the Navigator contract).
    fn now(gmt: bool) -> Civil {
        let now = chrono::Local::now();
        let naive = if gmt {
            now.naive_utc()
        } else {
            now.naive_local()
        };
        Civil {
            year: naive.year(),
            month: naive.month(),
            day: naive.day(),
            hour: naive.hour(),
            minute: naive.minute(),
            second: naive.second(),
            weekday: naive.weekday().num_days_from_sunday(),
        }
    }
}

// ── Range tokens (dateRange / timeRange / weekdayRange inputs) ────────────

/// One already-coerced argument of a range helper. The JS bindings coerce
/// once (finite numbers to Num, month/day names to Str); the pure cores
/// then pattern-match the canonical Navigator signatures — table tests
/// build these by hand, no engine needed.
#[derive(Debug, Clone, PartialEq)]
enum RangeToken {
    Num(f64),
    Str(String),
}

impl RangeToken {
    fn as_int(&self) -> Option<i32> {
        match self {
            RangeToken::Num(n) if n.is_finite() => Some(*n as i32),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            RangeToken::Str(s) => Some(s),
            _ => None,
        }
    }
}

/// Splits a trailing "GMT" flag off the argument list, Navigator style.
/// Returns (remaining tokens, gmt?).
fn split_gmt(tokens: &[RangeToken]) -> (&[RangeToken], bool) {
    match tokens.last() {
        Some(RangeToken::Str(s)) if s.eq_ignore_ascii_case("GMT") => {
            (&tokens[..tokens.len() - 1], true)
        },
        _ => (tokens, false),
    }
}

const MONTHS: [(&str, u32); 12] = [
    ("JAN", 1),
    ("FEB", 2),
    ("MAR", 3),
    ("APR", 4),
    ("MAY", 5),
    ("JUN", 6),
    ("JUL", 7),
    ("AUG", 8),
    ("SEP", 9),
    ("OCT", 10),
    ("NOV", 11),
    ("DEC", 12),
];

fn parse_month_name(s: &str) -> Option<u32> {
    MONTHS
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(s))
        .map(|(_, m)| *m)
}

const WEEKDAYS: [(&str, u32); 7] = [
    ("SUN", 0),
    ("MON", 1),
    ("TUE", 2),
    ("WED", 3),
    ("THU", 4),
    ("FRI", 5),
    ("SAT", 6),
];

fn parse_weekday_name(s: &str) -> Option<u32> {
    WEEKDAYS
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(s))
        .map(|(_, w)| *w)
}

// ── dateRange ──────────────────────────────────────────────────────────────

/// One anchor of a dateRange. UNSPEC marks a field the signature does not
/// carry (the wildcard dimension).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DatePoint {
    day: i32,
    month: i32,
    year: i32,
}

const UNSPEC: i32 = -1;

fn date_point(day: i32, month: i32, year: i32) -> DatePoint {
    DatePoint { day, month, year }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DateMatch {
    Single(DatePoint),
    Range(DatePoint, DatePoint),
}

/// Parses the canonical dateRange signatures (GMT already stripped):
/// 1 = day; 2 = day..day OR day+month (the argument TYPES decide); 3 =
/// day+month+year; 4 = (d,m)..(d,m); 6 = (d,m,y)..(d,m,y). Anything else
/// (including a stray 5) is malformed usage -> None -> the helper answers
/// false.
fn parse_date_range(tokens: &[RangeToken]) -> Option<DateMatch> {
    match tokens.len() {
        1 => {
            let d = tokens[0].as_int()?;
            Some(DateMatch::Single(date_point(d, UNSPEC, UNSPEC)))
        },
        2 => {
            // Two numbers = a day-of-month range; a number plus a month
            // NAME = the single day+month form. The type difference is the
            // only thing separating the two signatures.
            match (tokens[0].as_int(), tokens[1].as_int()) {
                (Some(d1), Some(d2)) => Some(DateMatch::Range(
                    date_point(d1, UNSPEC, UNSPEC),
                    date_point(d2, UNSPEC, UNSPEC),
                )),
                (Some(d), None) => {
                    let m = parse_month_name(tokens[1].as_str()?)? as i32;
                    Some(DateMatch::Single(date_point(d, m, UNSPEC)))
                },
                _ => None,
            }
        },
        3 => {
            let d = tokens[0].as_int()?;
            let m = parse_month_name(tokens[1].as_str()?)? as i32;
            let y = tokens[2].as_int()?;
            Some(DateMatch::Single(date_point(d, m, y)))
        },
        4 => {
            let d1 = tokens[0].as_int()?;
            let m1 = parse_month_name(tokens[1].as_str()?)? as i32;
            let d2 = tokens[2].as_int()?;
            let m2 = parse_month_name(tokens[3].as_str()?)? as i32;
            Some(DateMatch::Range(
                date_point(d1, m1, UNSPEC),
                date_point(d2, m2, UNSPEC),
            ))
        },
        6 => {
            let d1 = tokens[0].as_int()?;
            let m1 = parse_month_name(tokens[1].as_str()?)? as i32;
            let y1 = tokens[2].as_int()?;
            let d2 = tokens[3].as_int()?;
            let m2 = parse_month_name(tokens[4].as_str()?)? as i32;
            let y2 = tokens[5].as_int()?;
            Some(DateMatch::Range(
                date_point(d1, m1, y1),
                date_point(d2, m2, y2),
            ))
        },
        _ => None,
    }
}

fn date_point_matches(p: &DatePoint, now: &Civil) -> bool {
    (p.day == UNSPEC || p.day == now.day as i32)
        && (p.month == UNSPEC || p.month == now.month as i32)
        && (p.year == UNSPEC || p.year == now.year)
}

/// Inclusive numeric range with wrap-around (DEC..FEB and 28..3 are legal
/// ranges that cross the boundary).
fn in_wrapped_range(value: i64, lo: i64, hi: i64) -> bool {
    if lo > hi {
        value >= lo || value <= hi
    } else {
        value >= lo && value <= hi
    }
}

fn date_range_matches(m: &DateMatch, now: &Civil) -> bool {
    match *m {
        DateMatch::Single(p) => date_point_matches(&p, now),
        DateMatch::Range(a, b) => {
            // Precision follows the fields the range ends carry; each
            // precision encodes to one number so ordering is well defined.
            if a.year != UNSPEC && b.year != UNSPEC {
                let v = |p: &DatePoint| {
                    (p.year as i64) * 10_000 + (p.month as i64) * 100 + p.day as i64
                };
                let now_v = (now.year as i64) * 10_000 + (now.month as i64) * 100 + now.day as i64;
                in_wrapped_range(now_v, v(&a), v(&b))
            } else if a.month != UNSPEC && b.month != UNSPEC {
                let v = |p: &DatePoint| (p.month as i64) * 100 + p.day as i64;
                let now_v = (now.month as i64) * 100 + now.day as i64;
                in_wrapped_range(now_v, v(&a), v(&b))
            } else {
                in_wrapped_range(now.day as i64, a.day as i64, b.day as i64)
            }
        },
    }
}

/// dateRange(...) pure core: now_local / now_utc are supplied by the
/// caller (the binding passes the live clocks, tests pass fixtures).
fn date_range(tokens: &[RangeToken], now_local: &Civil, now_utc: &Civil) -> bool {
    let (rest, gmt) = split_gmt(tokens);
    let Some(m) = parse_date_range(rest) else {
        return false;
    };
    date_range_matches(&m, if gmt { now_utc } else { now_local })
}

// ── timeRange ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimeMatch {
    /// timeRange(hour) — true for the whole hour.
    Hour(i32),
    /// h:m..h:m or h:m:s..h:m:s, encoded as seconds-of-day.
    Range(i64, i64),
}

/// Seconds-of-day for a range comparison; missing minutes/seconds are 0,
/// matching how the shorter forms behave in browser implementations.
fn time_seconds(h: i32, m: i32, s: i32) -> i64 {
    (h as i64) * 3600 + (m as i64) * 60 + s as i64
}

/// Parses the canonical timeRange signatures (GMT stripped): 1 = hour;
/// 2 = hour..hour; 4 = (h,m)..(h,m); 6 = (h,m,s)..(h,m,s). The odd 3/5
/// forms do not exist in the format (unlike dateRange's) -> false.
fn parse_time_range(tokens: &[RangeToken]) -> Option<TimeMatch> {
    let nums: Option<Vec<i32>> = tokens.iter().map(RangeToken::as_int).collect();
    let nums = nums?;
    match nums.len() {
        1 => Some(TimeMatch::Hour(nums[0])),
        2 => Some(TimeMatch::Range(
            time_seconds(nums[0], 0, 0),
            time_seconds(nums[1], 0, 0),
        )),
        4 => Some(TimeMatch::Range(
            time_seconds(nums[0], nums[1], 0),
            time_seconds(nums[2], nums[3], 0),
        )),
        6 => Some(TimeMatch::Range(
            time_seconds(nums[0], nums[1], nums[2]),
            time_seconds(nums[3], nums[4], nums[5]),
        )),
        _ => None,
    }
}

fn time_range_matches(m: &TimeMatch, now: &Civil) -> bool {
    match *m {
        TimeMatch::Hour(h) => now.hour as i32 == h,
        TimeMatch::Range(lo, hi) => {
            let now_s = (now.hour as i64) * 3600 + (now.minute as i64) * 60 + now.second as i64;
            in_wrapped_range(now_s, lo, hi)
        },
    }
}

fn time_range(tokens: &[RangeToken], now_local: &Civil, now_utc: &Civil) -> bool {
    let (rest, gmt) = split_gmt(tokens);
    let Some(m) = parse_time_range(rest) else {
        return false;
    };
    time_range_matches(&m, if gmt { now_utc } else { now_local })
}

// ── weekdayRange ───────────────────────────────────────────────────────────

/// weekdayRange(wd1, wd2 [, "GMT"]) — inclusive, wrap-around legal
/// (FRI..MON spans the weekend).
fn weekday_range(tokens: &[RangeToken], now_local: &Civil, now_utc: &Civil) -> bool {
    let (rest, gmt) = split_gmt(tokens);
    let Some(w1) = rest
        .first()
        .and_then(RangeToken::as_str)
        .and_then(parse_weekday_name)
    else {
        return false;
    };
    let Some(w2) = rest
        .get(1)
        .and_then(RangeToken::as_str)
        .and_then(parse_weekday_name)
    else {
        return false;
    };
    let now = if gmt { now_utc } else { now_local };
    in_wrapped_range(now.weekday as i64, w1 as i64, w2 as i64)
}

// ── Host helpers (pure cores) ──────────────────────────────────────────────

/// isPlainHostName: no domain part at all.
fn is_plain_hostname(host: &str) -> bool {
    !host.contains('.')
}

/// dnsDomainIs: host is INSIDE the domain — equal, or ends with the
/// domain at a label boundary. A domain written WITH its leading dot
/// (".example.com") carries the boundary itself, so every spelling real
/// scripts use \u2014 dnsDomainIs(host, ".example.com") AND
/// dnsDomainIs(host, "example.com") \u2014 matches www.example.com while
/// notexample.com matches neither.
fn dns_domain_is(host: &str, domain: &str) -> bool {
    if domain.is_empty() {
        return false;
    }
    let host = host.to_ascii_lowercase();
    let domain = domain.to_ascii_lowercase();
    host.len() >= domain.len()
        && host.ends_with(&domain)
        && (host.len() == domain.len()
            || domain.starts_with('.')
            || host.as_bytes().get(host.len() - domain.len() - 1) == Some(&b'.'))
}

/// localHostOrDomainIs: exact match, OR the host is the bare machine name
/// (no dots) that the qualified form starts with — so intranet scripts can
/// say localHostOrDomainIs(host, "www.intranet.example") and hit for both
/// "www.intranet.example" and plain "www".
fn local_host_or_domain_is(host: &str, hostdom: &str) -> bool {
    host.eq_ignore_ascii_case(hostdom)
        || (!host.contains('.')
            && hostdom.len() >= host.len()
            && hostdom[..host.len()].eq_ignore_ascii_case(host))
}

/// dnsDomainLevels: number of dots — the cheap intranet-vs-internet split.
fn dns_domain_levels(host: &str) -> u32 {
    host.matches('.').count() as u32
}

/// shExpMatch: shell-expression match with * (any run), ? (any one
/// character) and [set] / [^set] classes. Case-sensitive, like the browser
/// implementations — PAC scripts write their patterns in the case they
/// expect the URL to carry.
fn sh_exp_match(text: &str, pattern: &str) -> bool {
    let t: Vec<char> = text.chars().collect();
    let p: Vec<char> = pattern.chars().collect();
    sh_match(&t, &p)
}

/// Iterative glob with one-star backtracking (the classic matcher: every
/// position after a star is remembered, so a*b*c stays linear-ish and
/// pathological patterns still terminate).
fn sh_match(text: &[char], pattern: &[char]) -> bool {
    let (mut ti, mut pi) = (0usize, 0usize);
    let (mut star_pi, mut star_ti) = (usize::MAX, 0usize);
    while ti < text.len() {
        if pi < pattern.len() {
            match pattern[pi] {
                '*' => {
                    star_pi = pi;
                    star_ti = ti;
                    pi += 1;
                    continue;
                },
                '?' => {
                    ti += 1;
                    pi += 1;
                    continue;
                },
                '[' => {
                    if let Some(consumed) = class_matches(&pattern[pi..], text[ti]) {
                        ti += 1;
                        pi += consumed;
                        continue;
                    }
                },
                c if c == text[ti] => {
                    ti += 1;
                    pi += 1;
                    continue;
                },
                _ => {},
            }
        }
        // Mismatch: if we ever saw a star, retry it having swallowed one
        // more character; otherwise the pattern is exhausted.
        if star_pi == usize::MAX {
            return false;
        }
        pi = star_pi + 1;
        star_ti += 1;
        ti = star_ti;
    }
    // Text consumed: only trailing stars can remain in the pattern.
    pattern[pi..].iter().all(|&c| c == '*')
}

/// Matches [...] / [^...] against c; returns how many pattern chars the
/// class consumed (None = no match, fall through to backtracking).
fn class_matches(pattern: &[char], c: char) -> Option<usize> {
    debug_assert_eq!(pattern[0], '[');
    let close = pattern[1..].iter().position(|&x| x == ']')? + 1;
    let body = &pattern[1..close];
    let (negated, body) = match body.first() {
        Some('^') => (true, &body[1..]),
        _ => (false, body),
    };
    let mut hit = false;
    let mut i = 0;
    while i < body.len() {
        if i + 2 < body.len() && body[i + 1] == '-' {
            if c >= body[i] && c <= body[i + 2] {
                hit = true;
            }
            i += 3;
        } else {
            if c == body[i] {
                hit = true;
            }
            i += 1;
        }
    }
    (hit != negated).then_some(close + 1)
}

// ── isInNet / isInNetEx ────────────────────────────────────────────────────

/// Dotted-quad to u32, big-endian (network order as written).
fn parse_ipv4(s: &str) -> Option<u32> {
    s.trim().parse::<std::net::Ipv4Addr>().ok().map(u32::from)
}

/// isInNet(ip, pattern, mask): all three dotted quads, compared masked.
/// The classic scripts' workhorse: isInNet(host, "10.0.0.0", "255.0.0.0").
fn is_in_net(ip: &str, pattern: &str, mask: &str) -> bool {
    let (ip, pat, mask) = (parse_ipv4(ip), parse_ipv4(pattern), parse_ipv4(mask));
    match (ip, pat, mask) {
        (Some(ip), Some(pat), Some(mask)) => ip & mask == pat & mask,
        _ => false,
    }
}

/// isInNetEx(ip, prefix): the modern CIDR form ("198.51.100.0/24"). A bare
/// address means /32; prefix 0 matches everything; non-IPv4 input (v6
/// literals, garbage) answers false — the Ex helpers postdate the
/// IPv4-only core and scripts rarely feed them anything else.
fn is_in_net_ex(ip: &str, prefix: &str) -> bool {
    let prefix = prefix.trim();
    let (addr, len) = match prefix.split_once('/') {
        Some((a, l)) => match l.trim().parse::<u32>() {
            Ok(l) if l <= 32 => (a, l),
            _ => return false,
        },
        None => (prefix, 32),
    };
    // A zero-length prefix matches everything before the (possibly
    // garbage) address is even parsed — scripts use 0.0.0.0/0 as
    // "always".
    if len == 0 {
        return true;
    }
    let (Some(ip), Some(net)) = (parse_ipv4(ip), parse_ipv4(addr)) else {
        return false;
    };
    let mask = u32::MAX << (32 - len);
    ip & mask == net & mask
}

// ── JS bindings ────────────────────────────────────────────────────────────

/// Pulls argument index as a JS-coerced string (undefined stringifies, so
/// omitted args degrade the same way they would inside a JS expression).
fn js_arg_string(args: &[JsValue], index: usize, context: &mut Context) -> JsResult<String> {
    Ok(args
        .get_or_undefined(index)
        .to_string(context)?
        .to_std_string_escaped())
}

/// Coerces the full argument list into RangeTokens: finite numbers stay
/// numeric, everything else (month/day names, junk) becomes a string.
fn js_range_tokens(args: &[JsValue], context: &mut Context) -> JsResult<Vec<RangeToken>> {
    let mut out = Vec::with_capacity(args.len());
    for value in args {
        let n = value.to_number(context).unwrap_or(f64::NAN);
        if n.is_finite() {
            out.push(RangeToken::Num(n));
        } else {
            out.push(RangeToken::Str(
                value.to_string(context)?.to_std_string_escaped(),
            ));
        }
    }
    Ok(out)
}

/// Registers one boolean-returning helper. The helper closure must stay
/// Copy (it is captured by value inside the wrapper, which
/// from_copy_closure requires) \u2014 in practice it captures only the
/// Copy resolver fn pointers, keeping the whole path unsafe-free.
fn register_bool(
    context: &mut Context,
    name: &'static str,
    len: usize,
    f: impl Fn(&[JsValue], &mut Context) -> JsResult<bool> + Copy + 'static,
) -> JsResult<()> {
    let wrapper = move |_this: &JsValue, args: &[JsValue], context: &mut Context| {
        Ok(JsValue::from(f(args, context)?))
    };
    context.register_global_callable(
        js_string!(name),
        len,
        NativeFunction::from_copy_closure(wrapper),
    )
}

/// Registers every PAC helper binding on the context, wired to the given
/// resolver/my-ip providers. Called with the REAL providers on the
/// evaluator thread and fixture providers in tests.
fn register_pac_helpers(context: &mut Context, dns: DnsResolveFn, my_ip: MyIpFn) -> JsResult<()> {
    register_bool(context, "isPlainHostName", 1, |args, context| {
        Ok(is_plain_hostname(&js_arg_string(args, 0, context)?))
    })?;
    register_bool(context, "dnsDomainIs", 2, |args, context| {
        let host = js_arg_string(args, 0, context)?;
        let domain = js_arg_string(args, 1, context)?;
        Ok(dns_domain_is(&host, &domain))
    })?;
    register_bool(context, "localHostOrDomainIs", 2, |args, context| {
        let host = js_arg_string(args, 0, context)?;
        let hostdom = js_arg_string(args, 1, context)?;
        Ok(local_host_or_domain_is(&host, &hostdom))
    })?;
    // move: own the (Copy) resolver fn pointer so the closure stays Copy
    // and 'static \u2014 the default borrow would not outlive this function.
    register_bool(context, "isResolvable", 1, move |args, context| {
        Ok(dns(&js_arg_string(args, 0, context)?).is_some())
    })?;
    // The Ex flavor differs only in tolerating bracketed IPv6 literals;
    // the resolver strips those itself, so one body serves both.
    register_bool(context, "isResolvableEx", 1, move |args, context| {
        Ok(dns(&js_arg_string(args, 0, context)?).is_some())
    })?;
    // dnsDomainLevels returns a NUMBER (the dot count), not a bool, so
    // it registers directly like the string helpers below.
    context.register_global_callable(
        js_string!("dnsDomainLevels"),
        1,
        NativeFunction::from_copy_closure(move |_this, args, context| {
            let levels = dns_domain_levels(&js_arg_string(args, 0, context)?);
            Ok(JsValue::from(f64::from(levels)))
        }),
    )?;
    register_bool(context, "shExpMatch", 2, |args, context| {
        let text = js_arg_string(args, 0, context)?;
        let pattern = js_arg_string(args, 1, context)?;
        Ok(sh_exp_match(&text, &pattern))
    })?;
    register_bool(context, "isInNet", 3, |args, context| {
        let ip = js_arg_string(args, 0, context)?;
        let pattern = js_arg_string(args, 1, context)?;
        let mask = js_arg_string(args, 2, context)?;
        Ok(is_in_net(&ip, &pattern, &mask))
    })?;
    register_bool(context, "isInNetEx", 2, |args, context| {
        let ip = js_arg_string(args, 0, context)?;
        let prefix = js_arg_string(args, 1, context)?;
        Ok(is_in_net_ex(&ip, &prefix))
    })?;
    register_bool(context, "dateRange", 6, |args, context| {
        let tokens = js_range_tokens(args, context)?;
        Ok(date_range(&tokens, &Civil::now(false), &Civil::now(true)))
    })?;
    register_bool(context, "timeRange", 6, |args, context| {
        let tokens = js_range_tokens(args, context)?;
        Ok(time_range(&tokens, &Civil::now(false), &Civil::now(true)))
    })?;
    register_bool(context, "weekdayRange", 3, |args, context| {
        let tokens = js_range_tokens(args, context)?;
        Ok(weekday_range(
            &tokens,
            &Civil::now(false),
            &Civil::now(true),
        ))
    })?;

    // String-valued helpers: dnsResolve answers "" on failure (the
    // Chromium PAC convention — scripts compare against "" / feed it to
    // isInNet, both degrade sanely), myIpAddress always answers something.
    context.register_global_callable(
        js_string!("dnsResolve"),
        1,
        NativeFunction::from_copy_closure(move |_this, args, context| {
            let host = js_arg_string(args, 0, context)?;
            Ok(JsValue::from(JsString::from(
                dns(&host).unwrap_or_default(),
            )))
        }),
    )?;
    context.register_global_callable(
        js_string!("myIpAddress"),
        0,
        NativeFunction::from_copy_closure(move |_this, _args, _context| {
            Ok(JsValue::from(JsString::from(my_ip())))
        }),
    )?;
    Ok(())
}

// ── The evaluator thread ───────────────────────────────────────────────────

/// Messages the evaluator thread answers. Everything is owned data — the
/// thread keeps the !Send boa Context to itself for its whole life.
enum EvalMsg {
    /// Compile + run a script and surface FindProxyForURL; the reply tells
    /// whether it loaded (the refresh maps that onto the status).
    Load { script: String, reply: Sender<bool> },
    /// One evaluation; the reply carries the RAW result list (None on
    /// error / nothing loaded), not yet parsed into routes.
    Resolve {
        url: String,
        host: String,
        reply: Sender<Option<String>>,
    },
}

/// Clone-able handle to the evaluator thread (mpsc Sender is Clone).
#[derive(Clone, Debug)]
struct EvalHandle {
    tx: Sender<EvalMsg>,
}

/// The per-script evaluation state, owned by the evaluator thread only
/// (tests build their own on the test thread — same single-thread rule).
struct EvalState {
    /// The FindProxyForURL function object, extracted at load time —
    /// missing/not-callable is a LOAD failure, not a per-request error.
    func: JsObject,
    context: Context,
}

impl EvalState {
    /// Builds a context with the helper surface + the script evaluated,
    /// picking the FindProxyForURL function out of the global object.
    fn build(script: &str, dns: DnsResolveFn, my_ip: MyIpFn) -> anyhow::Result<EvalState> {
        let mut context = Context::default();
        register_pac_helpers(&mut context, dns, my_ip)
            .map_err(|e| anyhow!("register PAC helpers: {e}"))?;
        context
            .eval(Source::from_bytes(script))
            .map_err(|e| anyhow!("evaluate PAC script: {e}"))?;
        let func = context
            .global_object()
            .get(js_string!("FindProxyForURL"), &mut context)
            .map_err(|e| anyhow!("read FindProxyForURL: {e}"))?;
        let func = func
            .as_callable()
            .ok_or_else(|| anyhow!("PAC script defines no callable FindProxyForURL"))?;
        Ok(EvalState { func, context })
    }

    /// One evaluation. Any engine error degrades to None (direct) after a
    /// warn — the request must go somewhere.
    fn resolve(&mut self, url: &str, host: &str) -> Option<String> {
        let args = [
            JsValue::from(JsString::from(url)),
            JsValue::from(JsString::from(host)),
        ];
        match self
            .func
            .call(&JsValue::undefined(), &args, &mut self.context)
        {
            Ok(value) => match value.to_string(&mut self.context) {
                Ok(s) => Some(s.to_std_string_escaped()),
                Err(e) => {
                    tracing::warn!("pac: FindProxyForURL({host}) result not a string: {e}");
                    None
                },
            },
            Err(e) => {
                tracing::warn!("pac: FindProxyForURL({host}) threw: {e}");
                None
            },
        }
    }
}

fn spawn_evaluator() -> EvalHandle {
    let (tx, rx) = std::sync::mpsc::channel::<EvalMsg>();
    let spawned = std::thread::Builder::new()
        .name("wowsp-pac-eval".to_string())
        .spawn(move || evaluator_loop(rx));
    if let Err(e) = spawned {
        // Thread spawn failing is as fatal as the channel dying — report
        // through the same warn and let callers degrade to direct.
        tracing::warn!("pac: cannot spawn evaluator thread: {e}");
    }
    EvalHandle { tx }
}

fn evaluator_loop(rx: Receiver<EvalMsg>) {
    // The Context is born here and dies here — one thread, one engine, no
    // Send gymnastics.
    let mut state: Option<EvalState> = None;
    while let Ok(msg) = rx.recv() {
        match msg {
            EvalMsg::Load { script, reply } => {
                let ok = match EvalState::build(&script, real_dns_resolve, real_my_ip) {
                    Ok(s) => {
                        state = Some(s);
                        true
                    },
                    Err(e) => {
                        tracing::warn!("pac: script failed to load: {e}");
                        state = None;
                        false
                    },
                };
                let _ = reply.send(ok);
            },
            EvalMsg::Resolve { url, host, reply } => {
                let out = state.as_mut().and_then(|s| s.resolve(&url, &host));
                let _ = reply.send(out);
            },
        }
    }
}

// ── The shared engine state ────────────────────────────────────────────────

/// The script currently loaded (or last loaded) by the engine.
#[derive(Debug, Clone)]
struct PacScript {
    /// The URL it came from — a config URL change invalidates it even if
    /// the body were identical.
    url: String,
    body: String,
    fetched_at: Instant,
}

/// The outcome of the last refresh attempt — drives the shorter failed
/// retry window AND distinguishes "loaded 1 min ago" from "failed 1 min
/// ago" when both a script and a newer attempt exist.
#[derive(Debug, Clone)]
struct Attempt {
    url: String,
    at: Instant,
    ok: bool,
}

/// Everything the PAC engine knows, behind one mutex (same degrade-on-
/// poison stance as the other registries: into_inner() and carry on).
#[derive(Debug, Default)]
struct PacEngine {
    /// The AutoConfigURL as of the last refresh attempt (None until the
    /// first one) — a changed value forces a refetch.
    seen_url: Option<String>,
    script: Option<PacScript>,
    attempt: Option<Attempt>,
    /// Set after the FIRST attempt; before that, a configured host reads
    /// as Unavailable (see engine_status_for).
    status: Option<PacStatus>,
    /// host -> resolved route (None = DIRECT), FIFO-evicted.
    cache: HashMap<String, Option<String>>,
    cache_order: VecDeque<String>,
    evaluator: Option<EvalHandle>,
}

static ENGINE: LazyLock<Mutex<PacEngine>> = LazyLock::new(|| Mutex::new(PacEngine::default()));

fn engine_lock() -> MutexGuard<'static, PacEngine> {
    ENGINE.lock().unwrap_or_else(|p| p.into_inner())
}

impl PacEngine {
    /// The cheap staleness check the builder hot path runs (sync, no
    /// fetch): a refetch is due when the URL moved, no usable script
    /// exists, the success TTL elapsed, or a failure's retry window
    /// elapsed. The engine lock is held; this must stay pure.
    fn needs_refresh(&self, configured: Option<&str>) -> bool {
        let Some(url) = configured else {
            return false; // nothing configured — nothing to fetch
        };
        if self.seen_url.as_deref() != Some(url) {
            return true;
        }
        match &self.script {
            Some(s) if s.url == url => {
                // The NEWEST attempt governs: a failure inside the retry
                // window keeps quiet (even past the success TTL — we just
                // tried and the PAC host said no; hammering it per client
                // build helps nobody), an older failure is due now, and a
                // success defers to the script's age.
                match &self.attempt {
                    Some(a) if !a.ok => a.at.elapsed() > FAILED_RETRY_TTL,
                    _ => s.fetched_at.elapsed() > SCRIPT_TTL,
                }
            },
            _ => {
                // No usable script for this URL yet. A failed attempt on
                // THIS url inside the retry window keeps quiet; anything
                // else (never attempted, older failure) goes now.
                !matches!(
                    &self.attempt,
                    Some(a) if !a.ok && a.url == url && a.at.elapsed() <= FAILED_RETRY_TTL
                )
            },
        }
    }

    /// Drops the whole script/eval side (config removed, fresh start).
    fn reset(&mut self) {
        *self = PacEngine::default();
    }

    fn cache_insert(&mut self, host: String, route: Option<String>) {
        if !self.cache.contains_key(&host) {
            self.cache_order.push_back(host.clone());
        }
        self.cache.insert(host, route);
        while self.cache_order.len() > HOST_CACHE_CAP {
            if let Some(oldest) = self.cache_order.pop_front() {
                self.cache.remove(&oldest);
            }
        }
    }
}

/// The status view the diagnostics IPC serves: None when nothing is
/// configured; otherwise the engine's knowledge FOR THIS URL — a pending
/// or failed attempt for a different/new URL reads as Unavailable, never
/// as a stale "loaded". Pure read, no fetch (the probe refreshes before
/// it reports; settings reads show the last known truth).
pub(crate) fn engine_status_for(configured: Option<&str>) -> Option<PacStatus> {
    let url = configured?;
    let e = engine_lock();
    Some(match (&e.status, &e.seen_url) {
        (Some(status), Some(seen)) if seen == url => *status,
        _ => PacStatus::Unavailable,
    })
}

/// The IPC string form ("loaded" / "unavailable"), None when not
/// configured — the exact pacStatus contract.
pub(crate) fn status_string_for(configured: Option<&str>) -> Option<&'static str> {
    engine_status_for(configured).map(PacStatus::wire)
}

/// Cheap sync staleness check for the client-builder hot path: true when a
/// PAC script is configured AND the engine is empty/stale for it (the
/// caller then kicks a background refresh). One registry read + one short
/// lock.
pub(crate) fn is_stale_or_empty() -> bool {
    let configured = configured_url();
    let Some(url) = &configured else {
        return false;
    };
    engine_lock().needs_refresh(Some(url))
}

// ── Refresh (async) + kick (sync trigger) ──────────────────────────────────

/// Set while a refresh is in flight; swap-guarded so the builder hot path
/// (which fires on every client build) cannot pile up concurrent fetches
/// of the same script.
static REFRESH_INFLIGHT: AtomicBool = AtomicBool::new(false);

/// Clears the in-flight flag on drop — including when the spawned task's
/// future is dropped by a dying runtime, which a plain store(false) at the
/// end of the future would miss.
struct InflightGuard;

impl Drop for InflightGuard {
    fn drop(&mut self) {
        REFRESH_INFLIGHT.store(false, Ordering::Release);
    }
}

/// Awaited refresh — network_probe calls this so the diagnostics report
/// reflects a freshly-decided channel instead of last-boot knowledge.
/// Deduped against the kick path through the same flag: if a refresh is
/// already running, this returns immediately.
pub(crate) async fn refresh_if_stale() {
    if REFRESH_INFLIGHT.swap(true, Ordering::AcqRel) {
        return; // someone else is fetching; their result lands shortly
    }
    let _guard = InflightGuard;
    refresh_inner().await;
}

/// Non-blocking trigger for sync contexts (http_builder_for cannot
/// await): spawns the refresh on the current runtime when one exists;
/// without a runtime there is nothing to refresh on, so the flag is
/// released and the next builder attempt re-kicks.
pub(crate) fn kick_refresh() {
    if REFRESH_INFLIGHT.swap(true, Ordering::AcqRel) {
        return;
    }
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(async move {
                // The guard clears the flag when the task ends — including
                // when a dying runtime drops the future mid-refresh.
                let _guard = InflightGuard;
                refresh_inner().await;
            });
        },
        Err(_) => {
            REFRESH_INFLIGHT.store(false, Ordering::Release);
        },
    }
}

/// The one fetch-and-apply path both entry points share. Never holds the
/// engine lock across the await; a poisoned/dead evaluator degrades to
/// Unavailable + warn, exactly like every other failure here.
async fn refresh_inner() {
    let configured = configured_url();
    let Some(url) = configured.clone() else {
        // Unconfigured: drop any lingering script so the IPC reads
        // pacStatus: null and no dead engine state survives.
        let mut e = engine_lock();
        if e.seen_url.is_some() || e.script.is_some() || e.status.is_some() {
            tracing::info!("pac: AutoConfigURL removed, engine reset");
            e.reset();
        }
        return;
    };

    // Only http(s) bootstrap URLs are fetchable; file:// and empty-scheme
    // values (and WPAD's discovery, which we never attempt) land here.
    let scheme_ok = {
        let lower = url.to_ascii_lowercase();
        lower.starts_with("http://") || lower.starts_with("https://")
    };

    let outcome: anyhow::Result<String> = async {
        if !scheme_ok {
            return Err(anyhow!(
                "unsupported AutoConfigURL scheme (only http/https fetchable)"
            ));
        }
        // Deliberately DIRECT: the bootstrap must not ride the proxy it is
        // discovering (and when a previous PAC is in effect, riding it
        // would loop on a misconfigured proxy).
        let client = build_direct_http_client()?;
        let resp = client
            .get(&url)
            .timeout(FETCH_TIMEOUT)
            .send()
            .await
            .map_err(|e| anyhow!("fetch: {e}"))?;
        let resp = resp
            .error_for_status()
            .map_err(|e| anyhow!("status: {e}"))?;
        let bytes = resp.bytes().await.map_err(|e| anyhow!("body: {e}"))?;
        if bytes.len() > MAX_SCRIPT_BYTES {
            return Err(anyhow!("script too large: {} bytes", bytes.len()));
        }
        String::from_utf8(bytes.to_vec()).map_err(|e| anyhow!("utf8: {e}"))
    }
    .await;

    {
        let mut e = engine_lock();
        e.seen_url = Some(url.clone());
        e.attempt = Some(Attempt {
            url: url.clone(),
            at: Instant::now(),
            ok: outcome.is_ok(),
        });
    }
    let body = match outcome {
        Ok(body) => body,
        Err(reason) => {
            tracing::warn!("pac: AutoConfigURL {url} unavailable: {reason}");
            engine_lock().status = Some(PacStatus::Unavailable);
            return;
        },
    };

    let mut e = engine_lock();
    // Identical body from the same URL: the running evaluation stays
    // valid; only the freshness timestamp moves. Anything else resets the
    // eval state (spec: script change -> fresh evaluation) and the
    // per-host cache, whose entries describe the OLD script's answers.
    let unchanged = e
        .script
        .as_ref()
        .is_some_and(|s| s.url == url && s.body == body);
    if unchanged {
        if let Some(s) = e.script.as_mut() {
            s.fetched_at = Instant::now();
        }
        e.status = Some(PacStatus::Loaded);
        return;
    }
    // Load into the evaluator (reusing the thread, respawning it if the
    // channel died) and wait for the ack so the status reflects the REAL
    // compile outcome, not optimism.
    let handle = e.evaluator.get_or_insert_with(spawn_evaluator);
    let (ack_tx, ack_rx) = std::sync::mpsc::channel();
    let mut ack = handle
        .tx
        .send(EvalMsg::Load {
            script: body.clone(),
            reply: ack_tx,
        })
        .is_ok()
        .then(|| ack_rx.recv_timeout(LOAD_BUDGET).ok())
        .flatten();
    if ack.is_none() {
        // The evaluator thread died (panic) or wedged past the budget:
        // respawn once so one bad script does not poison every later one.
        tracing::warn!("pac: evaluator thread unresponsive, respawning");
        let fresh = spawn_evaluator();
        let (ack_tx, ack_rx) = std::sync::mpsc::channel();
        ack = fresh
            .tx
            .send(EvalMsg::Load {
                script: body.clone(),
                reply: ack_tx,
            })
            .is_ok()
            .then(|| ack_rx.recv_timeout(LOAD_BUDGET).ok())
            .flatten();
        e.evaluator = Some(fresh);
    }
    e.cache.clear();
    e.cache_order.clear();
    e.script = Some(PacScript {
        url,
        body,
        fetched_at: Instant::now(),
    });
    e.status = Some(match ack {
        Some(true) => PacStatus::Loaded,
        _ => PacStatus::Unavailable,
    });
}

// ── Per-request resolution ────────────────────────────────────────────────

/// Parses a FindProxyForURL result list into the route the downloader
/// uses: PROXY host:port -> http://host:port, SOCKS/SOCKS5 host:port ->
/// socks5://host:port, DIRECT -> None. Entries are semicolon-separated;
/// the FIRST usable one wins (malformed entries are skipped, not fatal);
/// nothing usable (or an empty list) means direct.
fn parse_proxy_result(raw: &str) -> Option<String> {
    for entry in raw.split(';') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let (keyword, rest) = match entry.split_once(char::is_whitespace) {
            Some((k, r)) => (k, r.trim()),
            None => (entry, ""),
        };
        match keyword.to_ascii_uppercase().as_str() {
            "DIRECT" => return None,
            "PROXY" | "SOCKS" | "SOCKS5" => {
                if plausible_proxy_addr(rest) {
                    let scheme = if keyword.eq_ignore_ascii_case("PROXY") {
                        "http"
                    } else {
                        "socks5"
                    };
                    return Some(format!("{scheme}://{rest}"));
                }
                // Unusable entry — keep scanning the list.
                tracing::warn!("pac: skipping malformed {keyword} entry {rest:?}");
            },
            other => {
                tracing::warn!("pac: unknown result keyword {other:?}");
            },
        }
    }
    None
}

/// Loose usability check for a proxy host:port — non-empty, whitespace
/// free, optional numeric port. A missing port is fine (URL defaults: 80
/// for http, 1080 applied by reqwest for socks5).
fn plausible_proxy_addr(addr: &str) -> bool {
    if addr.is_empty() || addr.chars().any(char::is_whitespace) {
        return false;
    }
    match addr.rsplit_once(':') {
        Some((host, port)) => {
            !host.is_empty()
                && !port.is_empty()
                && port.chars().all(|c| c.is_ascii_digit())
                && port.parse::<u16>().is_ok()
        },
        None => true,
    }
}

/// The sync per-request entry point the reqwest Proxy::custom closure
/// calls: evaluate FindProxyForURL(url, host) and hand back the chosen
/// proxy URL (None = DIRECT). Cache-first per host; evaluation errors and
/// budget timeouts return None WITHOUT caching (a transient engine hiccup
/// must not pin a host to direct until the next script change).
pub(crate) fn resolve_for_url(url: &reqwest::Url) -> Option<String> {
    let host = url.host_str()?.trim().to_string();
    if host.is_empty() {
        return None;
    }
    {
        let e = engine_lock();
        if let Some(hit) = e.cache.get(&host) {
            return hit.clone();
        }
    }
    let handle = {
        let e = engine_lock();
        if e.status != Some(PacStatus::Loaded) {
            return None; // nothing loaded: direct, and no cache entry either
        }
        e.evaluator.clone()
    };
    let handle = handle?;
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    if handle
        .tx
        .send(EvalMsg::Resolve {
            url: url.to_string(),
            host: host.clone(),
            reply: reply_tx,
        })
        .is_err()
    {
        tracing::warn!("pac: evaluator unreachable for {host}, going direct");
        return None;
    }
    let raw = match reply_rx.recv_timeout(RESOLVE_BUDGET) {
        Ok(raw) => raw,
        Err(_) => {
            tracing::warn!(
                "pac: FindProxyForURL({host}) exceeded its evaluation budget, going direct"
            );
            return None;
        },
    };
    let Some(raw) = raw else {
        // Evaluation error — the thread already warned; degrade direct.
        return None;
    };
    let route = parse_proxy_result(&raw);
    let mut e = engine_lock();
    e.cache_insert(host, route.clone());
    route
}

// ── The reqwest proxy object ───────────────────────────────────────────────

// (The loopback/private bypass list lives in network.rs as
// PROXY_BYPASS_LIST — single-sourced so the fixed arm and the PAC
// closure cannot drift.)

/// True when the request target is loopback/private and must go direct
/// regardless of what the PAC says. String-level parsing because the url
/// crate is not a direct dependency — Url::host_str is all reqwest hands
/// us, and std's IpAddr parsers cover the rest.
fn local_or_private_target(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return true; // no host (odd scheme): do not proxy what we cannot see
    };
    let host = host.trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return ip.is_loopback() || ip.is_private() || ip.is_link_local();
    }
    if let Ok(ip) = host.parse::<std::net::Ipv6Addr>() {
        let seg = ip.segments();
        // Loopback ::1, link-local fe80::/10, unique-local fc00::/7.
        return ip.is_loopback() || (seg[0] & 0xffc0) == 0xfe80 || (seg[0] & 0xfe00) == 0xfc00;
    }
    false
}

/// The PAC-driven reqwest::Proxy the system channel installs. The closure
/// is the ONLY decision point reqwest sees: returning None means direct
/// for that request.
///
/// Verified against the vendored reqwest 0.13.1 source (src/proxy.rs):
/// Proxy::no_proxy(...) stores the list on the Custom intercept, but
/// Custom::call NEVER consults it — for custom intercepts the field is
/// dead config. The closure therefore does the loopback/private bypass
/// itself; the belt-and-braces .no_proxy(...) below is kept for parity
/// with the fixed-proxy arm and costs nothing.
pub(crate) fn pac_proxy() -> anyhow::Result<reqwest::Proxy> {
    let proxy = reqwest::Proxy::custom(|url| {
        if local_or_private_target(url) {
            return None;
        }
        resolve_for_url(url)
    });
    Ok(proxy.no_proxy(reqwest::NoProxy::from_string(
        crate::commands::network::PROXY_BYPASS_LIST,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixture resolvers — the injectable fn-pointer surface's whole point.
    fn fake_dns(host: &str) -> Option<String> {
        match host {
            "intranet.example" => Some("10.0.0.7".to_string()),
            "public.example" => Some("198.51.100.9".to_string()),
            "www.public.example" => Some("198.51.100.9".to_string()),
            "v6.example" => Some("2001:db8::1".to_string()),
            _ => None,
        }
    }

    fn fake_my_ip() -> String {
        "192.0.2.42".to_string()
    }

    fn civil(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32, wd: u32) -> Civil {
        Civil {
            year: y,
            month: mo,
            day: d,
            hour: h,
            minute: mi,
            second: s,
            weekday: wd,
        }
    }

    fn num(n: f64) -> RangeToken {
        RangeToken::Num(n)
    }

    fn str_t(s: &str) -> RangeToken {
        RangeToken::Str(s.to_string())
    }

    // ── parse_proxy_result table ──────────────────────────────────────

    #[test]
    fn proxy_result_table() {
        // The three canonical entries.
        assert_eq!(parse_proxy_result("DIRECT"), None);
        assert_eq!(
            parse_proxy_result("PROXY 192.0.2.1:8080"),
            Some("http://192.0.2.1:8080".to_string())
        );
        assert_eq!(
            parse_proxy_result("SOCKS 192.0.2.2:1080"),
            Some("socks5://192.0.2.2:1080".to_string())
        );
        // MS-style SOCKS5 keyword routes the same way.
        assert_eq!(
            parse_proxy_result("SOCKS5 192.0.2.3:1080"),
            Some("socks5://192.0.2.3:1080".to_string())
        );
        // First usable entry wins.
        assert_eq!(
            parse_proxy_result("PROXY 192.0.2.1:8080; PROXY 192.0.2.2:8080; DIRECT"),
            Some("http://192.0.2.1:8080".to_string())
        );
        assert_eq!(
            parse_proxy_result("DIRECT; PROXY 192.0.2.1:8080"),
            None,
            "DIRECT first ends the scan"
        );
        // Malformed entries are skipped, not fatal.
        assert_eq!(
            parse_proxy_result("GARBAGE 1.2.3.4; PROXY 192.0.2.1:8080"),
            Some("http://192.0.2.1:8080".to_string())
        );
        assert_eq!(
            parse_proxy_result("PROXY not a host; DIRECT"),
            None,
            "whitespace-broken addr falls through to DIRECT"
        );
        assert_eq!(
            parse_proxy_result("PROXY host:99999; PROXY 192.0.2.1:8080"),
            Some("http://192.0.2.1:8080".to_string()),
            "out-of-range port skipped"
        );
        // Empty / whitespace-only lists are direct.
        assert_eq!(parse_proxy_result(""), None);
        assert_eq!(parse_proxy_result(" ;  ;"), None);
        // Case-insensitive keywords, free-form spacing.
        assert_eq!(parse_proxy_result("direct"), None);
        assert_eq!(
            parse_proxy_result("  proxy 192.0.2.1:3128 "),
            Some("http://192.0.2.1:3128".to_string())
        );
    }

    // ── Host helper cores ─────────────────────────────────────────────

    #[test]
    fn plain_host_and_domain_level_table() {
        assert!(is_plain_hostname("www"));
        assert!(!is_plain_hostname("www.example.com"));
        assert_eq!(dns_domain_levels("www"), 0);
        assert_eq!(dns_domain_levels("www.example.com"), 2);
        assert_eq!(dns_domain_levels(""), 0);
    }

    #[test]
    fn dns_domain_is_table() {
        assert!(dns_domain_is("www.example.com", ".example.com"));
        assert!(dns_domain_is("www.example.com", "example.com"));
        assert!(dns_domain_is("example.com", "example.com"));
        assert!(
            !dns_domain_is("notexample.com", "example.com"),
            "boundary dot required"
        );
        assert!(!dns_domain_is("example.com.other", "example.com"));
        assert!(!dns_domain_is("www.example.com", "EXAMPLE.org"));
        assert!(
            dns_domain_is("WWW.EXAMPLE.COM", "example.com"),
            "case-insensitive"
        );
        assert!(!dns_domain_is("anything", ""));
    }

    #[test]
    fn local_host_or_domain_is_table() {
        assert!(local_host_or_domain_is(
            "www.intranet.example",
            "www.intranet.example"
        ));
        assert!(
            local_host_or_domain_is("www", "www.intranet.example"),
            "bare name prefix matches"
        );
        assert!(!local_host_or_domain_is("other", "www.intranet.example"));
        assert!(!local_host_or_domain_is(
            "www.other.example",
            "www.intranet.example"
        ));
    }

    #[test]
    fn sh_exp_match_table() {
        // Star and question mark, the shapes the spec calls out.
        assert!(sh_exp_match("https://mirror.example/a", "https://*"));
        assert!(sh_exp_match("http://a/b", "http://?/b"));
        assert!(!sh_exp_match("http://ab/b", "http://?/b"));
        assert!(sh_exp_match("wpad.dat", "*.dat"));
        assert!(!sh_exp_match("wpad.dat", "*.xml"));
        assert!(sh_exp_match("example.com", "*example*"));
        assert!(!sh_exp_match("example.com", "*notpresent*"));
        assert!(sh_exp_match("", "*"), "star matches empty");
        assert!(!sh_exp_match("", "?"));
        assert!(sh_exp_match("abc", "abc"));
        // Character classes.
        assert!(sh_exp_match("host1", "host[0-9]"));
        assert!(!sh_exp_match("hostx", "host[0-9]"));
        assert!(sh_exp_match("hostx", "host[^0-9]"));
        assert!(sh_exp_match("file1.dat", "file[12].dat"));
        // Backtracking through two stars.
        assert!(sh_exp_match("http://a/b/c/d", "http://*b*d"));
        assert!(!sh_exp_match("http://a/b/c/d", "http://*b*z"));
    }

    #[test]
    fn is_in_net_table() {
        assert!(is_in_net("10.1.2.3", "10.0.0.0", "255.0.0.0"));
        assert!(!is_in_net("11.1.2.3", "10.0.0.0", "255.0.0.0"));
        assert!(is_in_net("192.168.1.5", "192.168.1.0", "255.255.255.0"));
        assert!(
            is_in_net("192.168.1.5", "192.168.1.5", "255.255.255.255"),
            "host mask"
        );
        assert!(!is_in_net("garbage", "10.0.0.0", "255.0.0.0"));
        assert!(!is_in_net("10.1.2.3", "garbage", "255.0.0.0"));
        assert!(
            is_in_net("203.0.113.9", "0.0.0.0", "0.0.0.0"),
            "all-zeros mask matches all"
        );
    }

    #[test]
    fn is_in_net_ex_table() {
        assert!(is_in_net_ex("198.51.100.9", "198.51.100.0/24"));
        assert!(!is_in_net_ex("198.51.100.9", "198.51.99.0/24"));
        assert!(
            is_in_net_ex("198.51.100.9", "198.51.100.9"),
            "bare addr = /32"
        );
        assert!(is_in_net_ex("anything", "0.0.0.0/0"));
        assert!(
            !is_in_net_ex("2001:db8::1", "198.51.100.0/24"),
            "v6 input is false, not a panic"
        );
        assert!(
            !is_in_net_ex("1.2.3.4", "1.2.3.0/33"),
            "prefix > 32 invalid"
        );
    }

    // ── dateRange / timeRange / weekdayRange edges ────────────────────

    #[test]
    fn date_range_table() {
        // Fixtures: local 2026-03-15 (a Sunday) 10:30:00 with UTC 02:30 the
        // same day; plus a local/UTC day-boundary pair for the GMT flag.
        let local = civil(2026, 3, 15, 10, 30, 0, 0);
        let utc = civil(2026, 3, 15, 2, 30, 0, 0);
        let local_late = civil(2026, 3, 15, 23, 30, 0, 0);
        let utc_next_day = civil(2026, 3, 16, 1, 30, 0, 1); // Monday in UTC

        // Single day-of-month.
        assert!(date_range(&[num(15.0)], &local, &utc));
        assert!(!date_range(&[num(14.0)], &local, &utc));
        // Day range.
        assert!(date_range(&[num(10.0), num(20.0)], &local, &utc));
        assert!(!date_range(&[num(16.0), num(20.0)], &local, &utc));
        // Wrapped day range: 25..5 covers 25-31 and 1-5.
        assert!(
            date_range(
                &[num(25.0), num(5.0)],
                &civil(2026, 3, 2, 10, 0, 0, 1),
                &utc
            ),
            "day 2 falls inside the wrapped 25..5 range"
        );
        assert!(
            !date_range(&[num(25.0), num(5.0)], &local, &utc),
            "day 15 is outside 25..5"
        );
        // Day + month (single) via the 2-token type distinction.
        assert!(date_range(&[num(15.0), str_t("MAR")], &local, &utc));
        assert!(!date_range(&[num(15.0), str_t("APR")], &local, &utc));
        // Day + month + year (exact date).
        assert!(date_range(
            &[num(15.0), str_t("MAR"), num(2026.0)],
            &local,
            &utc
        ));
        assert!(!date_range(
            &[num(15.0), str_t("MAR"), num(2025.0)],
            &local,
            &utc
        ));
        // Month+day range, including across the year boundary.
        assert!(date_range(
            &[num(10.0), str_t("MAR"), num(20.0), str_t("MAR")],
            &local,
            &utc
        ));
        assert!(
            date_range(
                &[num(20.0), str_t("DEC"), num(10.0), str_t("FEB")],
                &civil(2026, 1, 5, 0, 0, 0, 4),
                &utc
            ),
            "January 5 falls inside DEC20..FEB10"
        );
        assert!(
            !date_range(
                &[num(20.0), str_t("DEC"), num(10.0), str_t("FEB")],
                &civil(2026, 6, 5, 0, 0, 0, 5),
                &utc
            ),
            "June 5 does not"
        );
        // Full date range.
        assert!(date_range(
            &[
                num(1.0),
                str_t("JAN"),
                num(2026.0),
                num(31.0),
                str_t("DEC"),
                num(2026.0)
            ],
            &local,
            &utc
        ));
        assert!(!date_range(
            &[
                num(1.0),
                str_t("JAN"),
                num(2025.0),
                num(31.0),
                str_t("DEC"),
                num(2025.0)
            ],
            &local,
            &utc
        ));
        // GMT flag: 23:30 local on the 15th is 01:30 on the 16th in UTC.
        assert!(
            date_range(&[num(15.0)], &local_late, &utc_next_day),
            "the local clock is still on the 15th"
        );
        assert!(
            !date_range(&[num(15.0), str_t("GMT")], &local_late, &utc_next_day),
            "UTC already rolled to the 16th"
        );
        assert!(date_range(
            &[num(16.0), str_t("GMT")],
            &local_late,
            &utc_next_day
        ));
        // Malformed argument shapes answer false, never panic.
        assert!(!date_range(&[], &local, &utc));
        assert!(
            !date_range(
                &[num(5.0), num(6.0), num(7.0), num(8.0), num(9.0)],
                &local,
                &utc
            ),
            "5-arg form does not exist"
        );
        assert!(
            !date_range(&[str_t("MAR")], &local, &utc),
            "month alone is not a day"
        );
        assert!(
            !date_range(&[num(15.0), str_t("FOO")], &local, &utc),
            "unknown month name"
        );
    }

    #[test]
    fn time_range_table() {
        let now = civil(2026, 3, 15, 22, 30, 0, 0);
        // Single hour.
        assert!(time_range(&[num(22.0)], &now, &now));
        assert!(!time_range(&[num(9.0)], &now, &now));
        // Hour range.
        assert!(time_range(&[num(20.0), num(23.0)], &now, &now));
        assert!(!time_range(&[num(1.0), num(5.0)], &now, &now));
        // Overnight range wraps: 22:30 is OUTSIDE 23..6, 02:00 is INSIDE.
        assert!(!time_range(&[num(23.0), num(6.0)], &now, &now));
        let night = civil(2026, 3, 15, 2, 0, 0, 0);
        assert!(time_range(&[num(23.0), num(6.0)], &night, &night));
        // h:m..h:m.
        assert!(time_range(
            &[num(22.0), num(0.0), num(23.0), num(0.0)],
            &now,
            &now
        ));
        assert!(!time_range(
            &[num(22.0), num(45.0), num(23.0), num(0.0)],
            &now,
            &now
        ));
        // h:m:s..h:m:s.
        assert!(time_range(
            &[
                num(22.0),
                num(0.0),
                num(0.0),
                num(22.0),
                num(30.0),
                num(0.0)
            ],
            &now,
            &now
        ));
        assert!(!time_range(
            &[
                num(22.0),
                num(0.0),
                num(0.0),
                num(22.0),
                num(29.0),
                num(59.0)
            ],
            &now,
            &now
        ));
        // The 3/5-arg forms do not exist -> false.
        assert!(!time_range(&[num(1.0), num(2.0), num(3.0)], &now, &now));
        assert!(!time_range(
            &[num(1.0), num(2.0), num(3.0), num(4.0), num(5.0)],
            &now,
            &now
        ));
    }

    #[test]
    fn weekday_range_table() {
        // 2026-03-15 is a Sunday (0); Thursday is 4.
        let sunday = civil(2026, 3, 15, 12, 0, 0, 0);
        let thursday = civil(2026, 3, 19, 12, 0, 0, 4);
        assert!(weekday_range(
            &[str_t("SUN"), str_t("SAT")],
            &sunday,
            &sunday
        ));
        assert!(weekday_range(
            &[str_t("SUN"), str_t("SUN")],
            &sunday,
            &sunday
        ));
        assert!(!weekday_range(
            &[str_t("MON"), str_t("FRI")],
            &sunday,
            &sunday
        ));
        assert!(weekday_range(
            &[str_t("MON"), str_t("FRI")],
            &thursday,
            &thursday
        ));
        // Weekend wrap FRI..MON.
        assert!(weekday_range(
            &[str_t("FRI"), str_t("MON")],
            &sunday,
            &sunday
        ));
        assert!(!weekday_range(
            &[str_t("FRI"), str_t("MON")],
            &thursday,
            &thursday
        ));
        // GMT flag picks the UTC clock: Monday 01:00 local, Sunday 23:00
        // UTC. Both weekday names are always required, GMT or not.
        let local_monday = civil(2026, 3, 16, 1, 0, 0, 1);
        let utc_sunday = civil(2026, 3, 15, 23, 0, 0, 0);
        assert!(weekday_range(
            &[str_t("SUN"), str_t("SAT"), str_t("GMT")],
            &local_monday,
            &utc_sunday
        ));
        assert!(!weekday_range(
            &[str_t("MON"), str_t("FRI"), str_t("GMT")],
            &local_monday,
            &utc_sunday
        ));
        assert!(
            !weekday_range(&[str_t("SUN"), str_t("GMT")], &local_monday, &utc_sunday),
            "single weekday + GMT is not a signature"
        );
        // Garbage names -> false.
        assert!(!weekday_range(
            &[str_t("XXX"), str_t("MON")],
            &sunday,
            &sunday
        ));
        assert!(
            !weekday_range(&[str_t("SUN")], &sunday, &sunday),
            "wd2 required"
        );
    }

    // ── Engine staleness table ────────────────────────────────────────

    #[test]
    fn needs_refresh_table() {
        let url = "http://wpad.example/wpad.dat";
        // Never attempted -> refresh (the kick bootstrap case).
        let e = PacEngine::default();
        assert!(e.needs_refresh(Some(url)));

        // Fresh success -> quiet.
        let mut e = PacEngine {
            seen_url: Some(url.to_string()),
            script: Some(PacScript {
                url: url.to_string(),
                body: "function FindProxyForURL(u, h) { return 'DIRECT'; }".to_string(),
                fetched_at: Instant::now(),
            }),
            attempt: Some(Attempt {
                url: url.to_string(),
                at: Instant::now(),
                ok: true,
            }),
            status: Some(PacStatus::Loaded),
            ..PacEngine::default()
        };
        assert!(!e.needs_refresh(Some(url)));

        // Success past the 15-min TTL -> refresh.
        e.script.as_mut().unwrap().fetched_at = Instant::now() - Duration::from_secs(16 * 60);
        assert!(e.needs_refresh(Some(url)));

        // Failed newest attempt inside the 10-min window -> quiet.
        let mut e = PacEngine {
            seen_url: Some(url.to_string()),
            attempt: Some(Attempt {
                url: url.to_string(),
                at: Instant::now() - Duration::from_secs(2 * 60),
                ok: false,
            }),
            status: Some(PacStatus::Unavailable),
            ..PacEngine::default()
        };
        assert!(!e.needs_refresh(Some(url)));

        // Failed attempt older than the window -> refresh.
        e.attempt.as_mut().unwrap().at = Instant::now() - Duration::from_secs(11 * 60);
        assert!(e.needs_refresh(Some(url)));

        // Old script WITH a newer failed attempt -> short window governs.
        let e = PacEngine {
            seen_url: Some(url.to_string()),
            script: Some(PacScript {
                url: url.to_string(),
                body: "old".to_string(),
                fetched_at: Instant::now() - Duration::from_secs(20 * 60),
            }),
            attempt: Some(Attempt {
                url: url.to_string(),
                at: Instant::now() - Duration::from_secs(60),
                ok: false,
            }),
            ..PacEngine::default()
        };
        assert!(
            !e.needs_refresh(Some(url)),
            "a recent failed retry keeps quiet despite the old script"
        );

        // Config URL changed -> refresh even with a fresh script.
        assert!(e.needs_refresh(Some("http://other.example/wpad.dat")));

        // Nothing configured -> never refresh.
        assert!(!e.needs_refresh(None));
    }

    // ── DNS cache (struct-level, no resolver) ─────────────────────────

    #[test]
    fn dns_cache_ttl_and_fifo() {
        let mut cache = DnsCache::default();
        assert_eq!(cache.lookup("a"), None);
        cache.insert("a".to_string(), Some("1.2.3.4".to_string()));
        assert_eq!(cache.lookup("a"), Some(Some("1.2.3.4".to_string())));
        cache.insert("a".to_string(), None);
        assert_eq!(cache.lookup("a"), Some(None), "negative answers cached too");
        // Cap evicts the OLDEST key first.
        for i in 0..DNS_CACHE_CAP as i32 {
            cache.insert(format!("h{i}"), Some(format!("10.0.0.{i}")));
        }
        assert_eq!(
            cache.lookup("a"),
            None,
            "'a' was the first insert and is evicted"
        );
        assert_eq!(
            cache.lookup(&format!("h{}", DNS_CACHE_CAP - 1)),
            Some(Some(format!("10.0.0.{}", DNS_CACHE_CAP - 1)))
        );
    }

    // ── Full FindProxyForURL evaluation over a fixture script ─────────

    /// Small but representative: shExpMatch for intranet globs, isInNet on
    /// a FAKE-resolved host, PROXY/SOCKS/DIRECT mixed list parsing
    /// downstream. All DNS answers come from the fixture resolver — no
    /// network is touched.
    #[test]
    fn full_script_evaluation_with_fake_dns() {
        let script = "
            function FindProxyForURL(url, host) {
                if (isPlainHostName(host) || shExpMatch(host, '*.internal.example')) {
                    return 'DIRECT';
                }
                if (shExpMatch(url, 'https://github.com/*')) {
                    return 'PROXY 198.51.100.10:3128; PROXY 198.51.100.11:3128';
                }
                if (isInNet(dnsResolve(host), '10.0.0.0', '255.0.0.0')) {
                    return 'DIRECT';
                }
                if (isResolvable(host) && dnsDomainLevels(host) >= 2) {
                    return 'SOCKS 198.51.100.20:1080';
                }
                return 'DIRECT';
            }
        ";
        let mut state =
            EvalState::build(script, fake_dns, fake_my_ip).expect("fixture script loads");

        let resolve_of = |state: &mut EvalState, url: &str, host: &str| -> Option<String> {
            state
                .resolve(url, host)
                .and_then(|raw| parse_proxy_result(&raw))
        };

        // Plain hostname -> DIRECT (empty route = no proxy).
        let u = reqwest::Url::parse("http://internalbox/").unwrap();
        assert_eq!(
            state.resolve(u.as_str(), u.host_str().unwrap()).as_deref(),
            Some("DIRECT")
        );
        assert_eq!(
            resolve_of(&mut state, u.as_str(), u.host_str().unwrap()),
            None
        );

        // shExpMatch glob on the host -> DIRECT.
        let u = reqwest::Url::parse("http://wiki.internal.example/page").unwrap();
        assert_eq!(
            resolve_of(&mut state, u.as_str(), u.host_str().unwrap()),
            None
        );

        // isInNet over the FAKE resolver: public.example resolves to
        // 198.51.100.9 (NOT in 10/8) but carries only ONE domain level,
        // so the levels >= 2 branch misses -> DIRECT.
        let u = reqwest::Url::parse("http://public.example/x").unwrap();
        assert_eq!(
            resolve_of(&mut state, u.as_str(), u.host_str().unwrap()),
            None
        );

        // www.public.example resolves to the same address AND clears the
        // 2-level threshold -> SOCKS.
        let u = reqwest::Url::parse("http://www.public.example/x").unwrap();
        assert_eq!(
            resolve_of(&mut state, u.as_str(), u.host_str().unwrap()),
            Some("socks5://198.51.100.20:1080".to_string())
        );

        // github.com branch: the first PROXY entry of the pair wins.
        let u = reqwest::Url::parse("https://github.com/langyo/wowsp").unwrap();
        assert_eq!(
            resolve_of(&mut state, u.as_str(), u.host_str().unwrap()),
            Some("http://198.51.100.10:3128".to_string())
        );

        // Unresolvable host failing every branch -> DIRECT.
        let u = reqwest::Url::parse("http://nowhere.invalid/x").unwrap();
        assert_eq!(
            resolve_of(&mut state, u.as_str(), u.host_str().unwrap()),
            None
        );
    }

    /// A script that throws at CALL time still loads; one without the
    /// entry point, and one with broken syntax, fail the LOAD (which the
    /// refresh maps onto Unavailable).
    #[test]
    fn broken_scripts_fail_the_load() {
        let throws_at_call = "function FindProxyForURL(u, h) { return noSuchFunction(u); }";
        assert!(
            EvalState::build(throws_at_call, fake_dns, fake_my_ip).is_ok(),
            "a top-level-clean script loads; the CALL is what fails"
        );
        let missing = "var x = 1;";
        assert!(EvalState::build(missing, fake_dns, fake_my_ip).is_err());
        let syntax = "function broken(";
        assert!(EvalState::build(syntax, fake_dns, fake_my_ip).is_err());
    }

    /// A throwing FindProxyForURL degrades to None (direct), not a panic.
    #[test]
    fn throwing_entry_point_resolves_to_none() {
        let script = "function FindProxyForURL(u, h) { throw new Error('boom'); }";
        let mut state = EvalState::build(script, fake_dns, fake_my_ip).expect("loads");
        let u = reqwest::Url::parse("http://example.invalid/").unwrap();
        assert_eq!(state.resolve(u.as_str(), u.host_str().unwrap()), None);
    }

    // ── local/private bypass ──────────────────────────────────────────

    #[test]
    fn bypass_targets_table() {
        let bypasses = [
            "http://localhost:8080/x",
            "http://127.0.0.1:9/x",
            "http://10.1.2.3/x",
            "http://172.16.5.5/x",
            "http://192.168.0.9/x",
            "http://169.254.1.1/x",
            "http://[::1]:8080/x",
            "http://[fe80::1]/x",
            "http://[fd00::5]/x",
        ];
        for u in bypasses {
            let url = reqwest::Url::parse(u).unwrap();
            assert!(local_or_private_target(&url), "{u} must bypass");
        }
        let proxied = [
            "http://example.com/",
            "http://8.8.8.8/",
            "http://[2001:db8::1]/",
        ];
        for u in proxied {
            let url = reqwest::Url::parse(u).unwrap();
            assert!(!local_or_private_target(&url), "{u} must ride the PAC");
        }
    }

    // ── plausible_proxy_addr edges ────────────────────────────────────

    #[test]
    fn proxy_addr_usability_table() {
        assert!(plausible_proxy_addr("192.0.2.1:8080"));
        assert!(plausible_proxy_addr("proxy.corp.example:3128"));
        assert!(
            plausible_proxy_addr("192.0.2.1"),
            "port optional (defaults apply)"
        );
        assert!(!plausible_proxy_addr(""));
        assert!(!plausible_proxy_addr("two words"));
        assert!(!plausible_proxy_addr(":8080"));
        assert!(!plausible_proxy_addr("host:notaport"));
        assert!(!plausible_proxy_addr("host:"), "empty port digits");
        assert!(!plausible_proxy_addr("host:99999"), "u16 overflow");
    }
}
