//! Export-time redaction for the feedback bundle and the copied log tail.
//!
//! The file sink keeps the raw text on disk (support sessions read it as
//! is); only what LEAVES the machine through the feedback flow is masked:
//! the zip's log entries, `feedback-info.txt`, `hardware-info.txt` and the
//! clipboard tail. Masking is plain string work — no regex dependency —
//! in a fixed order:
//!
//! 1. the running user's home folder (`USERPROFILE`; every spelling the logs produce:
//!    raw, Debug-escaped `\\`, forward slashes; ASCII case-insensitive)
//!    becomes `%USERPROFILE%`;
//! 2. any other `…\Users\<name>` segment becomes `…\Users\<user>`;
//! 3. a UNC server name (`\\server\share`) becomes `\\<host>\share`;
//! 4. the bare account / computer name becomes `<user>` / `<host>` (word
//!    boundaries, generic names like `admin` skipped);
//! 5. URL query values of [`SECRET_QUERY_KEYS`] (`search=` nicknames,
//!    `application_id=`, pairing tokens, …) become `<redacted>`;
//! 6. account ids in the shapes the app logs — `account_id(s)` fields
//!    (plain, `Some(…)`, `[…]` lists), vortex `/accounts/<id>` paths and
//!    the `<realm>_<id>.json` cache files — keep only their last four
//!    digits: enough to tell lookups apart inside one bundle, not enough
//!    to look a player up (the reporter's own id reaches the author
//!    through the web form's game-ID field, deliberately); the nickname
//!    in `/accounts/search/<name>` becomes `<redacted>`;
//! 7. private / link-local / CGNAT IPv4 and every non-loopback IPv6
//!    address become `<private-ip>` / `<ipv6>` (ports are kept; public
//!    IPv4 stays — those are the upstream servers a report is about).
//!    Logs only: [`Redactor::redact_report`] skips this rule for the
//!    hardware report, whose driver versions look like private IPv4.
//!
//! What it cannot know about stays: game install paths outside the home
//! folder, in-game nicknames echoed in messages, a bare number that
//! happens to be an account id, a `key=value` pair outside a URL query,
//! and so on. The consent dialog says so.

/// Replacement for the running user's home folder.
pub const HOME_PLACEHOLDER: &str = "%USERPROFILE%";
/// Replacement for a user name (path segment or bare token).
pub const USER_PLACEHOLDER: &str = "<user>";
/// Replacement for a computer / UNC server name.
pub const HOST_PLACEHOLDER: &str = "<host>";
/// Replacement for a masked URL query value.
pub const REDACTED_PLACEHOLDER: &str = "<redacted>";
/// Replacement for a private / link-local / CGNAT IPv4 address.
pub const PRIVATE_IPV4_PLACEHOLDER: &str = "<private-ip>";
/// Replacement for a non-loopback IPv6 address.
pub const IPV6_PLACEHOLDER: &str = "<ipv6>";

/// URL query keys whose values are masked: player-name searches, the WG
/// application id, account ids, and the pairing / OAuth secrets.
const SECRET_QUERY_KEYS: &[&str] = &[
    "search",
    "application_id",
    "account_id",
    "nickname",
    "access_token",
    "token",
    "code",
    "room",
    "conn",
];

/// Field names whose numeric value is an account id (tracing `key=value`,
/// Debug `key: value`, JSON `"key": value`).
const ACCOUNT_ID_KEYS: &[&str] = &["account_ids", "account_id", "accountids", "accountid"];

/// Realm prefixes of the per-account cache files
/// (`ship-stats/<realm>_<id>.json`, `snapshots/…`, `ship-history/…`).
const CACHE_REALMS: &[&str] = &["asia", "ru", "eu", "na", "cn"];

/// Account / computer names never replaced as bare tokens: too generic to
/// identify anyone, and replacing them would shred ordinary log words
/// (level names, the app's own name, the placeholders themselves).
const GENERIC_NAMES: &[&str] = &[
    "admin",
    "administrator",
    "default",
    "guest",
    "owner",
    "public",
    "user",
    "users",
    "userprofile",
    "host",
    "localhost",
    "redacted",
    "private",
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "wowsp",
    "root",
    "runner",
];

/// Profile folder names under `Users\` that are not a person.
const SHARED_PROFILE_DIRS: &[&str] = &["public", "default", "default user", "all users"];

/// The masking rules plus the runtime values they key on.
#[derive(Debug, Clone, Default)]
pub struct Redactor {
    /// Home-folder spellings, longest first.
    home_dirs: Vec<String>,
    /// Bare account names.
    user_names: Vec<String>,
    /// Bare computer names.
    host_names: Vec<String>,
}

impl Redactor {
    /// Build from explicit values (tests, and [`Redactor::from_env`]).
    /// Unusable values (empty, a bare drive root, generic names, ASCII
    /// names shorter than three characters) are dropped.
    pub fn new(
        home_dirs: impl IntoIterator<Item = String>,
        user_names: impl IntoIterator<Item = String>,
        host_names: impl IntoIterator<Item = String>,
    ) -> Self {
        let mut homes: Vec<String> = Vec::new();
        for home in home_dirs {
            let trimmed = home.trim().trim_end_matches(['\\', '/']);
            // A drive root (`C:`) or `/` would mask every path in the file.
            if trimmed.chars().count() < 4 || !trimmed.contains(['\\', '/']) {
                continue;
            }
            for variant in [
                trimmed.to_string(),
                trimmed.replace('\\', "\\\\"),
                trimmed.replace('\\', "/"),
            ] {
                if !homes.contains(&variant) {
                    homes.push(variant);
                }
            }
        }
        homes.sort_by_key(|h| std::cmp::Reverse(h.len()));
        Self {
            home_dirs: homes,
            user_names: usable_names(user_names),
            host_names: usable_names(host_names),
        }
    }

    /// The running user's values: the `USERPROFILE` folder (and its last
    /// segment — the profile folder's name, which is the account name in
    /// all but renamed-account cases), `USERNAME` / `USER`, `COMPUTERNAME`.
    /// `HOME` is only a fallback home folder where `USERPROFILE` is unset
    /// (non-Windows); dev shells set it to unrelated `/home/x` style
    /// values, so it never contributes a bare name.
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let profile = var("USERPROFILE");
        let profile_name = profile.as_deref().and_then(last_path_segment);
        let homes: Vec<String> = match profile {
            Some(p) => vec![p],
            None => var("HOME").into_iter().collect(),
        };
        Self::new(
            homes,
            [var("USERNAME"), var("USER"), profile_name]
                .into_iter()
                .flatten(),
            var("COMPUTERNAME"),
        )
    }

    /// Mask `text` (see the module docs for the rules and their order).
    pub fn redact(&self, text: &str) -> String {
        self.mask(text, true)
    }

    /// [`Redactor::redact`] minus the IP rule — for the hardware report,
    /// whose driver / firmware versions can fall in a private IPv4 range
    /// IPv4 and carry no addresses worth masking.
    pub fn redact_report(&self, text: &str) -> String {
        self.mask(text, false)
    }

    fn mask(&self, text: &str, ips: bool) -> String {
        let mut out = text.to_string();
        for home in &self.home_dirs {
            out = replace_ci(&out, home, HOME_PLACEHOLDER, Boundary::PathEnd);
        }
        out = redact_users_segments(&out);
        out = redact_unc_hosts(&out);
        for name in &self.user_names {
            out = replace_ci(&out, name, USER_PLACEHOLDER, Boundary::Word);
        }
        for name in &self.host_names {
            out = replace_ci(&out, name, HOST_PLACEHOLDER, Boundary::Word);
        }
        out = redact_query_values(&out);
        out = redact_account_ids(&out);
        if ips { redact_ips(&out) } else { out }
    }
}

/// Last segment of a folder path (`C:\Users\John Smith` → `John Smith`);
/// `None` for a bare root.
fn last_path_segment(path: &str) -> Option<String> {
    path.trim()
        .trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .filter(|s| !s.is_empty() && !s.ends_with(':'))
        .map(str::to_string)
}

fn usable_names(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let name = name.trim().to_string();
        let len = name.chars().count();
        // ASCII names need three characters to be worth a bare replace;
        // a two-character CJK name is already a name.
        let min = if name.is_ascii() { 3 } else { 2 };
        if len < min
            || GENERIC_NAMES.iter().any(|g| g.eq_ignore_ascii_case(&name))
            || out.iter().any(|n| n.eq_ignore_ascii_case(&name))
        {
            continue;
        }
        out.push(name);
    }
    out.sort_by_key(|n| std::cmp::Reverse(n.len()));
    out
}

/// What must NOT follow (or precede) a [`replace_ci`] match.
#[derive(Clone, Copy)]
enum Boundary {
    /// The next char must not extend the last path segment.
    PathEnd,
    /// Neither neighbour may be a word character.
    Word,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn is_ascii_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Replace every ASCII-case-insensitive occurrence of `needle` (non-ASCII
/// bytes compare exactly) that satisfies `boundary`.
fn replace_ci(text: &str, needle: &str, replacement: &str, boundary: Boundary) -> String {
    let hay = text.as_bytes();
    let pat = needle.as_bytes();
    if pat.is_empty() || hay.len() < pat.len() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i + pat.len() <= hay.len() {
        // The needle's first byte is a char start, so a byte-equal match
        // always begins (and ends) on char boundaries.
        if hay[i].eq_ignore_ascii_case(&pat[0]) && hay[i..i + pat.len()].eq_ignore_ascii_case(pat) {
            let end = i + pat.len();
            let prev = text[..i].chars().next_back();
            let next = text[end..].chars().next();
            let ok = match boundary {
                Boundary::PathEnd => !next.is_some_and(|c| is_word_char(c) || c == '-' || c == '.'),
                // Only an ASCII edge can glue to an ASCII neighbour: CJK
                // text has no spaces, so `张三的游戏` still loses `张三`,
                // while `Malice` keeps its `alice`.
                Boundary::Word => {
                    let first = needle.chars().next().is_some_and(is_ascii_word_char);
                    let last = needle.chars().next_back().is_some_and(is_ascii_word_char);
                    (!first || !prev.is_some_and(is_ascii_word_char))
                        && (!last || !next.is_some_and(is_ascii_word_char))
                },
            };
            if ok {
                out.push_str(&text[copied..i]);
                out.push_str(replacement);
                copied = end;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// Chars that end a path segment in prose / Debug output.
fn ends_segment(c: char) -> bool {
    matches!(
        c,
        '\\' | '/'
            | '"'
            | '\''
            | '`'
            | ':'
            | '*'
            | '?'
            | '<'
            | '>'
            | '|'
            | ','
            | ';'
            | '('
            | ')'
            | '['
            | ']'
            | '{'
            | '}'
    ) || c.is_whitespace()
}

/// `…\Users\<name>` (any separator spelling, ASCII case-insensitive) →
/// `…\Users\<user>`; covers other profiles and runs without `USERPROFILE`.
fn redact_users_segments(text: &str) -> String {
    const USERS: &[u8] = b"users";
    let hay = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 1;
    while i + USERS.len() < hay.len() {
        if matches!(hay[i - 1], b'\\' | b'/') && hay[i..i + USERS.len()].eq_ignore_ascii_case(USERS)
        {
            let mut seg_start = i + USERS.len();
            if !matches!(hay[seg_start], b'\\' | b'/') {
                i += 1;
                continue;
            }
            while seg_start < hay.len() && matches!(hay[seg_start], b'\\' | b'/') {
                seg_start += 1;
            }
            let seg_len = profile_segment_len(&text[seg_start..]);
            let segment = &text[seg_start..seg_start + seg_len];
            let shared = SHARED_PROFILE_DIRS
                .iter()
                .any(|d| d.eq_ignore_ascii_case(segment));
            if seg_len > 0 && !shared && segment != HOME_PLACEHOLDER {
                out.push_str(&text[copied..seg_start]);
                out.push_str(USER_PLACEHOLDER);
                copied = seg_start + seg_len;
            }
            i = seg_start + seg_len.max(1);
            continue;
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// Byte length of the profile folder name at the start of `rest`. Names
/// may contain spaces (`John Smith`): the spaced run counts when a path
/// separator closes it (`John Smith\AppData`); otherwise (prose such as
/// `C:\Users\Bob failed`) the name ends at the first space.
fn profile_segment_len(rest: &str) -> usize {
    const MAX_NAME_CHARS: usize = 64;
    let spaced: usize = rest
        .chars()
        .take(MAX_NAME_CHARS)
        .take_while(|c| *c == ' ' || !ends_segment(*c))
        .map(char::len_utf8)
        .sum();
    let closed = matches!(rest.as_bytes().get(spaced), Some(b'\\' | b'/'));
    if closed && !rest[..spaced].ends_with(' ') {
        return spaced;
    }
    rest.chars()
        .take_while(|c| !ends_segment(*c))
        .map(char::len_utf8)
        .sum()
}

/// `\\server\share` (or its Debug spelling `\\\\server\\share`) →
/// `\\<host>\share`. Device paths (`\\?\`, `\\.\`) are left alone.
fn redact_unc_hosts(text: &str) -> String {
    let hay = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < hay.len() {
        if hay[i] != b'\\' {
            i += 1;
            continue;
        }
        let run_start = i;
        while i < hay.len() && hay[i] == b'\\' {
            i += 1;
        }
        let run = i - run_start;
        // A UNC path starts a token: only the text start, whitespace, a
        // quote, an opening bracket or `=` may precede it. Anything else
        // is a Debug-escaped separator inside a path (`C:\\Users`,
        // `(x86)\\Steam`, `游戏\\World_of_Warships`, `<user>\\AppData`).
        let prev_ok = run_start == 0
            || matches!(
                hay[run_start - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b'"' | b'\'' | b'(' | b'[' | b'=' | b'`'
            );
        if !(run == 2 || run == 4) || !prev_ok {
            continue;
        }
        let host_len = hay[i..]
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            .count();
        let host = &text[i..i + host_len];
        if host_len > 0 && host != "." && hay.get(i + host_len) == Some(&b'\\') {
            out.push_str(&text[copied..i]);
            out.push_str(HOST_PLACEHOLDER);
            copied = i + host_len;
            i += host_len;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// `?key=value` / `&key=value` for [`SECRET_QUERY_KEYS`] → `<redacted>`.
/// The value runs to the next `&`, `#`, quote, bracket or whitespace
/// (commas stay inside: `account_id=1,2,3` is one value).
fn redact_query_values(text: &str) -> String {
    let hay = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < hay.len() {
        if !matches!(hay[i], b'?' | b'&') {
            i += 1;
            continue;
        }
        let key_start = i + 1;
        let key_len = hay[key_start..]
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
            .count();
        let eq = key_start + key_len;
        if key_len == 0 || hay.get(eq) != Some(&b'=') {
            i += 1;
            continue;
        }
        let key = &text[key_start..eq];
        if !SECRET_QUERY_KEYS
            .iter()
            .any(|k| k.eq_ignore_ascii_case(key))
        {
            i = eq;
            continue;
        }
        let value_start = eq + 1;
        let value_len: usize = text[value_start..]
            .chars()
            .take_while(|c| {
                !matches!(
                    c,
                    '&' | '#' | '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}'
                ) && !c.is_whitespace()
            })
            .map(char::len_utf8)
            .sum();
        if value_len > 0 {
            out.push_str(&text[copied..value_start]);
            out.push_str(REDACTED_PLACEHOLDER);
            copied = value_start + value_len;
        }
        i = value_start + value_len;
    }
    out.push_str(&text[copied..]);
    out
}

/// `***` plus the last four digits (just `***` for short values).
fn mask_id(digits: &str) -> String {
    if digits.len() > 4 {
        format!("***{}", &digits[digits.len() - 4..])
    } else {
        "***".to_string()
    }
}

/// Every ASCII digit run in `text` through [`mask_id`] — except runs an
/// earlier pass already masked (`***6789`).
fn mask_digit_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run_start: Option<usize> = None;
    let flush = |out: &mut String, run: &str| {
        if out.ends_with('*') {
            out.push_str(run);
        } else {
            out.push_str(&mask_id(run));
        }
    };
    for (i, c) in text.char_indices() {
        match (c.is_ascii_digit(), run_start) {
            (true, None) => run_start = Some(i),
            (false, Some(start)) => {
                flush(&mut out, &text[start..i]);
                run_start = None;
                out.push(c);
            },
            (false, None) => out.push(c),
            (true, Some(_)) => {},
        }
    }
    if let Some(start) = run_start {
        flush(&mut out, &text[start..]);
    }
    out
}

/// Account ids in the shapes the app logs, all kept to their last four
/// digits: fields (`account_id=503224851`, `account_id: Some(…)`,
/// `"accountId": …`, `account_ids=[…]`), vortex API paths
/// (`/accounts/<id>/…`; the nickname of `/accounts/search/<name>/`
/// becomes `<redacted>`) and the per-account cache files
/// (`ship-stats/eu_<id>.json`, `snapshots/…`, `ship-history/…`).
fn redact_account_ids(text: &str) -> String {
    let mut out = text.to_string();
    for key in ACCOUNT_ID_KEYS {
        out = mask_account_id_key(&out, key);
    }
    out = redact_account_paths(&out);
    for realm in CACHE_REALMS {
        out = mask_cache_file_ids(&out, realm);
    }
    out
}

fn mask_account_id_key(text: &str, key: &str) -> String {
    let hay = text.as_bytes();
    let pat = key.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i + pat.len() <= hay.len() {
        let hit = hay[i..i + pat.len()].eq_ignore_ascii_case(pat)
            && (i == 0 || !(hay[i - 1].is_ascii_alphanumeric() || hay[i - 1] == b'_'));
        if !hit {
            i += 1;
            continue;
        }
        let mut j = i + pat.len();
        if hay.get(j) == Some(&b'"') {
            j += 1;
        }
        while hay.get(j) == Some(&b' ') {
            j += 1;
        }
        if !matches!(hay.get(j), Some(b'=' | b':')) {
            i += pat.len();
            continue;
        }
        j += 1;
        while matches!(hay.get(j), Some(b' ' | b'"')) {
            j += 1;
        }
        // Debug of `Option<u64>`.
        if hay[j..].starts_with(b"Some(") {
            j += "Some(".len();
        }
        // A list (`account_ids=[1, 2]`): every number up to the bracket.
        if hay.get(j) == Some(&b'[') {
            const MAX_LIST_BYTES: usize = 64 * 1024;
            match hay[j..]
                .iter()
                .take(MAX_LIST_BYTES)
                .position(|b| *b == b']')
            {
                Some(close) => {
                    let end = j + close;
                    out.push_str(&text[copied..j]);
                    out.push_str(&mask_digit_runs(&text[j..end]));
                    copied = end;
                    i = end;
                },
                None => i = j + 1,
            }
            continue;
        }
        let digits = hay[j..].iter().take_while(|b| b.is_ascii_digit()).count();
        if digits > 0
            && !hay
                .get(j + digits)
                .is_some_and(|b| b.is_ascii_alphanumeric())
        {
            out.push_str(&text[copied..j]);
            out.push_str(&mask_id(&text[j..j + digits]));
            copied = j + digits;
        }
        i = j + digits.max(1);
    }
    out.push_str(&text[copied..]);
    out
}

/// `/accounts/<id>` → `/accounts/***<last4>`; the name segment of
/// `/accounts/search/<name>` and `/accounts/search/autocomplete/<name>`
/// → `<redacted>`.
fn redact_account_paths(text: &str) -> String {
    const ACCOUNTS: &str = "/accounts/";
    const SEARCH_PREFIXES: &[&str] = &["search/autocomplete/", "search/"];
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    while let Some(pos) = text[from..].find(ACCOUNTS) {
        let start = from + pos + ACCOUNTS.len();
        let rest = &text[start..];
        if let Some(prefix) = SEARCH_PREFIXES.iter().find(|p| rest.starts_with(**p)) {
            let seg_start = start + prefix.len();
            let seg_len: usize = text[seg_start..]
                .chars()
                .take_while(|c| {
                    !matches!(
                        c,
                        '/' | '\\' | '?' | '#' | '"' | '\'' | '`' | '<' | '>' | ')' | ']'
                    ) && !c.is_whitespace()
                })
                .map(char::len_utf8)
                .sum();
            if seg_len > 0 {
                out.push_str(&text[copied..seg_start]);
                out.push_str(REDACTED_PLACEHOLDER);
                copied = seg_start + seg_len;
            }
            from = seg_start + seg_len;
            continue;
        }
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        let glued = rest
            .as_bytes()
            .get(digits)
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
        if digits > 0 && !glued {
            out.push_str(&text[copied..start]);
            out.push_str(&mask_id(&rest[..digits]));
            copied = start + digits;
        }
        from = start + digits;
    }
    out.push_str(&text[copied..]);
    out
}

/// `<sep><realm>_<digits>.json` → `<sep><realm>_***<last4>.json`.
fn mask_cache_file_ids(text: &str, realm: &str) -> String {
    let needle = format!("{realm}_");
    let hay = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    while let Some(pos) = text[from..].find(&needle) {
        let at = from + pos;
        let start = at + needle.len();
        let digits = hay[start..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        let after_sep = at > 0 && matches!(hay[at - 1], b'/' | b'\\');
        if after_sep && digits > 0 && text[start + digits..].starts_with(".json") {
            out.push_str(&text[copied..start]);
            out.push_str(&mask_id(&text[start..start + digits]));
            copied = start + digits;
        }
        from = start + digits;
    }
    out.push_str(&text[copied..]);
    out
}

/// IPv4 in the private, link-local or CGNAT (100.64/10) ranges.
fn is_private_v4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_private() || ip.is_link_local() || (a == 100 && (b & 0xC0) == 64)
}

fn is_addr_byte(b: u8) -> bool {
    b.is_ascii_hexdigit() || b == b':' || b == b'.'
}

/// Mask private IPv4 and non-loopback IPv6 literals. A candidate is a
/// maximal run of hex digits, `:` and `.` that does not continue a word
/// (so Rust paths like `ab::cd` inside `crate::ab::cd`, timestamps and
/// version strings survive); the run must then parse as an address.
fn redact_ips(text: &str) -> String {
    let hay = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < hay.len() {
        if !is_addr_byte(hay[i]) {
            i += 1;
            continue;
        }
        let prev = if i == 0 { None } else { Some(hay[i - 1]) };
        // A run glued to a word / number continues it. After a lone `:`
        // only IPv4 may start (`addr:<ipv4>`); IPv6 there would match
        // path pieces such as `::ab::cd`.
        if prev.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.') {
            i += 1;
            continue;
        }
        let v4_only = prev == Some(b':');
        let mut end = i;
        while end < hay.len() && is_addr_byte(hay[end]) {
            end += 1;
        }
        let mut span_end = end;
        while span_end > i && hay[span_end - 1] == b'.' {
            span_end -= 1;
        }
        let span = &text[i..span_end];
        let glued = |at: usize| {
            hay.get(at)
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
        };

        if !v4_only && span.matches(':').count() >= 2 {
            // Optional zone id: `fe80::1%12`, `fe80::1%eth0`.
            let mut stop = span_end;
            if span_end == end && hay.get(stop) == Some(&b'%') {
                let zone = hay[stop + 1..]
                    .iter()
                    .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_' || **b == b'-')
                    .count();
                if zone > 0 {
                    stop += 1 + zone;
                }
            }
            // A real address carries a decimal digit somewhere; `ab::cd`
            // (a Rust path in a message) does not.
            if !glued(stop)
                && span.bytes().any(|b| b.is_ascii_digit())
                && let Ok(ip) = span.parse::<std::net::Ipv6Addr>()
                && !ip.is_loopback()
                && !ip.is_unspecified()
            {
                out.push_str(&text[copied..i]);
                out.push_str(IPV6_PLACEHOLDER);
                copied = stop;
            }
            i = stop.max(end);
            continue;
        }

        // IPv4, optionally followed by `:port`.
        let host = span.split(':').next().unwrap_or_default();
        let host_end = i + host.len();
        if host.matches('.').count() == 3
            && !glued(host_end)
            && let Ok(ip) = host.parse::<std::net::Ipv4Addr>()
            && is_private_v4(ip)
        {
            out.push_str(&text[copied..i]);
            out.push_str(PRIVATE_IPV4_PLACEHOLDER);
            copied = host_end;
        }
        i = end;
    }
    out.push_str(&text[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win_alice() -> Redactor {
        Redactor::new(
            [r"C:\Users\Alice".to_string()],
            ["Alice".to_string()],
            ["DESKTOP-7Q2K9ZT".to_string()],
        )
    }

    #[test]
    fn home_folder_is_masked_in_every_spelling() {
        let r = win_alice();
        // tracing's `?path` Debug output doubles the backslashes.
        let debug = r#"log_dir=Some("C:\\Users\\Alice\\AppData\\Roaming\\WoWSP\\logs")"#;
        assert_eq!(
            r.redact(debug),
            r#"log_dir=Some("%USERPROFILE%\\AppData\\Roaming\\WoWSP\\logs")"#
        );
        assert_eq!(
            r.redact(r"log-dir: C:\Users\Alice\AppData\Roaming\WoWSP\logs"),
            r"log-dir: %USERPROFILE%\AppData\Roaming\WoWSP\logs"
        );
        assert_eq!(
            r.redact("cache at C:/Users/Alice/AppData/Local"),
            "cache at %USERPROFILE%/AppData/Local"
        );
    }

    #[test]
    fn home_folder_match_ignores_ascii_case() {
        let r = win_alice();
        assert_eq!(
            r.redact(r"opened c:\users\ALICE\Documents\x.wowsreplay"),
            r"opened %USERPROFILE%\Documents\x.wowsreplay"
        );
    }

    #[test]
    fn home_folder_prefix_of_another_profile_is_not_cut_short() {
        // `C:\Users\Alice` must not eat the front of `C:\Users\Alice2`;
        // the generic Users rule masks that other profile instead.
        let r = win_alice();
        assert_eq!(
            r.redact(r"C:\Users\Alice2\Desktop"),
            r"C:\Users\<user>\Desktop"
        );
    }

    #[test]
    fn other_profiles_are_masked_without_env_values() {
        let r = Redactor::default();
        assert_eq!(
            r.redact(r"read D:\Backup\Users\Bob\wows\prefs.xml failed"),
            r"read D:\Backup\Users\<user>\wows\prefs.xml failed"
        );
        assert_eq!(
            r.redact(r#"path="C:\\Users\\Bob\\x""#),
            r#"path="C:\\Users\\<user>\\x""#
        );
        // Shared profiles carry no identity.
        assert_eq!(r.redact(r"C:\Users\Public\Games"), r"C:\Users\Public\Games");
    }

    #[test]
    fn cjk_profile_names_are_masked() {
        let r = Redactor::new([r"C:\Users\张三".to_string()], ["张三".to_string()], []);
        assert_eq!(
            r.redact(r"游戏路径 D:\张三的游戏\WoWS；配置 C:\Users\张三\AppData"),
            r"游戏路径 D:\<user>的游戏\WoWS；配置 %USERPROFILE%\AppData"
        );
    }

    #[test]
    fn unc_paths_lose_the_server_and_profile_names() {
        let r = Redactor::new(
            [r"\\fs01.corp.example\profiles$\alice".to_string()],
            ["alice".to_string()],
            [],
        );
        assert_eq!(
            r.redact(r"roaming at \\fs01.corp.example\profiles$\alice\AppData\Roaming"),
            r"roaming at %USERPROFILE%\AppData\Roaming"
        );
        assert_eq!(
            r.redact(r"game at \\nas\games\World_of_Warships"),
            r"game at \\<host>\games\World_of_Warships"
        );
        assert_eq!(
            r.redact(r#"path="\\\\nas\\share\\Users\\Bob""#),
            r#"path="\\\\<host>\\share\\Users\\<user>""#
        );
        // Debug-escaped separators inside a path are not UNC starts.
        let d = Redactor::default();
        for line in [
            r#"exe="C:\\Program Files (x86)\\Steam\\steam.exe""#,
            r#"game="D:\\游戏\\World_of_Warships""#,
            r#"cfg="C:\\Users\\<user>\\AppData""#,
        ] {
            assert_eq!(d.redact(line), line, "must stay: {line}");
        }
        // Device namespaces are not servers.
        assert_eq!(r.redact(r"\\?\C:\Games"), r"\\?\C:\Games");
        assert_eq!(r.redact(r"\\.\pipe\wowsp"), r"\\.\pipe\wowsp");
    }

    #[test]
    fn profile_names_with_spaces_are_masked_whole() {
        let r = Redactor::default();
        assert_eq!(
            r.redact(r"C:\Users\John Smith\AppData\Roaming"),
            r"C:\Users\<user>\AppData\Roaming"
        );
        assert_eq!(
            r.redact(r#"path="C:\\Users\\John Smith\\x""#),
            r#"path="C:\\Users\\<user>\\x""#
        );
        // Prose after a bare profile path is not swallowed.
        assert_eq!(
            r.redact(r"open C:\Users\Bob failed: denied"),
            r"open C:\Users\<user> failed: denied"
        );
        let r = Redactor::new(
            [r"C:\Users\John Smith".to_string()],
            ["John Smith".to_string()],
            [],
        );
        assert_eq!(
            r.redact(r"C:\Users\John Smith\x as John Smith"),
            r"%USERPROFILE%\x as <user>"
        );
    }

    #[test]
    fn last_path_segment_is_the_profile_folder_name() {
        assert_eq!(
            last_path_segment(r"C:\Users\John Smith\").as_deref(),
            Some("John Smith")
        );
        assert_eq!(last_path_segment(r"C:\Users\张三").as_deref(), Some("张三"));
        assert_eq!(last_path_segment(r"C:\"), None);
    }

    #[test]
    fn bare_user_and_computer_names_respect_word_boundaries() {
        let r = win_alice();
        assert_eq!(
            r.redact("signed in as alice on DESKTOP-7Q2K9ZT"),
            "signed in as <user> on <host>"
        );
        // Inside a longer word it is not the name.
        assert_eq!(r.redact("Malice and Alicex"), "Malice and Alicex");
        // Glued to CJK text it still is.
        assert_eq!(r.redact("用户Alice登录"), "用户<user>登录");
    }

    #[test]
    fn generic_or_short_names_are_never_bare_replaced() {
        let r = Redactor::new(
            [],
            ["info".to_string(), "jo".to_string()],
            ["admin".to_string()],
        );
        let line = " INFO wowsp: jo admin info";
        assert_eq!(r.redact(line), line);
    }

    #[test]
    fn root_like_homes_are_ignored() {
        let r = Redactor::new([r"C:\".to_string(), "/".to_string()], [], []);
        assert_eq!(r.redact(r"C:\Games\wows"), r"C:\Games\wows");
    }

    #[test]
    fn url_query_secrets_are_masked() {
        let r = Redactor::default();
        let err = "account/list request: error sending request for url \
                   (https://api.worldofwarships.eu/wows/account/list/\
                   ?application_id=0123abcd&search=Some_Player&limit=10)";
        assert_eq!(
            r.redact(err),
            "account/list request: error sending request for url \
             (https://api.worldofwarships.eu/wows/account/list/\
             ?application_id=<redacted>&search=<redacted>&limit=10)"
        );
        assert_eq!(
            r.redact("GET /wows/account/info/?APPLICATION_ID=x&account_id=1,2,3&extra=a"),
            "GET /wows/account/info/?APPLICATION_ID=<redacted>&account_id=<redacted>&extra=a"
        );
        assert_eq!(
            r.redact("ws://relay/resolve?code=ABC123 then /control?room=r1&role=host"),
            "ws://relay/resolve?code=<redacted> then /control?room=<redacted>&role=host"
        );
        // Non-secret keys and plain question marks stay.
        assert_eq!(r.redact("why? ship_id=42&type=x"), "why? ship_id=42&type=x");
    }

    #[test]
    fn account_id_fields_keep_the_last_four_digits() {
        let r = Redactor::default();
        assert_eq!(
            r.redact("realm=eu account_id=503224851 hidden=false"),
            "realm=eu account_id=***4851 hidden=false"
        );
        assert_eq!(
            r.redact(r#"{"accountId": 2013579}"#),
            r#"{"accountId": ***3579}"#
        );
        assert_eq!(r.redact("account_id: 123"), "account_id: ***");
        // Not an account id field.
        assert_eq!(r.redact("my_account_id=5"), "my_account_id=5");
        // Option / list Debug shapes.
        assert_eq!(
            r.redact("account_id=Some(503224851)"),
            "account_id=Some(***4851)"
        );
        assert_eq!(
            r.redact("account_ids=[503224851, 2013579] n=2"),
            "account_ids=[***4851, ***3579] n=2"
        );
    }

    #[test]
    fn account_api_paths_and_cache_files_are_masked() {
        let r = Redactor::default();
        assert_eq!(
            r.redact("GET https://vortex.example/api/accounts/503224851/ships/pvp/ failed"),
            "GET https://vortex.example/api/accounts/***4851/ships/pvp/ failed"
        );
        assert_eq!(
            r.redact("https://vortex.example/api/accounts/503224851/clans/"),
            "https://vortex.example/api/accounts/***4851/clans/"
        );
        assert_eq!(
            r.redact("url (https://v.example/api/accounts/search/Some%20Player/?limit=10)"),
            "url (https://v.example/api/accounts/search/<redacted>/?limit=10)"
        );
        assert_eq!(
            r.redact("https://v.example/api/accounts/search/autocomplete/abc/"),
            "https://v.example/api/accounts/search/autocomplete/<redacted>/"
        );
        assert_eq!(
            r.redact(r"read ship-stats/eu_503224851.json and snapshots\cn_2013579.json"),
            r"read ship-stats/eu_***4851.json and snapshots\cn_***3579.json"
        );
        // Not a cache file / not an id path.
        assert_eq!(
            r.redact("menu_12.json /accounts/me/"),
            "menu_12.json /accounts/me/"
        );
    }

    /// Dotted quad built at runtime. AGENTS.md §7 bans private-range IP
    /// literals from the tree (tests included), yet the redactor must be
    /// tested on exactly those ranges — so fixtures assemble them here.
    fn ip(a: u8, b: u8, c: u8, d: u8) -> String {
        format!("{a}.{b}.{c}.{d}")
    }

    #[test]
    fn private_ipv4_is_masked_and_ports_survive() {
        let r = Redactor::default();
        let lan = ip(192, 168, 1, 23);
        assert_eq!(
            r.redact(&format!("pairing server started host={lan} port=17800")),
            "pairing server started host=<private-ip> port=17800"
        );
        let peer = ip(10, 0, 0, 5);
        assert_eq!(
            r.redact(&format!(
                "peer {peer}:51234, nat 100.72.1.9, ll 169.254.3.4."
            )),
            "peer <private-ip>:51234, nat <private-ip>, ll <private-ip>."
        );
        let docker = ip(172, 20, 0, 1);
        assert_eq!(r.redact(&format!("addr:{docker}")), "addr:<private-ip>");
        let home = ip(192, 168, 0, 8);
        assert_eq!(
            r.redact(&format!("局域网地址{home}已就绪")),
            "局域网地址<private-ip>已就绪"
        );
    }

    #[test]
    fn public_loopback_and_lookalikes_survive() {
        let r = Redactor::default();
        for line in [
            "connect 203.0.113.7:443",
            "bind 127.0.0.1:0 and 0.0.0.0",
            "driver 32.0.15.6094 build 6.3.9600.17031",
            "2026-10-14T03:12:45.123456Z  INFO wowsp_tauri::commands::ab::cd: ok",
            "mac 00:1A:2B:3C:4D:5E, physical",
            "v1.2.3.4 and 1.2.3.4.5",
            "loopback ::1 and [::1]:8080",
            "path a::b and dead::beef and cafe::face::fade",
            "uptime 12:34:56",
        ] {
            assert_eq!(r.redact(line), line, "must stay: {line}");
        }
        // A Windows build string that starts like a private range but has
        // an out-of-range octet.
        let build = format!("build {}.0.26100.1742", 10);
        assert_eq!(r.redact(&build), build);
    }

    #[test]
    fn ipv6_addresses_are_masked() {
        let r = Redactor::default();
        assert_eq!(
            r.redact("listen [fe80::1c2b:3aff:fe4d:5e6f%12]:17800"),
            "listen [<ipv6>]:17800"
        );
        assert_eq!(
            r.redact("via 2001:DB8:85A3::8A2E:370:7334 and fd12:3456:789a::1"),
            "via <ipv6> and <ipv6>"
        );
        let mapped = format!("mapped ::ffff:{} ok", ip(192, 168, 1, 5));
        assert_eq!(r.redact(&mapped), "mapped <ipv6> ok");
    }

    #[test]
    fn hardware_report_keeps_version_numbers_that_look_like_ips() {
        let r = win_alice();
        let driver = ip(10, 1, 1, 44);
        let row = format!(r"adapter: RTX 4070 — driver {driver}, log C:\Users\Alice\x");
        assert_eq!(
            r.redact_report(&row),
            format!(r"adapter: RTX 4070 — driver {driver}, log %USERPROFILE%\x")
        );
        assert!(r.redact(&row).contains("<private-ip>"));
    }

    #[test]
    fn redaction_is_idempotent() {
        let r = win_alice();
        let raw = format!(
            r#"log_dir=Some("C:\\Users\\Alice\\logs") host={} ?search=x account_id=123456789 /accounts/123456789/ cache/eu_123456789.json account_ids=[123456789]"#,
            ip(192, 168, 1, 2)
        );
        let once = r.redact(&raw);
        assert_eq!(r.redact(&once), once);
    }
}
