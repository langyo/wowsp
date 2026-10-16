//! Incremental JSON container scanner — the pure byte state machine both
//! transports' partial-row scans ride. Split from the former single-file
//! `commands/ship_stats.rs`.

// ── Incremental JSON container scanner ──────────────────────────────────

/// The target container's shape for a [`ContainerScanner`].
#[derive(Clone, Copy, PartialEq)]
pub(super) enum ContainerKind {
    /// An object whose children are `"key": value` entries (vortex
    /// `statistics`: ship-id-keyed nodes; the key IS the ship id).
    Map,
    /// An array whose children are bare values (WG `data.<account>`: one
    /// object per ship).
    Array,
}

impl ContainerKind {
    /// The byte that opens this container.
    fn open(self) -> u8 {
        match self {
            ContainerKind::Map => b'{',
            ContainerKind::Array => b'[',
        }
    }
}

/// One complete child element a scanner yields: the VALUE's half-open byte
/// range (stable while the buffer only ever grows) plus, for map children,
/// the parsed integer key.
pub(super) struct ScanEntry {
    pub(super) key: Option<i64>,
    pub(super) start: usize,
    pub(super) end: usize,
}

/// Where the scanner sits between the target container's children.
enum ChildState {
    /// At a child boundary: a map key string, a value start, or the
    /// container's closer.
    Next,
    /// A map child's key string was read; its ':' is the next token.
    Key,
    /// The ':' is consumed — the next token opens the value.
    AwaitValue { key: Option<i64> },
    /// Inside a child value. `own_depth` counts the value's open
    /// containers (1 = the value's own opening brace), `start` is the
    /// value's first byte, `key` carries the map child's key.
    Value {
        own_depth: usize,
        start: usize,
        key: Option<i64>,
    },
    /// A child value completed; ',' or the container's closer is next.
    ValueDone,
}

/// Incremental scanner for ONE JSON container inside a growing byte
/// buffer: locates the container at `path` (a chain of object keys from
/// the document root) and yields each complete child element as it
/// arrives. A pure byte state machine — feed it whatever arrived and drain
/// the entries; any chunking of the same byte stream yields identical
/// entries, because a token the buffer cannot yet complete leaves the
/// cursor at that token's first byte. Malformed input parks the scanner
/// permanently (it only ever fed transient partial rows — the caller's
/// full-document parse stays authoritative).
pub(super) struct ContainerScanner {
    kind: ContainerKind,
    path: Vec<String>,
    /// Next byte to examine.
    pos: usize,
    /// Open-container stack ('{' / '[') across the whole document.
    stack: Vec<u8>,
    /// Key-path of the open containers: `Some(key)` when the container is
    /// the value of an object member, `None` for the root and for array
    /// elements. The target matches when the named chain from the root
    /// equals `path` exactly.
    key_path: Vec<Option<String>>,
    /// Depth (`stack.len()`) of the target container once found.
    target_depth: Option<usize>,
    /// Last completed string token outside the target — promoted to a
    /// container key by the ':' (or '{'/'[') that follows it, cleared by
    /// any other token.
    last_string: Option<String>,
    child: ChildState,
    new_entries: Vec<ScanEntry>,
    finished: bool,
}

/// Index of the quote closing the string that starts at `quote_pos`.
/// None while the buffer has not reached it (escapes honored).
fn find_string_end(buf: &[u8], quote_pos: usize) -> Option<usize> {
    let mut i = quote_pos + 1;
    let mut escaped = false;
    while i < buf.len() {
        let b = buf[i];
        if escaped {
            escaped = false;
        } else if b == b'\\' {
            escaped = true;
        } else if b == b'"' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// End (exclusive) of a `true` / `false` / `null` literal. None while the
/// buffer is too short to carry the whole word.
fn find_literal_end(buf: &[u8], start: usize) -> Option<usize> {
    const WORDS: [&[u8]; 3] = [b"true", b"false", b"null"];
    for word in WORDS {
        if buf.len() >= start + word.len() && &buf[start..start + word.len()] == word {
            return Some(start + word.len());
        } else if buf.len() < start + word.len() && word.starts_with(&buf[start..]) {
            return None;
        }
    }
    // Not a literal prefix at all — malformed for our purposes; treat as
    // terminal desync by reporting a zero-length token the caller flags.
    Some(start)
}

/// End (exclusive) of a JSON number. None while the buffer ends inside the
/// digits (a trailing run with no delimiter yet could still grow).
fn find_number_end(buf: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < buf.len() && matches!(buf[i], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-') {
        i += 1;
    }
    if i == buf.len() { None } else { Some(i) }
}

impl ContainerScanner {
    pub(super) fn new(kind: ContainerKind, path: Vec<String>) -> Self {
        Self {
            kind,
            path,
            pos: 0,
            stack: Vec::new(),
            key_path: Vec::new(),
            target_depth: None,
            last_string: None,
            child: ChildState::Next,
            new_entries: Vec::new(),
            finished: false,
        }
    }

    /// Feed the buffer-so-far (any growth pattern) and drain the entries
    /// completed since the last call.
    pub(super) fn feed(&mut self, buf: &[u8]) -> Vec<ScanEntry> {
        self.new_entries.clear();
        while !self.finished && self.pos < buf.len() {
            let b = buf[self.pos];
            match b {
                b' ' | b'\t' | b'\n' | b'\r' => self.pos += 1,
                b'"' => {
                    let Some(end) = find_string_end(buf, self.pos) else {
                        break;
                    };
                    let content = String::from_utf8_lossy(&buf[self.pos + 1..end]).into_owned();
                    self.on_string(content, self.pos, end + 1);
                    self.pos = end + 1;
                },
                b'{' | b'[' => {
                    let open = b;
                    self.on_open(open, self.pos);
                    self.pos += 1;
                },
                b'}' | b']' => {
                    let close = b;
                    self.on_close(close, self.pos);
                    self.pos += 1;
                },
                b':' => {
                    self.on_colon();
                    self.pos += 1;
                },
                b',' => {
                    self.on_comma();
                    self.pos += 1;
                },
                b't' | b'f' | b'n' => {
                    let Some(end) = find_literal_end(buf, self.pos) else {
                        break;
                    };
                    if end == self.pos {
                        // Desync flagged by find_literal_end.
                        self.finished = true;
                        break;
                    }
                    self.on_value_token(self.pos, end);
                    self.pos = end;
                },
                b'-' | b'0'..=b'9' => {
                    let Some(end) = find_number_end(buf, self.pos) else {
                        break;
                    };
                    self.on_value_token(self.pos, end);
                    self.pos = end;
                },
                // Any other byte cannot occur in the JSON we fetch — park
                // the scanner rather than resync blindly.
                _ => self.finished = true,
            }
        }
        std::mem::take(&mut self.new_entries)
    }

    /// Record a completed child value and move to the post-value state.
    fn child_value_completed(&mut self, start: usize, end: usize, key: Option<i64>) {
        self.new_entries.push(ScanEntry { key, start, end });
        self.child = ChildState::ValueDone;
    }

    fn on_string(&mut self, content: String, start: usize, end: usize) {
        match self.target_depth {
            None => self.last_string = Some(content),
            Some(_) => match &mut self.child {
                ChildState::Next => {
                    if self.kind == ContainerKind::Map {
                        // A map child's key: hold it until the ':' arrives.
                        self.last_string = Some(content);
                        self.child = ChildState::Key;
                    } else {
                        // An array child that is a bare string — complete
                        // on the spot (our arrays carry objects, tolerate).
                        self.child_value_completed(start, end, None);
                    }
                },
                // A string inside a child value — structure-neutral.
                ChildState::Value { .. } => {},
                // "key" "string" / value "string" without structure between.
                ChildState::Key | ChildState::AwaitValue { .. } | ChildState::ValueDone => {
                    self.finished = true;
                },
            },
        }
    }

    fn on_value_token(&mut self, start: usize, end: usize) {
        match self.target_depth {
            None => self.last_string = None,
            Some(_) => match &mut self.child {
                ChildState::AwaitValue { key } => {
                    let key = *key;
                    self.child_value_completed(start, end, key);
                },
                // Numbers/literals inside a child value — neutral.
                ChildState::Value { .. } => {},
                ChildState::Next if self.kind == ContainerKind::Array => {
                    self.child_value_completed(start, end, None);
                },
                ChildState::Key | ChildState::Next | ChildState::ValueDone => {
                    self.finished = true;
                },
            },
        }
    }

    fn on_open(&mut self, open: u8, pos: usize) {
        match self.target_depth {
            None => {
                let key = self.last_string.take();
                self.stack.push(open);
                self.key_path.push(key);
                // The named chain from the root must equal `path`
                // exactly: unkeyed containers (root, array elements)
                // contribute no name, and a wrong turn that named an extra
                // ancestor disqualifies the subtree.
                let named_matches = self
                    .key_path
                    .iter()
                    .filter_map(|k| k.as_deref())
                    .eq(self.path.iter().map(|p| p.as_str()));
                if named_matches && open == self.kind.open() {
                    self.target_depth = Some(self.stack.len());
                    self.child = ChildState::Next;
                }
            },
            Some(_) => match &mut self.child {
                ChildState::Next if self.kind == ContainerKind::Array => {
                    self.child = ChildState::Value {
                        own_depth: 1,
                        start: pos,
                        key: None,
                    };
                },
                ChildState::AwaitValue { key } => {
                    let key = *key;
                    self.child = ChildState::Value {
                        own_depth: 1,
                        start: pos,
                        key,
                    };
                },
                ChildState::Value { own_depth, .. } => *own_depth += 1,
                // An object where a key/value/closer belongs.
                ChildState::Key | ChildState::Next | ChildState::ValueDone => {
                    self.finished = true;
                },
            },
        }
    }

    fn on_close(&mut self, _close: u8, pos: usize) {
        match self.target_depth {
            None => {
                self.stack.pop();
                self.key_path.pop();
                self.last_string = None;
            },
            Some(_) => match std::mem::replace(&mut self.child, ChildState::Next) {
                ChildState::Value {
                    mut own_depth,
                    start,
                    key,
                } => {
                    own_depth -= 1;
                    if own_depth == 0 {
                        // pos is the value's own closing brace.
                        self.child_value_completed(start, pos + 1, key);
                    } else {
                        self.child = ChildState::Value {
                            own_depth,
                            start,
                            key,
                        };
                    }
                },
                // The target container's own closer — done for good.
                ChildState::Next | ChildState::ValueDone => {
                    self.finished = true;
                },
                ChildState::Key | ChildState::AwaitValue { .. } => {
                    self.finished = true;
                },
            },
        }
    }

    fn on_colon(&mut self) {
        match self.target_depth {
            None => {},
            Some(_) => match std::mem::replace(&mut self.child, ChildState::Next) {
                ChildState::Key => {
                    // The held key string becomes this child's id (ship
                    // ids are the statistics map's keys; anything else
                    // parses to None and the entry is skipped upstream).
                    let key = self.last_string.take().and_then(|k| k.parse::<i64>().ok());
                    self.child = ChildState::AwaitValue { key };
                },
                // A ':' inside a child value is neutral; anywhere else in
                // the target container is a desync.
                other => self.child = other,
            },
        }
    }

    fn on_comma(&mut self) {
        match self.target_depth {
            None => self.last_string = None,
            Some(_) => match std::mem::replace(&mut self.child, ChildState::Next) {
                ChildState::ValueDone => {},
                // Commas inside a child value (between its own members)
                // are neutral.
                other => self.child = other,
            },
        }
    }
}
