use super::*;
/// A value from a narrow pickle-proto-2 subset — exactly the shapes the
/// `receiveDamageStat` payload uses (dict of `(i64, i64)` keys to
/// `[i64, f64]` lists). Anything outside the subset aborts the parse.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum PyVal {
    None,
    Int(i64),
    Float(f64),
    Tuple(Vec<PyVal>),
    List(Vec<PyVal>),
    Dict(Vec<(PyVal, PyVal)>),
}

/// Evaluate a pickle-proto-2 bytecode subset (see [`PyVal`]): a tiny stack
/// machine with the CPython metastack MARK semantics. Returns the single
/// top-level value, or `None` on truncated/unsupported opcodes (the caller
/// then just leaves that sample set empty — damage stats are an enhancement,
/// never a hard requirement).
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
