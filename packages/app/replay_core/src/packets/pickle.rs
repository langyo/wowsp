use super::*;
/// A value from a narrow pickle-proto-2 subset — the shapes the
/// `receiveDamageStat` payload uses (dict of `(i64, i64)` keys to
/// `[i64, f64]` lists) and the `onArenaStateReceived` player FixedDict uses
/// (lists of `(int key, int|str|bool value)` tuples). Anything outside the
/// subset aborts the parse.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum PyVal {
    None,
    Int(i64),
    Float(f64),
    Str(String),
    Tuple(Vec<PyVal>),
    List(Vec<PyVal>),
    Dict(Vec<(PyVal, PyVal)>),
}

/// Evaluate a pickle-proto-2 bytecode subset (see [`PyVal`]): a tiny stack
/// machine with the CPython metastack MARK semantics. Returns the single
/// top-level value, or `None` on truncated/unsupported opcodes (the caller
/// then just leaves that sample set empty — damage stats are an enhancement,
/// never a hard requirement).
/// Audit wowsp-R1-2: generous ceiling for the pickle memo table —
/// legitimate WoWs replays have a few hundred entries; hostile
/// bytecode must not drive unbounded allocation (a 6-byte sequence
/// with LONG_BINPUT u32::MAX tried to resize to ~240GB).
const MAX_MEMO_ENTRIES: usize = 64 * 1024;
/// Audit M-8: the memo table and its BINGET echoes DEEP-COPY values, so
/// the entry count alone does not bound memory — a hostile stream can
/// multiply one large string across every memo slot and echo it onto the
/// stack thousands of times (O(blob²) in input size). Every clone is
/// charged to this byte budget; exceeding it aborts the parse. Legitimate
/// replay pickles clone a few hundred KB at most.
const MAX_CLONED_BYTES: usize = 64 * 1024 * 1024;
/// `deep_size` recursion guard. Values are built by this very parser, so
/// anything at or past this depth is hostile by construction; it counts as
/// the whole budget and trips it. Deliberately BELOW [`MAX_VALUE_DEPTH`]
/// (128): a legal 65..128-deep value is not refused, but memoizing it
/// charges the full clone budget here, so echoing such a value dies on
/// the budget instead of the depth — refuse-late either way.
const DEEP_SIZE_MAX_DEPTH: usize = 64;
/// Audit M-8 review: MARK nesting builds nested `PyVal`s whose RECURSIVE
/// DROP overflows the stack on hostile input (~300 KB of MARK+LIST pairs
/// reaches ~100k levels — the allocation succeeds, the cleanup aborts).
/// Legitimate replay pickles nest a handful of levels.
const MAX_META_DEPTH: usize = 256;

/// Approximate retained size of a parsed value (bytes, conservative).
fn deep_size(v: &PyVal) -> usize {
    fn rec(v: &PyVal, depth: usize) -> usize {
        if depth >= DEEP_SIZE_MAX_DEPTH {
            // Hostile nesting: pessimistically charge the entire budget so
            // the caller aborts instead of recursing further.
            return MAX_CLONED_BYTES;
        }
        match v {
            PyVal::None | PyVal::Int(_) | PyVal::Float(_) => 16,
            PyVal::Str(s) => s.len() + 24,
            PyVal::Tuple(t) | PyVal::List(t) => {
                16 + t.iter().map(|x| rec(x, depth + 1)).sum::<usize>()
            },
            PyVal::Dict(d) => {
                16 + d
                    .iter()
                    .map(|(k, x)| rec(k, depth + 1).saturating_add(rec(x, depth + 1)))
                    .sum::<usize>()
            },
        }
    }
    rec(v, 0)
}

/// The maximum tree height (nesting depth) a parsed value may reach —
/// the recursive Drop's frame count when the value is discarded. Real
/// payloads nest 3–5 deep; 128 keeps headroom while refusing a hostile
/// 2-bytes-per-level `]`+`a` chain (~32k deep inside the 64 KiB arena
/// blob) long before the drop glue can overflow the stack (audit M-8
/// follow-up: MARK capping alone left this path unguarded).
const MAX_VALUE_DEPTH: usize = 128;

/// A parse-stack entry: the value plus its tree height. Heights compose
/// at every container-building opcode and every composition is checked
/// against [`MAX_VALUE_DEPTH`] — via the in-place guards on the
/// mutation opcodes (APPEND/APPENDS/SETITEM/SETITEMS) and via
/// [`push_checked`] on the composition arms (TUPLE*/LIST) — so no value
/// the parser hands out, or drops mid-parse (REDUCE/BUILD operands),
/// ever recurses deeper than that on Drop.
type Stacked = (PyVal, usize);

/// Push a composed container, refusing trees past [`MAX_VALUE_DEPTH`]
/// before they enter the stack.
fn push_checked(stack: &mut Vec<Stacked>, entry: Stacked) -> Option<()> {
    if entry.1 > MAX_VALUE_DEPTH {
        return None;
    }
    stack.push(entry);
    Some(())
}

/// Split a mark-pop's entries into values plus the composed container's
/// height (one above the deepest child).
fn unzip_stack(entries: Vec<Stacked>) -> (Vec<PyVal>, usize) {
    let h = entries.iter().map(|(_, h)| *h).max().unwrap_or(0) + 1;
    (entries.into_iter().map(|(v, _)| v).collect(), h)
}

pub(super) fn parse_pickle(bytes: &[u8]) -> Option<PyVal> {
    let mut stack: Vec<Stacked> = Vec::new();
    let mut metastack: Vec<Vec<Stacked>> = Vec::new();
    // Memo entries carry their deep size (the clone budget) and height
    // (BINGET re-pushes both) so echoes charge without re-walking.
    let mut memo: Vec<Option<(PyVal, usize, usize)>> = Vec::new();
    let mut cloned_bytes = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let op = bytes[i];
        i += 1;
        match op {
            0x80 => i += 1, // PROTO (version byte)
            0x28 => {
                // MARK '(' — depth-capped: hostile nesting would otherwise
                // build PyVal trees whose recursive Drop overflows the
                // stack long before any byte budget notices (audit M-8).
                if metastack.len() >= MAX_META_DEPTH {
                    return None;
                }
                metastack.push(std::mem::take(&mut stack));
            },
            0x4e => stack.push((PyVal::None, 0)), // NONE 'N'
            0x4b => {
                // BININT1 'K' — u8
                stack.push((PyVal::Int(*bytes.get(i)? as i64), 0));
                i += 1;
            },
            0x4d => {
                // BININT2 'M' — u16 LE
                stack.push((
                    PyVal::Int(u16::from_le_bytes(read_bytes(bytes, i)?) as i64),
                    0,
                ));
                i += 2;
            },
            0x4a => {
                // BININT 'J' — i32 LE
                stack.push((
                    PyVal::Int(i32::from_le_bytes(read_bytes(bytes, i)?) as i64),
                    0,
                ));
                i += 4;
            },
            0x8a => {
                // LONG1 — 1-byte length + little-endian two's-complement payload.
                // Payloads beyond i64 width are outside the supported subset.
                let n = *bytes.get(i)? as usize;
                i += 1;
                if n > 8 {
                    return None;
                }
                let raw = bytes.get(i..i + n)?;
                i += n;
                let mut v: i64 = 0;
                for (k, b) in raw.iter().enumerate() {
                    v |= (*b as i64) << (8 * k);
                }
                // Sign-extend from the last payload byte (n == 8 needs none).
                if n > 0 && n < 8 {
                    let shift = 64 - 8 * n;
                    v = (v << shift) >> shift;
                }
                stack.push((PyVal::Int(v), 0));
            },
            0x47 => {
                // BINFLOAT 'G' — f64 BIG-endian (the pickle spec's one big-endian field)
                stack.push((PyVal::Float(f64::from_be_bytes(read_bytes(bytes, i)?)), 0));
                i += 8;
            },
            0x49 => {
                // INT 'I' — decimal text + newline ("I3973228240\n"), or the
                // CPython boolean spellings ("I01\n" / "I00\n") the arena
                // blobs carry alongside plain integers.
                let end = bytes[i..].iter().position(|&b| b == b'\n')? + i;
                let text = std::str::from_utf8(&bytes[i..end]).ok()?;
                i = end + 1;
                let value = match text.trim() {
                    "01" => 1,
                    "00" | "" => 0,
                    other => other.parse().ok()?,
                };
                stack.push((PyVal::Int(value), 0));
            },
            0x4c => {
                // LONG 'L' — decimal text + optional 'L' suffix + newline.
                let end = bytes[i..].iter().position(|&b| b == b'\n')? + i;
                let text = std::str::from_utf8(&bytes[i..end]).ok()?;
                i = end + 1;
                stack.push((
                    PyVal::Int(text.trim().trim_end_matches('L').parse().ok()?),
                    0,
                ));
            },
            0x63 => {
                // GLOBAL 'c' — "module\nname\n" (a class constructor). Pushed
                // as an opaque placeholder: arena FixedDicts carry object
                // fields (CamouflageInfo, dogTag) the identity join never
                // reads; the decoders only need the stack to stay balanced.
                let m_end = bytes[i..].iter().position(|&b| b == b'\n')? + i;
                let n_end = bytes[m_end + 1..].iter().position(|&b| b == b'\n')? + m_end + 1;
                let module = std::str::from_utf8(&bytes[i..m_end]).ok()?;
                let name = std::str::from_utf8(&bytes[m_end + 1..n_end]).ok()?;
                i = n_end + 1;
                stack.push((PyVal::Str(format!("{module}.{name}")), 0));
            },
            0x52 => {
                // REDUCE 'R' — pop args + callable, push an opaque result.
                let _args = stack.pop()?;
                let _callable = stack.pop()?;
                stack.push((PyVal::Str("<reduced>".into()), 0));
            },
            0x81 => {
                // NEWOBJ — pop args + class, push an opaque object.
                let _args = stack.pop()?;
                let _cls = stack.pop()?;
                stack.push((PyVal::Str("<obj>".into()), 0));
            },
            0x62 => {
                // BUILD 'b' — pop state + object, keep the object.
                let _state = stack.pop()?;
                let obj = stack.pop()?;
                stack.push(obj);
            },
            0x29 => stack.push((PyVal::Tuple(Vec::new()), 1)), // EMPTY_TUPLE ')'
            0x55 => {
                // SHORT_BINSTRING 'U' — u8 length + raw UTF-8 bytes (proto ≤2 str).
                let n = *bytes.get(i)? as usize;
                i += 1;
                let raw = bytes.get(i..i + n)?;
                i += n;
                stack.push((PyVal::Str(String::from_utf8_lossy(raw).into_owned()), 0));
            },
            0x54 => {
                // BINSTRING 'T' — u32 LE length + raw bytes (proto ≤2 str
                // twin of BINUNICODE 'X'). The 15.9 arena player blob fields
                // one name through this opcode; without the arm the whole
                // FixedDict parse aborts. The range get bounds a claimed
                // length by the input — no allocation on hostile sizes.
                let n = u32::from_le_bytes(read_bytes(bytes, i)?) as usize;
                i += 4;
                let raw = bytes.get(i..i + n)?;
                i += n;
                stack.push((PyVal::Str(String::from_utf8_lossy(raw).into_owned()), 0));
            },
            0x58 => {
                // BINUNICODE 'X' — u32 length + UTF-8 bytes.
                let n = u32::from_le_bytes(read_bytes(bytes, i)?) as usize;
                i += 4;
                let raw = bytes.get(i..i + n)?;
                i += n;
                stack.push((PyVal::Str(String::from_utf8_lossy(raw).into_owned()), 0));
            },
            0x8c => {
                // SHORT_BINUNICODE (proto 4) — u8 length + UTF-8 bytes.
                let n = *bytes.get(i)? as usize;
                i += 1;
                let raw = bytes.get(i..i + n)?;
                i += n;
                stack.push((PyVal::Str(String::from_utf8_lossy(raw).into_owned()), 0));
            },
            0x88 => stack.push((PyVal::Int(1), 0)), // NEWTRUE
            0x89 => stack.push((PyVal::Int(0), 0)), // NEWFALSE
            0x85 => {
                // TUPLE1 — one byte per nesting level over a scalar seed:
                // the composition arms are checked exactly like the
                // mutation arms (audit M-8 follow-up; the first fix
                // missed this family and a seeded `85`×N chain bypassed
                // the cap byte-for-byte).
                let (a, ha) = stack.pop()?;
                push_checked(&mut stack, (PyVal::Tuple(vec![a]), ha + 1))?;
            },
            0x87 => {
                // TUPLE3
                let (c, hc) = stack.pop()?;
                let (b, hb) = stack.pop()?;
                let (a, ha) = stack.pop()?;
                push_checked(
                    &mut stack,
                    (PyVal::Tuple(vec![a, b, c]), ha.max(hb).max(hc) + 1),
                )?;
            },
            0x86 => {
                // TUPLE2
                let (b, hb) = stack.pop()?;
                let (a, ha) = stack.pop()?;
                push_checked(&mut stack, (PyVal::Tuple(vec![a, b]), ha.max(hb) + 1))?;
            },
            0x74 => {
                // TUPLE 't' — everything back to the mark
                let (items, h) = unzip_stack(pop_mark(&mut stack, &mut metastack)?);
                push_checked(&mut stack, (PyVal::Tuple(items), h))?;
            },
            0x5d => stack.push((PyVal::List(Vec::new()), 1)), // EMPTY_LIST ']'
            0x7d => stack.push((PyVal::Dict(Vec::new()), 1)), // EMPTY_DICT '}'
            0x6c => {
                // LIST 'l' — everything back to the mark
                let (items, h) = unzip_stack(pop_mark(&mut stack, &mut metastack)?);
                push_checked(&mut stack, (PyVal::List(items), h))?;
            },
            0x61 => {
                // APPEND 'a' — the composed list's height is one above the
                // appended child's; refuse past MAX_VALUE_DEPTH before the
                // tree that would recurse-drop can exist (audit M-8).
                let (v, vh) = stack.pop()?;
                let (l, h) = stack.last_mut()?;
                match l {
                    PyVal::List(l) => l.push(v),
                    _ => return None,
                }
                *h = (*h).max(vh + 1);
                if *h > MAX_VALUE_DEPTH {
                    return None;
                }
            },
            0x65 => {
                // APPENDS 'e' — items back to the mark, into the list below them
                let (items, ih) = unzip_stack(pop_mark(&mut stack, &mut metastack)?);
                let (l, h) = stack.last_mut()?;
                match l {
                    PyVal::List(l) => l.extend(items),
                    _ => return None,
                }
                *h = (*h).max(ih);
                if *h > MAX_VALUE_DEPTH {
                    return None;
                }
            },
            0x73 => {
                // SETITEM 's' — value + key into the dict below them
                let (value, vh) = stack.pop()?;
                let (key, kh) = stack.pop()?;
                let (d, h) = stack.last_mut()?;
                match d {
                    PyVal::Dict(d) => d.push((key, value)),
                    _ => return None,
                }
                *h = (*h).max(vh + 1).max(kh + 1);
                if *h > MAX_VALUE_DEPTH {
                    return None;
                }
            },
            0x75 => {
                // SETITEMS 'u' — pairs back to the mark, into the dict below
                // them. Moves (never clones) the popped items — audit M-8:
                // this opcode used to deep-copy every pair on top of the
                // copy the mark-pop already made.
                let (items, ih) = unzip_stack(pop_mark(&mut stack, &mut metastack)?);
                if items.len() % 2 != 0 {
                    return None;
                }
                let (d, h) = stack.last_mut()?;
                match d {
                    PyVal::Dict(d) => {
                        let mut pairs = items.into_iter();
                        while let (Some(key), Some(value)) = (pairs.next(), pairs.next()) {
                            d.push((key, value));
                        }
                    },
                    _ => return None,
                }
                *h = (*h).max(ih);
                if *h > MAX_VALUE_DEPTH {
                    return None;
                }
            },
            0x71 => {
                // BINPUT 'q' — memoize the top of stack (1-byte index)
                let idx = *bytes.get(i)? as usize;
                i += 1;
                if idx >= MAX_MEMO_ENTRIES {
                    return None;
                }
                if let Some((v, h)) = stack.last() {
                    let size = deep_size(v);
                    cloned_bytes = cloned_bytes.saturating_add(size);
                    if cloned_bytes > MAX_CLONED_BYTES {
                        return None;
                    }
                    if memo.len() <= idx {
                        memo.resize(idx + 1, None);
                    }
                    memo[idx] = Some((v.clone(), size, *h));
                }
            },
            0x72 => {
                // LONG_BINPUT 'r' — same with a 4-byte index
                let idx = u32::from_le_bytes(read_bytes(bytes, i)?) as usize;
                i += 4;
                if idx >= MAX_MEMO_ENTRIES {
                    return None;
                }
                if let Some((v, h)) = stack.last() {
                    let size = deep_size(v);
                    cloned_bytes = cloned_bytes.saturating_add(size);
                    if cloned_bytes > MAX_CLONED_BYTES {
                        return None;
                    }
                    if memo.len() <= idx {
                        memo.resize(idx + 1, None);
                    }
                    memo[idx] = Some((v.clone(), size, *h));
                }
            },
            0x68 => {
                // BINGET 'h' — push a memoized value back. The push is a
                // DEEP copy (audit M-8): charge it to the clone budget.
                let idx = *bytes.get(i)? as usize;
                i += 1;
                let (v, size, h) = memo.get(idx)?.as_ref()?;
                cloned_bytes = cloned_bytes.saturating_add(*size);
                if cloned_bytes > MAX_CLONED_BYTES {
                    return None;
                }
                stack.push((v.clone(), *h));
            },
            0x6a => {
                // LONG_BINGET 'j'
                let idx = u32::from_le_bytes(read_bytes(bytes, i)?) as usize;
                i += 4;
                let (v, size, h) = memo.get(idx)?.as_ref()?;
                cloned_bytes = cloned_bytes.saturating_add(*size);
                if cloned_bytes > MAX_CLONED_BYTES {
                    return None;
                }
                stack.push((v.clone(), *h));
            },
            0x2e => break, // STOP '.'
            _ => return None,
        }
    }
    stack.pop().map(|(v, _)| v)
}

/// Pop the current stack back to the last MARK (CPython `pop_mark`).
fn pop_mark(stack: &mut Vec<Stacked>, metastack: &mut Vec<Vec<Stacked>>) -> Option<Vec<Stacked>> {
    let items = std::mem::take(stack);
    *stack = metastack.pop()?;
    Some(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Audit wowsp-R1-2 regression: a 6-byte hostile sequence (push one
    /// value + LONG_BINPUT with `u32::MAX`) drove `memo.resize(idx + 1, …)`
    /// into a ~240GB allocation — an uncatchable abort on opening a
    /// malicious replay. The clamp must degrade to `None` instead.
    #[test]
    fn long_binput_hostile_index_is_rejected() {
        let hostile = [
            0x80, 0x04, // PROTO 2
            0x4b, 0x01, // BININT1 1
            0x72, 0xff, 0xff, 0xff, 0xff, // LONG_BINPUT u32::MAX
        ];
        assert_eq!(parse_pickle(&hostile), None);
    }

    /// The clamp's ceiling is far above anything legitimate: a LONG_BINPUT
    /// just under 64 KiB still parses (and memoizes a value back out).
    #[test]
    fn long_binput_roundtrip_under_the_ceiling() {
        let idx: u32 = (MAX_MEMO_ENTRIES - 1) as u32;
        let mut bytes = vec![0x80, 0x04, 0x4b, 0x07, 0x72];
        bytes.extend_from_slice(&idx.to_le_bytes());
        // LONG_BINGET the same index back onto the stack, then STOP.
        bytes.extend_from_slice(&[0x6a]);
        bytes.extend_from_slice(&idx.to_le_bytes());
        bytes.push(0x2e);
        assert_eq!(parse_pickle(&bytes), Some(PyVal::Int(7)));
    }

    /// BINPUT/BINGET (the 1-byte index pair) memoize and replay intact.
    #[test]
    fn binput_binget_roundtrip() {
        let bytes = [0x80, 0x04, 0x4b, 0x05, 0x71, 0x00, 0x68, 0x00, 0x2e];
        assert_eq!(parse_pickle(&bytes), Some(PyVal::Int(5)));
    }

    /// BINSTRING 'T' — the u32-length proto ≤2 string twin of BINUNICODE —
    /// decodes as a Str. The 15.9 arena player blob fields one nickname
    /// through this opcode (the WW2 operation replay, user report
    /// 2026-10-26): without the arm the whole FixedDict parse aborted and
    /// the arena state was lost for every 15.9 battle.
    #[test]
    fn binstring_u32_length_decodes() {
        let mut bytes = vec![0x80, 0x02, 0x54];
        bytes.extend_from_slice(&(b"langyo".len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"langyo");
        bytes.push(0x2e);
        assert_eq!(parse_pickle(&bytes), Some(PyVal::Str("langyo".into())));
    }

    /// A hostile BINSTRING whose claimed length runs past the input must
    /// degrade to `None` — the range read bounds it by the input, never
    /// allocating from the claim.
    #[test]
    fn binstring_hostile_length_is_rejected() {
        let mut bytes = vec![0x80, 0x02, 0x54];
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        bytes.extend_from_slice(b"tiny");
        bytes.push(0x2e);
        assert_eq!(parse_pickle(&bytes), None);
    }

    /// INT 'I' — the CPython boolean spellings the arena blobs carry
    /// alongside plain decimal integers.
    #[test]
    fn int_boolean_spellings_decode() {
        let mut one = vec![0x80, 0x02];
        one.extend_from_slice(b"I01\n");
        one.push(0x2e);
        assert_eq!(parse_pickle(&one), Some(PyVal::Int(1)));
        let mut zero = vec![0x80, 0x02];
        zero.extend_from_slice(b"I00\n");
        zero.push(0x2e);
        assert_eq!(parse_pickle(&zero), Some(PyVal::Int(0)));
        let mut plain = vec![0x80, 0x02];
        plain.extend_from_slice(b"I397\n");
        plain.push(0x2e);
        assert_eq!(parse_pickle(&plain), Some(PyVal::Int(397)));
    }

    /// Build `proto + BINUNICODE(blob) + LONG_BINPUT idx`.
    fn memoize(blob: &[u8], idx: u32) -> Vec<u8> {
        let mut bytes = vec![0x80, 0x04, 0x58];
        bytes.extend_from_slice(&(blob.len() as u32).to_le_bytes());
        bytes.extend_from_slice(blob);
        bytes.push(0x72);
        bytes.extend_from_slice(&idx.to_le_bytes());
        bytes
    }

    /// Audit M-8: re-memoizing one large string across the budget forces a
    /// deep clone per opcode — the parse must abort on the byte budget
    /// (bounded work) instead of multiplying the blob into OOM.
    #[test]
    fn memo_reflood_aborts_on_the_clone_budget() {
        let blob = vec![b'A'; 1_000_000];
        let mut bytes = memoize(&blob, 7);
        for _ in 0..200 {
            bytes.push(0x72);
            bytes.extend_from_slice(&7u32.to_le_bytes());
        }
        bytes.push(0x2e);
        assert_eq!(parse_pickle(&bytes), None);
    }

    /// The BINGET echo of the same attack: one memoized megabyte echoed
    /// onto the stack thousands of times hits the same budget.
    #[test]
    fn binget_echo_flood_aborts_on_the_clone_budget() {
        let blob = vec![b'A'; 1_000_000];
        let mut bytes = memoize(&blob, 7);
        for _ in 0..200 {
            bytes.push(0x6a);
            bytes.extend_from_slice(&7u32.to_le_bytes());
        }
        bytes.push(0x2e);
        assert_eq!(parse_pickle(&bytes), None);
    }

    /// Legitimate traffic is orders of magnitude under the budget: a small
    /// string memoized and echoed a hundred times still parses.
    #[test]
    fn small_memo_traffic_still_parses_under_the_budget() {
        let blob = vec![b'B'; 1_000];
        let mut bytes = memoize(&blob, 3);
        for _ in 0..100 {
            bytes.push(0x6a);
            bytes.extend_from_slice(&3u32.to_le_bytes());
        }
        bytes.push(0x2e);
        let parsed = parse_pickle(&bytes);
        assert!(matches!(parsed, Some(PyVal::Str(_))), "{parsed:?}");
    }

    /// Audit M-8 review: hostile MARK nesting builds PyVal trees whose
    /// recursive DROP overflows the stack — the allocations succeed, the
    /// cleanup aborts. The metastack depth cap must refuse the parse
    /// cheaply, well before the values exist.
    #[test]
    fn hostile_mark_nesting_is_depth_capped() {
        let mut bytes = vec![0x80, 0x04];
        for _ in 0..100_000 {
            // MARK + EMPTY_LIST — ~3 bytes per nesting level.
            bytes.extend_from_slice(&[0x28, 0x5d]);
        }
        bytes.push(0x2e);
        assert_eq!(parse_pickle(&bytes), None);
    }

    /// The historical "legitimate nesting" shape — a 64-element list of
    /// empty lists (flat, height 2; the old comment overstated it as
    /// 64-deep nesting) — still parses under the height cap.
    #[test]
    fn legitimate_nesting_still_parses() {
        let mut bytes = vec![0x80, 0x04, 0x5d]; // EMPTY_LIST (outermost)
        for _ in 0..64 {
            // EMPTY_LIST (inner) + APPEND — nests the inner into the outer.
            bytes.extend_from_slice(&[0x5d, 0x61]);
        }
        bytes.push(0x2e);
        assert!(matches!(parse_pickle(&bytes), Some(PyVal::List(_))));
    }

    /// Audit M-8 follow-up regression: a `]`×n + `a`×(n-1) chain nests one
    /// list per two bytes WITHOUT ever touching MARK — the metastack cap
    /// never sees it, and the value's recursive Drop overflows the stack
    /// at ~32k levels inside the 64 KiB arena blob. The value-height
    /// tracking must refuse the chain; the deep tree must never exist.
    #[test]
    fn hostile_list_append_chain_is_height_capped() {
        let mut bytes = vec![0x80, 0x04];
        bytes.extend(std::iter::repeat(0x5d).take(100_000)); // EMPTY_LIST ×n
        bytes.extend(std::iter::repeat(0x61).take(99_999)); // APPEND ×(n-1)
        bytes.push(0x2e);
        assert_eq!(parse_pickle(&bytes), None);
    }

    /// Audit M-8 follow-up regression (the bypass the first fix missed):
    /// a seeded TUPLE1 chain nests one level PER BYTE — no MARK, no
    /// APPEND — so the composition arms must be checked exactly like the
    /// mutation arms. Before the check these arms composed the height but
    /// pushed unconditionally, and the returned tree's recursive Drop
    /// aborted the process.
    #[test]
    fn hostile_tuple1_chain_is_height_capped() {
        // Scalar seed + 200 TUPLE1s: each wraps the previous, height 200.
        let mut bytes = vec![0x80, 0x04, 0x4b, 0x01];
        bytes.extend(std::iter::repeat(0x85).take(200));
        bytes.push(0x2e);
        assert_eq!(parse_pickle(&bytes), None);
    }

    /// The accept side of both composition families at the exact cap:
    /// 128 TUPLE1s over a scalar compose height 128 (the maximum), and a
    /// 128-deep APPEND chain still parses.
    #[test]
    fn tuple_and_append_chains_at_the_cap_still_parse() {
        let mut bytes = vec![0x80, 0x04, 0x4b, 0x01];
        bytes.extend(std::iter::repeat(0x85).take(128));
        bytes.push(0x2e);
        assert!(matches!(parse_pickle(&bytes), Some(PyVal::Tuple(_))));

        let mut bytes = vec![0x80, 0x04];
        bytes.extend(std::iter::repeat(0x5d).take(128));
        bytes.extend(std::iter::repeat(0x61).take(127));
        bytes.push(0x2e);
        assert!(matches!(parse_pickle(&bytes), Some(PyVal::List(_))));
    }

    /// The cap is a hard limit, not a fuzz boundary: one level past it
    /// refuses on the APPEND family too.
    #[test]
    fn list_chain_respects_the_exact_height_boundary() {
        // 130 empty lists + 129 appends would nest 130 deep — one past
        // MAX_VALUE_DEPTH (the 128th append composes height 129).
        let mut bytes = vec![0x80, 0x04];
        bytes.extend(std::iter::repeat(0x5d).take(130));
        bytes.extend(std::iter::repeat(0x61).take(129));
        bytes.push(0x2e);
        assert_eq!(parse_pickle(&bytes), None);
        // One past on the TUPLE family: 129 TUPLE1s compose height 129.
        let mut bytes = vec![0x80, 0x04, 0x4b, 0x01];
        bytes.extend(std::iter::repeat(0x85).take(129));
        bytes.push(0x2e);
        assert_eq!(parse_pickle(&bytes), None);
    }
}
