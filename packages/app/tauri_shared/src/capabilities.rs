//! Runtime capability flags for the webui. `ai_inference` is a compile-time
//! fact (the `ai` cargo feature), so the frontend must probe it rather than
//! infer the feature set from `is_portable`: a custom build can drop AI while
//! still being a normal installer build.
use serde::{Deserialize, Serialize};

/// Capabilities the main webui probes once at startup. The settings'
/// resources page also renders the DirectML runtime row from these fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    /// Whether this binary links ONNX Runtime and serves the decision-AI
    /// inference commands (the default-on `ai` feature).
    pub ai_inference: bool,
    /// Whether this process runs in the single-exe portable flavor.
    pub portable: bool,
    /// Whether this platform's AI build ships `DirectML.dll` beside the
    /// executable (Windows AI builds do; portable/non-AI builds do not).
    pub directml_required: bool,
    /// Whether a plausible `DirectML.dll` (PE image, at least 1 MB) sits
    /// next to the running executable. Probed on Windows regardless of the
    /// `ai` feature; only meaningful when `directml_required` is set.
    pub directml_present: bool,
    /// Size of the runtime DLL when present.
    pub directml_bytes: Option<u64>,
}
