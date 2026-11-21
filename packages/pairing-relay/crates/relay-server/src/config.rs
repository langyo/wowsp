//! Server configuration (contract §7): `WOWSP_SERVER_*` environment
//! variables win over an optional `wowsp-server.toml` in the working
//! directory, which wins over the safe defaults. Every knob is documented
//! in the crate README; secrets (password, Turnstile secret) belong in
//! the environment of the service, never in a tracked file.

use std::collections::HashMap;
use std::path::PathBuf;

/// Environment prefix shared by every knob.
const PREFIX: &str = "WOWSP_SERVER_";
/// Optional config file consulted between defaults and the environment.
pub const CONFIG_FILE: &str = "wowsp-server.toml";

/// Fully-resolved runtime configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// Listen address (`host:port`).
    pub bind: String,
    /// SQLite + node-id storage directory (created on startup).
    pub data_dir: PathBuf,
    /// This deployment's public base URL (https://host[:port], no trailing
    /// slash) — used for the self row + auto-announce when set.
    pub public_url: Option<String>,
    /// `official` | `community` (informational, contract §2).
    pub role: String,
    /// Free-form operator notice riding both health documents.
    pub notice: Option<String>,
    /// Optional gateway password (absent ⇒ off).
    pub gateway_password: Option<String>,
    /// Optional Turnstile sitekey + secret (absent sitekey ⇒ off).
    pub turnstile_sitekey: Option<String>,
    pub turnstile_secret: Option<String>,
    /// Where the server list is subscribed from (§5.1).
    pub peers_upstream: String,
    /// Pull-through block sync on local miss (§5.4).
    pub sync: bool,
    /// Peers asked per sync round.
    pub sync_peers_max: usize,
    /// Whether /api/peers/announce accepts (§5.2).
    pub peers_accept_announces: bool,
    /// /api/lookup/* per-IP hourly budget (§3.5).
    pub lookup_rate_per_hour: u32,
    /// Node-id file name inside the data dir.
    pub node_id_file: String,
    /// host → base-URL remap for OUTBOUND fetches (lookup upstream + the
    /// announce liveness callback). TEST/AIR-GAPPED OPS ONLY: lets the
    /// integration tests stand a mock in for an allowlisted host and a
    /// LAN deployment pin a name to a local address. Never announced.
    pub upstream_override: HashMap<String, String>,
    /// Trust X-Real-IP / X-Forwarded-For for the per-IP budgets and the
    /// gateway password lockout. Default FALSE (the socket address is
    /// the client): the headers are client-spoofable whenever the
    /// server is directly exposed, and a forged XFF resets every
    /// budget. Enable ONLY behind a reverse proxy that OVERWRITES the
    /// headers (README).
    pub trust_proxy: bool,
    /// Gateway WebSocket keepalive cadence (both pub and sub roles).
    /// Defaults to relay-core's 30 s; overridable only so the
    /// integration tests can observe a ping quickly.
    pub keepalive_interval_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8787".into(),
            data_dir: PathBuf::from("./wowsp-server-data"),
            public_url: None,
            role: "community".into(),
            notice: None,
            gateway_password: None,
            turnstile_sitekey: None,
            turnstile_secret: None,
            peers_upstream: "https://wowsp.langyo.xyz".into(),
            sync: true,
            sync_peers_max: 3,
            peers_accept_announces: true,
            lookup_rate_per_hour: 240,
            node_id_file: "node-id.txt".into(),
            upstream_override: HashMap::new(),
            trust_proxy: false,
            keepalive_interval_ms: relay_core::gateway::KEEPALIVE_INTERVAL_MS,
        }
    }
}

impl Config {
    /// defaults ← `wowsp-server.toml` ← environment. The file is optional
    /// (a deployment may be pure-env); unparseable env values are ignored
    /// in favor of the lower layer rather than refusing to boot.
    pub fn load() -> Self {
        let mut cfg = Self::default();
        if let Ok(text) = std::fs::read_to_string(CONFIG_FILE) {
            cfg.apply_toml(&text);
        }
        cfg.apply_env();
        cfg
    }

    /// Apply a TOML document (the file layer). Unknown keys are ignored —
    /// forward compatibility for config files from newer servers.
    fn apply_toml(&mut self, text: &str) {
        let Ok(v) = toml::from_str::<toml::Value>(text) else {
            return;
        };
        let s = |v: &toml::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        if let Some(x) = s(&v, "bind") {
            self.bind = x;
        }
        if let Some(x) = s(&v, "data_dir") {
            self.data_dir = PathBuf::from(x);
        }
        if let Some(x) = s(&v, "public_url") {
            self.public_url = Some(x);
        }
        if let Some(x) = s(&v, "role") {
            self.role = x;
        }
        if let Some(x) = s(&v, "notice") {
            self.notice = Some(x);
        }
        if let Some(x) = s(&v, "gateway_password") {
            self.gateway_password = Some(x);
        }
        if let Some(x) = s(&v, "turnstile_sitekey") {
            self.turnstile_sitekey = Some(x);
        }
        if let Some(x) = s(&v, "turnstile_secret") {
            self.turnstile_secret = Some(x);
        }
        if let Some(x) = s(&v, "peers_upstream") {
            self.peers_upstream = x;
        }
        if let Some(x) = v.get("sync").and_then(|x| x.as_bool()) {
            self.sync = x;
        }
        if let Some(x) = v.get("sync_peers_max").and_then(|x| x.as_integer()) {
            self.sync_peers_max = x.max(0) as usize;
        }
        if let Some(x) = v.get("peers_accept_announces").and_then(|x| x.as_bool()) {
            self.peers_accept_announces = x;
        }
        if let Some(x) = v.get("trust_proxy").and_then(|x| x.as_bool()) {
            self.trust_proxy = x;
        }
        if let Some(x) = v.get("lookup_rate_per_hour").and_then(|x| x.as_integer()) {
            self.lookup_rate_per_hour = x.max(1) as u32;
        }
        if let Some(x) = s(&v, "node_id_file") {
            self.node_id_file = x;
        }
        if let Some(map) = v.get("upstream_override").and_then(|x| x.as_table()) {
            for (k, val) in map {
                if let Some(base) = val.as_str() {
                    self.upstream_override.insert(k.clone(), base.to_string());
                }
            }
        }
    }

    /// Apply the environment layer (highest precedence). Optional
    /// string knobs normalize blank/whitespace values to unset.
    fn apply_env(&mut self) {
        let e = |k: &str| {
            std::env::var(format!("{PREFIX}{k}"))
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        if let Some(x) = e("BIND") {
            self.bind = x;
        }
        if let Some(x) = e("DATA_DIR") {
            self.data_dir = PathBuf::from(x);
        }
        if let Some(x) = e("PUBLIC_URL") {
            self.public_url = Some(x);
        }
        if let Some(x) = e("ROLE") {
            self.role = x;
        }
        if let Some(x) = e("NOTICE") {
            self.notice = Some(x);
        }
        if let Some(x) = e("GATEWAY_PASSWORD") {
            self.gateway_password = Some(x);
        }
        if let Some(x) = e("TURNSTILE_SITEKEY") {
            self.turnstile_sitekey = Some(x);
        }
        if let Some(x) = e("TURNSTILE_SECRET") {
            self.turnstile_secret = Some(x);
        }
        if let Some(x) = e("PEERS_UPSTREAM") {
            self.peers_upstream = x;
        }
        if let Some(x) = e("SYNC").and_then(|v| parse_bool(&v)) {
            self.sync = x;
        }
        if let Some(x) = e("SYNC_PEERS_MAX").and_then(|v| v.parse::<usize>().ok()) {
            self.sync_peers_max = x;
        }
        if let Some(x) = e("PEERS_ACCEPT_ANNOUNCES").and_then(|v| parse_bool(&v)) {
            self.peers_accept_announces = x;
        }
        if let Some(x) = e("TRUST_PROXY").and_then(|v| parse_bool(&v)) {
            self.trust_proxy = x;
        }
        if let Some(x) = e("KEEPALIVE_MS").and_then(|v| v.parse::<u64>().ok()) {
            self.keepalive_interval_ms = x.max(1_000);
        }
        if let Some(x) = e("LOOKUP_RATE_PER_HOUR").and_then(|v| v.parse::<u32>().ok()) {
            self.lookup_rate_per_hour = x.max(1);
        }
        if let Some(x) = e("NODE_ID_FILE") {
            self.node_id_file = x;
        }
        // WOWSP_SERVER_UPSTREAM_OVERRIDE="host1=url1,host2=url2"
        if let Some(x) = e("UPSTREAM_OVERRIDE") {
            for pair in x.split(',') {
                if let Some((k, v)) = pair.split_once('=') {
                    self.upstream_override
                        .insert(k.trim().to_string(), v.trim().to_string());
                }
            }
        }
    }

    /// Rewrite an outbound URL through the override map: when the URL's
    /// host is remapped, scheme://host[:port] is replaced by the mapped
    /// base and the original path + query are kept. Unmapped URLs pass
    /// through untouched. TEST/AIR-GAPPED OPS ONLY (see README).
    pub fn resolve_outbound(&self, url: &str) -> String {
        let Ok(parsed) = reqwest::Url::parse(url) else {
            return url.to_string();
        };
        let Some(host) = parsed.host_str() else {
            return url.to_string();
        };
        let Some(base) = self.upstream_override.get(host) else {
            return url.to_string();
        };
        let Ok(base) = reqwest::Url::parse(base) else {
            return url.to_string();
        };
        let mut out = base;
        out.set_path(parsed.path());
        out.set_query(parsed.query());
        out.to_string()
    }
}

/// Lenient bool parsing for env values.
fn parse_bool(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Env mutation is process-global (and unsafe since the 2024
    /// edition): every env-touching test takes this lock and restores
    /// the keys it touched, so parallel test threads never race it.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_env(pairs: &[(&str, &str)], f: impl FnOnce(&mut Config)) {
        let _guard = ENV_LOCK.lock().unwrap();
        for (k, v) in pairs {
            // SAFETY: no other thread touches the environment while the
            // lock is held (the only unsynchronized reader would be
            // Config::load, which no test calls).
            unsafe { std::env::set_var(format!("{PREFIX}{k}"), v) };
        }
        let mut cfg = Config::default();
        f(&mut cfg);
        for (k, _) in pairs {
            // SAFETY: see above.
            unsafe { std::env::remove_var(format!("{PREFIX}{k}")) };
        }
    }

    #[test]
    fn defaults_are_the_safe_contract_values() {
        let c = Config::default();
        assert_eq!(c.bind, "127.0.0.1:8787");
        assert_eq!(c.data_dir, PathBuf::from("./wowsp-server-data"));
        assert_eq!(c.public_url, None);
        assert_eq!(c.role, "community");
        assert_eq!(c.peers_upstream, "https://wowsp.langyo.xyz");
        assert!(c.sync);
        assert_eq!(c.sync_peers_max, 3);
        assert!(c.peers_accept_announces);
        assert_eq!(c.lookup_rate_per_hour, 240);
        assert_eq!(c.node_id_file, "node-id.txt");
        assert!(!c.trust_proxy, "proxy headers are untrusted by default");
        assert_eq!(
            c.keepalive_interval_ms,
            relay_core::gateway::KEEPALIVE_INTERVAL_MS
        );
    }

    #[test]
    fn toml_layer_overrides_defaults() {
        let mut c = Config::default();
        c.apply_toml(
            r#"
bind = "0.0.0.0:9000"
public_url = "https://wowsp.example.org"
role = "official"
notice = "hello"
sync = false
sync_peers_max = 5
lookup_rate_per_hour = 60

[upstream_override]
"vortex.wowsgame.cn" = "http://192.0.2.10:8788"
"#,
        );
        assert_eq!(c.bind, "0.0.0.0:9000");
        assert_eq!(c.public_url.as_deref(), Some("https://wowsp.example.org"));
        assert_eq!(c.role, "official");
        assert_eq!(c.notice.as_deref(), Some("hello"));
        assert!(!c.sync);
        assert_eq!(c.sync_peers_max, 5);
        assert_eq!(c.lookup_rate_per_hour, 60);
        assert_eq!(
            c.upstream_override
                .get("vortex.wowsgame.cn")
                .map(String::as_str),
            Some("http://192.0.2.10:8788")
        );
        // Untouched keys keep defaults.
        assert_eq!(c.peers_upstream, "https://wowsp.langyo.xyz");
        assert!(c.peers_accept_announces);
    }

    #[test]
    fn env_layer_wins_over_toml() {
        with_env(&[("BIND", "127.0.0.1:9999"), ("SYNC", "0")], |c| {
            c.apply_toml("bind = \"0.0.0.0:9000\"\nsync = true\n");
            c.apply_env();
            assert_eq!(c.bind, "127.0.0.1:9999");
            assert!(!c.sync);
        });
    }

    #[test]
    fn env_layer_parses_the_full_knob_set() {
        with_env(
            &[
                ("DATA_DIR", "./d"),
                ("PUBLIC_URL", "https://node.example.org"),
                ("ROLE", "official"),
                ("NOTICE", "hi"),
                ("GATEWAY_PASSWORD", "test-password"),
                ("TURNSTILE_SITEKEY", "sk-test"),
                ("TURNSTILE_SECRET", "secret-test"),
                ("PEERS_UPSTREAM", "https://peer.example.org"),
                ("SYNC_PEERS_MAX", "7"),
                ("PEERS_ACCEPT_ANNOUNCES", "off"),
                ("LOOKUP_RATE_PER_HOUR", "120"),
                ("NODE_ID_FILE", "nid.txt"),
                (
                    "UPSTREAM_OVERRIDE",
                    "vortex.wowsgame.cn=http://127.0.0.1:9111, clans.wowsgame.cn=http://127.0.0.1:9112",
                ),
            ],
            |c| {
                c.apply_env();
                assert_eq!(c.data_dir, PathBuf::from("./d"));
                assert_eq!(c.public_url.as_deref(), Some("https://node.example.org"));
                assert_eq!(c.role, "official");
                assert_eq!(c.notice.as_deref(), Some("hi"));
                assert_eq!(c.gateway_password.as_deref(), Some("test-password"));
                assert_eq!(c.turnstile_sitekey.as_deref(), Some("sk-test"));
                assert_eq!(c.turnstile_secret.as_deref(), Some("secret-test"));
                assert_eq!(c.peers_upstream, "https://peer.example.org");
                assert!(c.sync, "SYNC unset keeps the toml/default value");
                assert_eq!(c.sync_peers_max, 7);
                assert!(!c.peers_accept_announces);
                assert_eq!(c.lookup_rate_per_hour, 120);
                assert_eq!(c.node_id_file, "nid.txt");
                assert_eq!(c.upstream_override.len(), 2);
                assert_eq!(
                    c.upstream_override
                        .get("clans.wowsgame.cn")
                        .map(String::as_str),
                    Some("http://127.0.0.1:9112")
                );
            },
        );
    }

    #[test]
    fn env_blank_values_mean_unset() {
        with_env(&[("NOTICE", "  ")], |c| {
            c.apply_env();
            assert_eq!(c.notice, None, "whitespace-only env values are dropped");
        });
    }

    #[test]
    fn bools_parse_leniently_and_bad_values_are_ignored() {
        assert_eq!(parse_bool("true"), Some(true));
        assert_eq!(parse_bool("1"), Some(true));
        assert_eq!(parse_bool("ON"), Some(true));
        assert_eq!(parse_bool("no"), Some(false));
        assert_eq!(parse_bool("off"), Some(false));
        assert_eq!(parse_bool("maybe"), None);
    }

    #[test]
    fn outbound_override_rewrites_only_mapped_hosts() {
        let mut c = Config::default();
        c.upstream_override
            .insert("vortex.wowsgame.cn".into(), "http://127.0.0.1:9111".into());
        assert_eq!(
            c.resolve_outbound("https://vortex.wowsgame.cn/api/accounts/1?x=2"),
            "http://127.0.0.1:9111/api/accounts/1?x=2"
        );
        assert_eq!(
            c.resolve_outbound("https://vortex.worldofwarships.eu/api/accounts/1"),
            "https://vortex.worldofwarships.eu/api/accounts/1"
        );
        // Garbage survives verbatim (the caller validates shapes).
        assert_eq!(c.resolve_outbound("not a url"), "not a url");
    }
}
