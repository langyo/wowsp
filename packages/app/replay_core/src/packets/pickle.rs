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

pub(super) fn parse_pickle(bytes: &[u8]) -> Option<PyVal> {
    let mut stack: Vec<PyVal> = Vec::new();
    let mut metastack: Vec<Vec<PyVal>> = Vec::new();
    let mut memo: Vec<PyVal> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let op = bytes[i];
        i += 1;
        match op {
            0x80 => i += 1,                                     // PROTO (version byte)
            0x28 => metastack.push(std::mem::take(&mut stack)), // MARK '('
            0x4e => stack.push(PyVal::None),                    // NONE 'N'
            0x4b => {
                // BININT1 'K' — u8
                stack.push(PyVal::Int(*bytes.get(i)? as i64));
                i += 1;
            },
            0x4d => {
                // BININT2 'M' — u16 LE
                stack.push(PyVal::Int(u16::from_le_bytes(read_bytes(bytes, i)?) as i64));
                i += 2;
            },
            0x4a => {
                // BININT 'J' — i32 LE
                stack.push(PyVal::Int(i32::from_le_bytes(read_bytes(bytes, i)?) as i64));
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
                stack.push(PyVal::Int(v));
            },
            0x47 => {
                // BINFLOAT 'G' — f64 BIG-endian (the pickle spec's one big-endian field)
                stack.push(PyVal::Float(f64::from_be_bytes(read_bytes(bytes, i)?)));
                i += 8;
            },
            0x49 => {
                // INT 'I' — decimal text + newline ("I3973228240\n").
                let end = bytes[i..].iter().position(|&b| b == b'\n')? + i;
                let text = std::str::from_utf8(&bytes[i..end]).ok()?;
                i = end + 1;
                stack.push(PyVal::Int(text.trim().parse().ok()?));
            },
            0x4c => {
                // LONG 'L' — decimal text + optional 'L' suffix + newline.
                let end = bytes[i..].iter().position(|&b| b == b'\n')? + i;
                let text = std::str::from_utf8(&bytes[i..end]).ok()?;
                i = end + 1;
                stack.push(PyVal::Int(text.trim().trim_end_matches('L').parse().ok()?));
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
                stack.push(PyVal::Str(format!("{module}.{name}")));
            },
            0x52 => {
                // REDUCE 'R' — pop args + callable, push an opaque result.
                let _args = stack.pop()?;
                let _callable = stack.pop()?;
                stack.push(PyVal::Str("<reduced>".into()));
            },
            0x81 => {
                // NEWOBJ — pop args + class, push an opaque object.
                let _args = stack.pop()?;
                let _cls = stack.pop()?;
                stack.push(PyVal::Str("<obj>".into()));
            },
            0x62 => {
                // BUILD 'b' — pop state + object, keep the object.
                let _state = stack.pop()?;
                let obj = stack.pop()?;
                stack.push(obj);
            },
            0x29 => stack.push(PyVal::Tuple(Vec::new())), // EMPTY_TUPLE ')'
            0x55 => {
                // SHORT_BINSTRING 'U' — u8 length + raw UTF-8 bytes (proto ≤2 str).
                let n = *bytes.get(i)? as usize;
                i += 1;
                let raw = bytes.get(i..i + n)?;
                i += n;
                stack.push(PyVal::Str(String::from_utf8_lossy(raw).into_owned()));
            },
            0x58 => {
                // BINUNICODE 'X' — u32 length + UTF-8 bytes.
                let n = u32::from_le_bytes(read_bytes(bytes, i)?) as usize;
                i += 4;
                let raw = bytes.get(i..i + n)?;
                i += n;
                stack.push(PyVal::Str(String::from_utf8_lossy(raw).into_owned()));
            },
            0x8c => {
                // SHORT_BINUNICODE (proto 4) — u8 length + UTF-8 bytes.
                let n = *bytes.get(i)? as usize;
                i += 1;
                let raw = bytes.get(i..i + n)?;
                i += n;
                stack.push(PyVal::Str(String::from_utf8_lossy(raw).into_owned()));
            },
            0x88 => stack.push(PyVal::Int(1)), // NEWTRUE
            0x89 => stack.push(PyVal::Int(0)), // NEWFALSE
            0x85 => {
                // TUPLE1
                let a = stack.pop()?;
                stack.push(PyVal::Tuple(vec![a]));
            },
            0x87 => {
                // TUPLE3
                let c = stack.pop()?;
                let b = stack.pop()?;
                let a = stack.pop()?;
                stack.push(PyVal::Tuple(vec![a, b, c]));
            },
            0x86 => {
                // TUPLE2
                let b = stack.pop()?;
                let a = stack.pop()?;
                stack.push(PyVal::Tuple(vec![a, b]));
            },
            0x74 => {
                // TUPLE 't' — everything back to the mark
                let items = pop_mark(&mut stack, &mut metastack)?;
                stack.push(PyVal::Tuple(items));
            },
            0x5d => stack.push(PyVal::List(Vec::new())), // EMPTY_LIST ']'
            0x7d => stack.push(PyVal::Dict(Vec::new())), // EMPTY_DICT '}'
            0x6c => {
                // LIST 'l' — everything back to the mark
                let items = pop_mark(&mut stack, &mut metastack)?;
                stack.push(PyVal::List(items));
            },
            0x61 => {
                // APPEND 'a'
                let v = stack.pop()?;
                match stack.last_mut()? {
                    PyVal::List(l) => l.push(v),
                    _ => return None,
                }
            },
            0x65 => {
                // APPENDS 'e' — items back to the mark, into the list below them
                let items = pop_mark(&mut stack, &mut metastack)?;
                match stack.last_mut()? {
                    PyVal::List(l) => l.extend(items),
                    _ => return None,
                }
            },
            0x73 => {
                // SETITEM 's' — value + key into the dict below them
                let value = stack.pop()?;
                let key = stack.pop()?;
                match stack.last_mut()? {
                    PyVal::Dict(d) => d.push((key, value)),
                    _ => return None,
                }
            },
            0x75 => {
                // SETITEMS 'u' — pairs back to the mark, into the dict below them
                let items = pop_mark(&mut stack, &mut metastack)?;
                if items.len() % 2 != 0 {
                    return None;
                }
                match stack.last_mut()? {
                    PyVal::Dict(d) => {
                        for pair in items.chunks_exact(2) {
                            d.push((pair[0].clone(), pair[1].clone()));
                        }
                    },
                    _ => return None,
                }
            },
            0x71 => {
                // BINPUT 'q' — memoize the top of stack (1-byte index)
                let idx = *bytes.get(i)? as usize;
                i += 1;
                if idx >= MAX_MEMO_ENTRIES {
                    return None;
                }
                if let Some(v) = stack.last() {
                    if memo.len() <= idx {
                        memo.resize(idx + 1, PyVal::None);
                    }
                    memo[idx] = v.clone();
                }
            },
            0x72 => {
                // LONG_BINPUT 'r' — same with a 4-byte index
                let idx = u32::from_le_bytes(read_bytes(bytes, i)?) as usize;
                i += 4;
                if idx >= MAX_MEMO_ENTRIES {
                    return None;
                }
                if let Some(v) = stack.last() {
                    if memo.len() <= idx {
                        memo.resize(idx + 1, PyVal::None);
                    }
                    memo[idx] = v.clone();
                }
            },
            0x68 => {
                // BINGET 'h' — push a memoized value back
                let idx = *bytes.get(i)? as usize;
                i += 1;
                stack.push(memo.get(idx)?.clone());
            },
            0x6a => {
                // LONG_BINGET 'j'
                let idx = u32::from_le_bytes(read_bytes(bytes, i)?) as usize;
                i += 4;
                stack.push(memo.get(idx)?.clone());
            },
            0x2e => break, // STOP '.'
            _ => return None,
        }
    }
    stack.pop()
}

/// Pop the current stack back to the last MARK (CPython `pop_mark`).
fn pop_mark(stack: &mut Vec<PyVal>, metastack: &mut Vec<Vec<PyVal>>) -> Option<Vec<PyVal>> {
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
}
