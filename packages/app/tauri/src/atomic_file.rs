//! Replace a data file without sharing another writer's temporary file.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

// Windows may reject simultaneous replacements of the same destination even
// when their temporary files are distinct. Serialize only the publish step;
// writing independent temporary payloads can still proceed concurrently.
static REPLACE_GATE: Mutex<()> = Mutex::new(());

pub(crate) fn write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("data file has no parent")?;
    fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|e| format!("create temporary file name: {e}"))?;
    let tmp = parent.join(format!(".wowsp-{}.tmp", hex::encode(nonce)));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("create {tmp:?}: {e}"))?;
    let result = file.write_all(content.as_bytes());
    drop(file);
    let result = result
        .map_err(|e| format!("write {tmp:?}: {e}"))
        .and_then(|()| {
            let _gate = REPLACE_GATE.lock().unwrap_or_else(|e| e.into_inner());
            fs::rename(&tmp, path).map_err(|e| format!("replace {path:?}: {e}"))
        });
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
