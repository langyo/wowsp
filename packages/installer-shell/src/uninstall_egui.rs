//! egui fallback uninstaller for machines without WebView2: a native
//! confirm → progress → done flow with no webview dependency. It mirrors
//! the Tauri uninstall page (卸载 WoWSP) one-to-one in a 420×240 window —
//! the same "zero-cost floor" the shun design reserves for machines with
//! nothing at all.
//!
//! One deliberate concession to minimalism: egui's bundled fonts carry no
//! CJK glyphs, so a system font (Microsoft YaHei first) is loaded at
//! startup and pushed in front of the defaults — without it every Chinese
//! label renders as hollow boxes.

use std::sync::{Arc, Mutex};

use eframe::egui;

use shun::config::ShunConfig;
use shun::targets::install::{InstallContext, WindowsRegistration};

/// Candidate system fonts for CJK glyphs, tried in order. msyh.ttc
/// (Microsoft YaHei) ships with every zh system; simsun.ttc is the legacy
/// fallback; arial.ttf is Latin-only — better than nothing, though the
/// labels would lose their Chinese text.
const CJK_FONT_CANDIDATES: &[&str] = &[
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simsun.ttc",
    r"C:\Windows\Fonts\arial.ttf",
];

/// Shared flow state: written by the worker thread running the uninstall,
/// polled by the UI each frame.
enum UninstallState {
    Idle,
    Running,
    Done,
    Failed(String),
}

/// What the frame's UI decided should happen next — resolved outside the
/// panel closure so the mutex is never held across an action.
enum Action {
    Start,
    Close,
}

/// The native app: one window, one panel, three views.
struct UninstallApp {
    state: Arc<Mutex<UninstallState>>,
    /// The uninstall context, `take()`-n into the worker thread on start.
    ctx: Option<InstallContext>,
}

impl UninstallApp {
    /// Spawns the uninstall on a worker thread; the UI polls `state`
    /// while it runs.
    fn start(&mut self) {
        let Some(ctx) = self.ctx.take() else {
            return;
        };
        *self.state.lock().expect("uninstall state poisoned") = UninstallState::Running;
        let state = Arc::clone(&self.state);
        std::thread::spawn(move || {
            let result = shun::targets::install::uninstall(&ctx, &WindowsRegistration);
            let mut slot = state.lock().expect("uninstall state poisoned");
            *slot = match result {
                Ok(()) => UninstallState::Done,
                Err(e) => UninstallState::Failed(e.to_string()),
            };
        });
    }
}

impl eframe::App for UninstallApp {
    fn update(&mut self, ui_ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let mut action = None;
        egui::CentralPanel::default().show(ui_ctx, |ui| {
            let guard = self.state.lock().expect("uninstall state poisoned");
            ui.with_layout(
                egui::Layout::top_down_justified(egui::Align::Center),
                |ui| match &*guard {
                    UninstallState::Idle => {
                        ui.add_space(24.0);
                        ui.heading("卸载 WoWSP");
                        ui.add_space(8.0);
                        ui.label("这将移除 WoWSP 及其注册的系统项。模型资源与用户数据将保留。");
                        ui.add_space(20.0);
                        ui.horizontal(|ui| {
                            if ui.button("卸载").clicked() {
                                action = Some(Action::Start);
                            }
                            if ui.button("取消").clicked() {
                                action = Some(Action::Close);
                            }
                        });
                    },
                    UninstallState::Running => {
                        ui.add_space(48.0);
                        ui.add(egui::Spinner::new().size(28.0));
                        ui.add_space(12.0);
                        ui.label("正在卸载…");
                    },
                    UninstallState::Done => {
                        ui.add_space(48.0);
                        ui.heading("已完成卸载。");
                        ui.add_space(20.0);
                        if ui.button("关闭").clicked() {
                            action = Some(Action::Close);
                        }
                    },
                    UninstallState::Failed(error) => {
                        ui.add_space(32.0);
                        ui.heading("卸载失败");
                        ui.add_space(8.0);
                        ui.colored_label(egui::Color32::from_rgb(0xE5, 0x48, 0x4D), error);
                        ui.add_space(20.0);
                        if ui.button("关闭").clicked() {
                            action = Some(Action::Close);
                        }
                    },
                },
            );
        });
        match action {
            Some(Action::Start) => self.start(),
            Some(Action::Close) => ui_ctx.send_viewport_cmd(egui::ViewportCommand::Close),
            None => {},
        }
    }
}

/// Runs the native uninstaller window. Builds the same context the Tauri
/// page's `perform_uninstall` command does (the running executable's
/// directory is the install target) and blocks until the window closes.
pub fn run(config: &ShunConfig) -> Result<(), String> {
    let uninstall_ctx = crate::uninstall_context(config)?;
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("WoWSP 卸载")
            .with_inner_size([420.0, 240.0])
            .with_resizable(false),
        ..Default::default()
    };
    eframe::run_native(
        "卸载 WoWSP",
        options,
        Box::new(|cc| {
            install_cjk_font(&cc.egui_ctx);
            Ok(Box::new(UninstallApp {
                state: Arc::new(Mutex::new(UninstallState::Idle)),
                ctx: Some(uninstall_ctx),
            }))
        }),
    )
    .map_err(|e| e.to_string())
}

/// Loads the first available system font and pushes it in front of
/// egui's proportional defaults, so the Chinese labels resolve against a
/// face that actually carries CJK glyphs. No-op when no candidate file
/// exists (the labels degrade to boxes, the flow still works).
fn install_cjk_font(ui_ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    for path in CJK_FONT_CANDIDATES {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        fonts.font_data.insert(
            "system-cjk".to_owned(),
            Arc::new(egui::FontData::from_owned(bytes)),
        );
        if let Some(family) = fonts.families.get_mut(&egui::FontFamily::Proportional) {
            family.insert(0, "system-cjk".to_owned());
        }
        break;
    }
    ui_ctx.set_fonts(fonts);
}
