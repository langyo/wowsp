//! Minimal `multipart/form-data` parse + build for the feedback endpoints.
//!
//! The worker could hand requests to `worker::FormData`, but the feedback
//! flow needs the file part's EXACT bytes (re-uploaded to Feishu verbatim)
//! and the same builder for the outbound Feishu multipart — a ~100-line
//! RFC 7578 subset with both directions host-testable wins over glue that
//! cannot be tested off-wasm.
//!
//! Supported subset (what browsers and this module's builder emit):
//! parts separated by `--<boundary>`, headers `Content-Disposition` (with
//! optional `filename`) and `Content-Type`, `\r\n` line endings, terminating
//! `--<boundary>--`.

/// One parsed part: `name` from Content-Disposition, optional `filename`,
/// and the raw body bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub name: String,
    pub filename: Option<String>,
    pub bytes: Vec<u8>,
}

/// Extract the boundary token from a `multipart/form-data; boundary=…`
/// Content-Type value. Guards against suffix false-positives
/// (`xboundary=`) by requiring a `;` (or start) before the key.
pub fn boundary_from_content_type(ct: &str) -> Option<String> {
    let idx = ct.find("boundary=")?;
    if idx > 0 {
        let prev = ct[..idx].chars().last()?;
        if prev != ';' && !prev.is_whitespace() {
            return None;
        }
    }
    let raw = ct[idx + "boundary=".len()..].trim();
    let raw = raw.strip_prefix('"').unwrap_or(raw);
    let raw = raw.strip_suffix('"').unwrap_or(raw);
    let token = raw.split(';').next().unwrap_or("").trim();
    (1..=70).contains(&token.len()).then(|| token.to_string())
}

/// Parse a full multipart body into its parts. `boundary` is the bare
/// token (no leading dashes). Unknown headers are skipped; a part without
/// a `name` disposition is dropped. A pathological body (delimiter spray)
/// is capped at [`MAX_PARTS`] sections — a feedback form has ~9 fields.
pub fn parse(boundary: &str, body: &[u8]) -> Vec<Part> {
    /// Ceiling on parsed sections (memory/CPU kindness on the Workers
    /// free tier; everything past it is attacker noise anyway).
    const MAX_PARTS: usize = 64;

    let delim = format!("--{boundary}");
    let mut parts = Vec::new();
    // Split on the delimiter as BYTES (filenames may be non-UTF-8).
    let mut sections: Vec<&[u8]> = Vec::new();
    let mut rest = body;
    let needle = delim.as_bytes();
    while let Some(pos) = find(rest, needle) {
        let (head, tail) = rest.split_at(pos);
        sections.push(head);
        rest = &tail[needle.len()..];
        // `--` right after the delimiter = final boundary.
        if rest.starts_with(b"--") {
            rest = &[];
        }
    }
    // The trailing chunk after the final boundary is epilogue noise.
    let _ = rest;
    for section in sections.into_iter().skip(1).take(MAX_PARTS) {
        // Each section starts where the previous delimiter ended: strip
        // the leading CRLF, then split headers from body at CRLFCRLF.
        let section = match section.strip_prefix(b"\r\n") {
            Some(s) => s,
            None => continue,
        };
        let Some(sep) = find(section, b"\r\n\r\n") else { continue };
        let (header_block, body) = section.split_at(sep);
        let body = &body[4..];
        // Trim the trailing CRLF that belongs to the next delimiter.
        let body = body.strip_suffix(b"\r\n").unwrap_or(body);
        let headers = String::from_utf8_lossy(header_block);
        let mut name = None;
        let mut filename = None;
        for line in headers.lines() {
            let Some((k, v)) = line.split_once(':') else { continue };
            if !k.eq_ignore_ascii_case("content-disposition") {
                continue;
            }
            for attr in v.split(';') {
                let attr = attr.trim();
                if let Some(n) = attr.strip_prefix("name=") {
                    name = Some(unquote(n));
                } else if let Some(f) = attr.strip_prefix("filename=") {
                    filename = Some(unquote(f));
                }
            }
        }
        if let Some(name) = name {
            parts.push(Part {
                name,
                filename,
                bytes: body.to_vec(),
            });
        }
    }
    parts
}

/// Build a multipart body from `(name, Option<filename>, bytes)` parts.
/// Returns the body bytes; the boundary is the returned token — set the
/// request Content-Type as `multipart/form-data; boundary=<token>`.
/// `seed` (a clock tick from the caller) keeps the boundary from being a
/// compile-time constant an uploaded file could embed on purpose.
pub fn build_seeded(seed: u64, parts: &[(String, Option<String>, Vec<u8>)]) -> (String, Vec<u8>) {
    let boundary = format!(
        "wowspfb{:016x}",
        seed ^ (parts.len() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
    );
    let mut out = Vec::new();
    for (name, filename, bytes) in parts {
        out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match filename {
            Some(f) => out.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{f}\"\r\n"
                )
                .as_bytes(),
            ),
            None => out.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"\r\n").as_bytes(),
            ),
        }
        out.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
        out.extend_from_slice(bytes);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (boundary, out)
}

/// [`build_seeded`] with a fixed seed — host tests only; the worker
/// always passes a clock tick.
pub fn build(parts: &[(String, Option<String>, Vec<u8>)]) -> (String, Vec<u8>) {
    build_seeded(0, parts)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let v = v.strip_prefix('"').unwrap_or(v);
    let v = v.strip_suffix('"').unwrap_or(v);
    v.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_body() -> (String, Vec<u8>) {
        // Mirrors exactly what `build` emits (and what a browser sends).
        build(&[
            ("description".into(), None, "Tab 面板不显示".as_bytes().to_vec()),
            ("version".into(), None, b"0.4.11".to_vec()),
            (
                "file".into(),
                Some("wowsp.zip".into()),
                b"PK\x03\x04-binary-\xe4\xb8\xad".to_vec(),
            ),
        ])
    }

    #[test]
    fn boundary_extraction() {
        assert_eq!(
            boundary_from_content_type("multipart/form-data; boundary=abc123"),
            Some("abc123".into())
        );
        assert_eq!(
            boundary_from_content_type("multipart/form-data; boundary=\"quoted-x\""),
            Some("quoted-x".into())
        );
        assert_eq!(boundary_from_content_type("application/json"), None);
        assert_eq!(boundary_from_content_type(""), None);
        // Suffix false-positives are refused.
        assert_eq!(
            boundary_from_content_type("multipart/form-data; xboundary=nope"),
            None
        );
    }

    #[test]
    fn round_trips_text_and_binary_parts() {
        let (boundary, body) = build(&[
            ("a".into(), None, b"value-a".to_vec()),
            (
                "f".into(),
                Some("x.zip".into()),
                vec![0u8, 1, 2, 255, 0x0d, 0x0a, 0x0d, 0x0a],
            ),
        ]);
        let parts = parse(&boundary, &body);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].name, "a");
        assert_eq!(parts[0].filename, None);
        assert_eq!(parts[0].bytes, b"value-a".to_vec());
        assert_eq!(parts[1].name, "f");
        assert_eq!(parts[1].filename.as_deref(), Some("x.zip"));
        // Body containing CRLFCRLF and a bare 0xff survives verbatim.
        assert_eq!(parts[1].bytes, vec![0u8, 1, 2, 255, 0x0d, 0x0a, 0x0d, 0x0a]);
    }

    #[test]
    fn parses_a_browser_shaped_body() {
        let (boundary, body) = sample_body();
        let parts = parse(&boundary, &body);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].name, "description");
        assert_eq!(String::from_utf8_lossy(&parts[0].bytes), "Tab 面板不显示");
        assert_eq!(parts[1].name, "version");
        assert_eq!(parts[2].name, "file");
        assert_eq!(parts[2].filename.as_deref(), Some("wowsp.zip"));
        assert_eq!(&parts[2].bytes[..2], b"PK");
    }

    #[test]
    fn junk_body_yields_no_parts() {
        assert!(parse("b", b"not multipart at all").is_empty());
        assert!(parse("b", b"--b\r\n\r\nno-name\r\n--b--\r\n").is_empty());
    }
}
