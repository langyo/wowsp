//! The contribution package format (contract §8): a GNU/ustar tar with
//! NO directory members, zstd-compressed at level ~3, whose member names
//! are `<sha256>.<original extension>`. The manifest rides the
//! `x-manifest` header instead (contract §4), and every member is
//! re-hashed while it streams into the package — a replay file that
//! changed under the planner aborts the pass instead of uploading bytes
//! that no longer match their claimed hash.

use anyhow::{Result, anyhow, bail};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use wowsp_tauri_shared::ReplayFactsCore;

/// zstd level the packer uses (the contract's "~3").
const ZSTD_LEVEL: i32 = 3;

/// One package member: everything the tar entry, the re-hash gate and the
/// manifest row need. `bytes_from` is the local file the bytes stream
/// from — either the user's original replay or an archive-extracted temp
/// copy of a previously staged one.
#[derive(Clone)]
pub(super) struct PackMember {
    pub sha256: String,
    /// The member's ORIGINAL file name (manifest row); the tar entry name
    /// is derived as `<sha256>.<ext>`.
    pub file_name: String,
    pub size_bytes: u64,
    pub facts: ReplayFactsCore,
    pub rule_id: Option<String>,
    pub bytes_from: PathBuf,
}

/// The upload manifest (contract §4): base64url-encoded into the
/// `x-manifest` header, never inside the package.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadManifest {
    pub manifest_version: u32,
    pub consent_version: u32,
    pub credited_name: String,
    pub realm: String,
    pub app_version: String,
    pub members: Vec<ManifestMember>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ManifestMember {
    pub sha256: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub facts: ReplayFactsCore,
    /// Serialized as null when unknown (a re-sent own_staged member whose
    /// rule the server already recorded) — present-but-null parses under
    /// both a required-key shape check and an optional field.
    pub rule_id: Option<String>,
}

impl From<&PackMember> for ManifestMember {
    fn from(m: &PackMember) -> Self {
        Self {
            sha256: m.sha256.clone(),
            file_name: m.file_name.clone(),
            size_bytes: m.size_bytes,
            facts: m.facts.clone(),
            rule_id: m.rule_id.clone(),
        }
    }
}

/// Build the manifest document for a member set (stable sha order so two
/// runs over the same set byte-match).
pub(super) fn build_manifest(
    members: &[PackMember],
    consent_version: u32,
    identity: &wowsp_tauri_shared::ContributionIdentity,
    app_version: &str,
) -> String {
    let mut members: Vec<ManifestMember> = members.iter().map(Into::into).collect();
    members.sort_by(|a, b| a.sha256.cmp(&b.sha256));
    let manifest = UploadManifest {
        manifest_version: 1,
        consent_version,
        credited_name: identity.name.clone(),
        realm: identity.realm.clone(),
        app_version: app_version.to_string(),
        members,
    };
    serde_json::to_string(&manifest).expect("serialize upload manifest")
}

/// The tar member name for a hash: `<sha256>.<ext>` where the extension
/// keeps the ORIGINAL container family (`wowsreplay` WG, `korablireplay`
/// Lesta; anything else degrades to the WG spelling — the drain side
/// re-hashes regardless of extension).
pub(super) fn member_name(sha256: &str, file_name: &str) -> String {
    format!("{sha256}.{}", member_ext(file_name))
}

fn member_ext(file_name: &str) -> &'static str {
    match Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("korablireplay") => "korablireplay",
        _ => "wowsreplay",
    }
}

/// A file reader that hashes (and counts) everything it yields, so the
/// tar append doubles as the re-hash gate the contract's drain side
/// relies on. The digest lives behind an `Arc<Mutex>` because the tar
/// builder consumes the reader by value — the caller keeps the other
/// handle and reads the result out after the append.
type HashState = std::sync::Mutex<(Sha256, u64)>;

struct HashingReader {
    inner: BufReader<File>,
    state: std::sync::Arc<HashState>,
}

impl HashingReader {
    fn open(path: &Path) -> std::io::Result<(Self, std::sync::Arc<HashState>)> {
        let state = std::sync::Arc::new(HashState::new((Sha256::new(), 0)));
        Ok((
            Self {
                inner: BufReader::with_capacity(256 * 1024, File::open(path)?),
                state: std::sync::Arc::clone(&state),
            },
            state,
        ))
    }
}

impl Read for HashingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            if let Ok(mut state) = self.state.lock() {
                state.0.update(&buf[..n]);
                state.1 += n as u64;
            }
        }
        Ok(n)
    }
}

/// The hex digest + byte count of a fully consumed [`HashingReader`].
fn finish_hashing(state: &std::sync::Arc<HashState>) -> (String, u64) {
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let bytes = guard.1;
    let hasher = std::mem::replace(&mut guard.0, Sha256::new());
    (hex::encode(hasher.finalize()), bytes)
}

/// Build the tar.zstd package at `dest` from `members` (stable sha order).
/// `on_member` fires after each member with its byte count, so the caller
/// can tick per-item progress (and abort the build by returning Err — the
/// cancellation checkpoint between members); a hash mismatch against the
/// member's claimed sha256 aborts the whole build (the package would
/// otherwise ship bytes that contradict their own name).
pub(super) fn build_package_blocking(
    dest: &Path,
    members: &[PackMember],
    mut on_member: impl FnMut(&PackMember, u64) -> Result<()>,
) -> Result<()> {
    let mut sorted: Vec<&PackMember> = members.iter().collect();
    sorted.sort_by(|a, b| a.sha256.cmp(&b.sha256));
    let file = File::create(dest).map_err(|e| anyhow!("create {}: {e}", dest.display()))?;
    let zstd = zstd::stream::write::Encoder::new(file, ZSTD_LEVEL)
        .map_err(|e| anyhow!("zstd encoder: {e}"))?;
    let mut tar = tar::Builder::new(zstd);
    for member in sorted {
        let name = member_name(&member.sha256, &member.file_name);
        check_member_name(&name)?;
        let mut header = tar::Header::new_gnu();
        header.set_size(member.size_bytes);
        header.set_mode(0o644);
        header.set_mtime(0);
        header.set_entry_type(tar::EntryType::Regular);
        header
            .set_path(&name)
            .map_err(|e| anyhow!("member name {name}: {e}"))?;
        header.set_cksum();
        let (reader, state) = HashingReader::open(&member.bytes_from)
            .map_err(|e| anyhow!("open {}: {e}", member.bytes_from.display()))?;
        tar.append(&header, reader)
            .map_err(|e| anyhow!("pack {}: {e}", member.file_name))?;
        let (got, bytes) = finish_hashing(&state);
        if got != member.sha256 {
            bail!(
                "{} changed while packing (hash {} != {})",
                member.file_name,
                got,
                member.sha256
            );
        }
        on_member(member, bytes)?;
    }
    let zstd = tar.into_inner().map_err(|e| anyhow!("finalize tar: {e}"))?;
    zstd.finish().map_err(|e| anyhow!("finalize zstd: {e}"))?;
    Ok(())
}

/// A tar member name must be exactly `<64 lowercase hex>.<ext>` — the
/// extract path validates the same shape, so a malicious archive can
/// never smuggle a traversal path or a foreign name in.
fn check_member_name(name: &str) -> Result<()> {
    let is_sha = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    };
    match name.split_once('.') {
        Some((sha, ext)) if is_sha(sha) && matches!(ext, "wowsreplay" | "korablireplay") => Ok(()),
        _ => bail!("invalid package member name: {name:?}"),
    }
}

/// Extract the `wanted` members out of a downloaded contributor archive
/// (zstd tar) into `out_dir`, verifying each extracted member's hash
/// against its own name. Returns sha256 → extracted path. Members not in
/// `wanted` are streamed past, never written. The tar is read with
/// directory entries rejected (the format has none) and every name
/// re-validated, so extraction can never write outside `out_dir`.
pub(super) fn extract_members_blocking(
    archive: &Path,
    wanted: &HashSet<String>,
    out_dir: &Path,
) -> Result<HashMap<String, PathBuf>> {
    let file = File::open(archive).map_err(|e| anyhow!("open {}: {e}", archive.display()))?;
    let decoder =
        zstd::stream::read::Decoder::new(file).map_err(|e| anyhow!("zstd decoder: {e}"))?;
    let mut tar = tar::Archive::new(decoder);
    std::fs::create_dir_all(out_dir).map_err(|e| anyhow!("create {}: {e}", out_dir.display()))?;
    let mut out = HashMap::new();
    for entry in tar
        .entries()
        .map_err(|e| anyhow!("read archive entries: {e}"))?
    {
        let mut entry = entry.map_err(|e| anyhow!("read archive entry: {e}"))?;
        if !entry.header().entry_type().is_file() {
            bail!("contribution archive carries a non-file member");
        }
        let name = entry
            .path()
            .map_err(|e| anyhow!("read member name: {e}"))?
            .to_string_lossy()
            .into_owned();
        check_member_name(&name)?;
        let (sha, ext) = name.split_once('.').expect("validated shape");
        if !wanted.contains(sha) {
            continue;
        }
        // The member name IS its claimed hash: verify while streaming.
        let mut hasher = Sha256::new();
        let staged = tempfile_path(out_dir, sha, ext);
        let mut sink =
            File::create(&staged).map_err(|e| anyhow!("create {}: {e}", staged.display()))?;
        let mut buf = [0u8; 256 * 1024];
        loop {
            let n = entry
                .read(&mut buf)
                .map_err(|e| anyhow!("extract {name}: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            sink.write_all(&buf[..n])
                .map_err(|e| anyhow!("extract {name}: {e}"))?;
        }
        let got = hex::encode(hasher.finalize());
        if got != sha {
            let _ = std::fs::remove_file(&staged);
            bail!("archive member {name} fails its own hash ({got})");
        }
        out.insert(sha.to_string(), staged);
    }
    Ok(out)
}

/// Where an extracted member lands: directly under `out_dir`, named by
/// its (already validated) `<sha>.<ext>` — never a nested path.
fn tempfile_path(out_dir: &Path, sha: &str, ext: &str) -> PathBuf {
    out_dir.join(format!("{sha}.{ext}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-contrib-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn member(path: &Path, payload: &[u8], facts: ReplayFactsCore) -> PackMember {
        std::fs::write(path, payload).unwrap();
        PackMember {
            sha256: sha(payload),
            file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
            size_bytes: payload.len() as u64,
            facts,
            rule_id: Some("rule-a".into()),
            bytes_from: path.to_path_buf(),
        }
    }

    /// The full round trip: build the package from local files, read it
    /// back through the same zstd+tar stack the archive extraction uses,
    /// and verify names, order, bytes and the manifest's embedded shape.
    #[test]
    fn package_roundtrips_members_with_verified_hashes() {
        let dir = temp_dir("roundtrip");
        let a = dir.join("20261014_090000_a.wowsreplay");
        let b = dir.join("20261014_091500_b.korablireplay");
        let payload_a = vec![0x12u8, 0x32, 0x34, 0x11]
            .into_iter()
            .chain(std::iter::repeat(0x5a).take(8192))
            .collect::<Vec<_>>();
        let payload_b = b"korabli payload".repeat(100);
        let facts = ReplayFactsCore::default();
        let members = [
            member(&a, &payload_a, facts.clone()),
            member(&b, &payload_b, facts),
        ];
        let dest = dir.join("package.tar.zstd");
        let mut progressed = Vec::new();
        build_package_blocking(&dest, &members, |m, bytes| {
            progressed.push((m.sha256.clone(), bytes));
            Ok(())
        })
        .unwrap();
        assert_eq!(progressed.len(), 2);

        // Read back: zstd-decode + tar-walk, exactly like extraction.
        let file = File::open(&dest).unwrap();
        let mut tar = tar::Archive::new(zstd::stream::read::Decoder::new(file).unwrap());
        let mut names = Vec::new();
        for entry in tar.entries().unwrap() {
            let mut entry = entry.unwrap();
            assert!(entry.header().entry_type().is_file());
            let name = entry.path().unwrap().to_string_lossy().into_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            names.push(name.clone());
            let (sha_str, _) = name.split_once('.').unwrap();
            assert_eq!(hex::encode(Sha256::digest(&bytes)), sha_str, "{name}");
            if name.ends_with(".wowsreplay") {
                assert_eq!(bytes, payload_a);
            } else {
                assert_eq!(bytes, payload_b);
            }
        }
        // Stable sha order + the original extension rides the name.
        let mut expected: Vec<String> = members
            .iter()
            .map(|m| member_name(&m.sha256, &m.file_name))
            .collect();
        expected.sort();
        assert_eq!(names, expected);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn packing_aborts_when_a_file_changes_under_the_planner() {
        let dir = temp_dir("mismatch");
        let path = dir.join("20261014_090000_x.wowsreplay");
        let members = [member(&path, b"original bytes", ReplayFactsCore::default())];
        // Mutate AFTER the member's sha was captured: the re-hash gate
        // must abort the build instead of shipping mismatched bytes.
        std::fs::write(&path, b"mutated bytes!!").unwrap();
        let dest = dir.join("package.tar.zstd");
        let err = build_package_blocking(&dest, &members, |_, _| Ok(())).unwrap_err();
        assert!(err.to_string().contains("changed while packing"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn extraction_verifies_member_hashes_and_skips_unwanted() {
        let dir = temp_dir("extract");
        let payload_a = b"member a".repeat(64);
        let payload_b = b"member b".repeat(64);
        let a = dir.join("a.wowsreplay");
        let b = dir.join("b.wowsreplay");
        let members = [
            member(&a, &payload_a, ReplayFactsCore::default()),
            member(&b, &payload_b, ReplayFactsCore::default()),
        ];
        let archive = dir.join("archive.tar.zstd");
        build_package_blocking(&archive, &members, |_, _| Ok(())).unwrap();

        // Only want `a`; `b` must be streamed past without landing.
        let wanted: HashSet<String> = [members[0].sha256.clone()].into();
        let out_dir = dir.join("extracted");
        let extracted = extract_members_blocking(&archive, &wanted, &out_dir).unwrap();
        assert_eq!(extracted.len(), 1);
        let path = extracted.get(&members[0].sha256).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), payload_a);
        assert_eq!(std::fs::read_dir(&out_dir).unwrap().count(), 1);

        // A tampered archive (member bytes not matching their claimed
        // hash) fails its own hash. The packer's re-hash gate refuses to
        // BUILD such a package, so hand-craft it with the raw tar+zstd
        // stack: a's claimed name over b's payload.
        let swapped = dir.join("swapped.tar.zstd");
        {
            let file = File::create(&swapped).unwrap();
            let encoder = zstd::stream::write::Encoder::new(file, ZSTD_LEVEL).unwrap();
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_size(payload_b.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            header
                .set_path(format!("{}.wowsreplay", members[0].sha256))
                .unwrap();
            header.set_cksum();
            builder
                .append(&mut header, std::io::Cursor::new(&payload_b))
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let out2 = dir.join("extracted2");
        let err = extract_members_blocking(&swapped, &wanted, &out2).unwrap_err();
        assert!(err.to_string().contains("fails its own hash"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn manifest_shape_matches_the_contract() {
        let dir = temp_dir("manifest");
        let path = dir.join("20261014_090000_m.wowsreplay");
        let facts = ReplayFactsCore {
            map: "15_NE_north".into(),
            mode: "standard".into(),
            realm: "asia".into(),
            tier: Some(10),
            player_count: 12,
            ..ReplayFactsCore::default()
        };
        let members = [member(&path, b"payload", facts)];
        let identity = wowsp_tauri_shared::ContributionIdentity {
            realm: "asia".into(),
            name: "Player".into(),
        };
        let raw = build_manifest(&members, 1, &identity, "0.6.1");
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["manifestVersion"], 1);
        assert_eq!(doc["consentVersion"], 1);
        assert_eq!(doc["creditedName"], "Player");
        assert_eq!(doc["realm"], "asia");
        assert_eq!(doc["appVersion"], "0.6.1");
        let m = &doc["members"][0];
        assert_eq!(m["fileName"], "20261014_090000_m.wowsreplay");
        assert_eq!(m["sizeBytes"], 7);
        assert_eq!(m["ruleId"], "rule-a");
        // The embedded facts carry NO identity/size fields (contract §4).
        for banned in ["sha256", "fileName", "sizeBytes"] {
            assert!(
                m["facts"].get(banned).is_none(),
                "facts must not carry {banned}"
            );
        }
        assert_eq!(m["facts"]["map"], "15_NE_north");
        assert_eq!(m["facts"]["realm"], "asia");
        assert_eq!(m["facts"]["tier"], 10);
        assert_eq!(m["facts"]["playerCount"], 12);
        // An unknown ruleId serializes as null (present-but-null parses
        // under both a required-key shape check and an optional field).
        let members2 = [PackMember {
            rule_id: None,
            ..members[0].clone()
        }];
        let raw2 = build_manifest(&members2, 1, &identity, "0.6.1");
        let doc2: serde_json::Value = serde_json::from_str(&raw2).unwrap();
        assert!(doc2["members"][0]["ruleId"].is_null());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn member_names_keep_the_container_family_extension() {
        assert!(member_name(&"a".repeat(64), "x.wowsreplay").ends_with(".wowsreplay"));
        assert!(member_name(&"a".repeat(64), "x.KORABLIREPLAY").ends_with(".korablireplay"));
        assert!(member_name(&"a".repeat(64), "weird").ends_with(".wowsreplay"));
        assert!(check_member_name(&member_name(&"a".repeat(64), "x.wowsreplay")).is_ok());
        assert!(check_member_name("../escape.wowsreplay").is_err());
        assert!(check_member_name(&format!("{}.wowsreplay", "A".repeat(64))).is_err());
        assert!(check_member_name(&format!("{}.exe", "a".repeat(64))).is_err());
    }
}
