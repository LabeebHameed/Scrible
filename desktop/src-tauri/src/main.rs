// Scrible desktop shell. Deliberately thin: all watcher logic lives in the tested
// watcher-core crate; all matching happens in the frontend against locally-synced
// items. Process names never leave this machine.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};

struct WatcherFlag(Arc<AtomicBool>);

/// Consent gate: the frontend flips this after confirming the `app_watcher`
/// consent. While disabled the poll loop keeps the diff baseline fresh but emits
/// nothing (so enabling never floods with already-running apps).
#[tauri::command]
fn set_watcher_enabled(state: tauri::State<'_, WatcherFlag>, enabled: bool) {
    state.0.store(enabled, Ordering::Relaxed);
}

fn main() {
    let enabled = Arc::new(AtomicBool::new(false));
    let flag = enabled.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(WatcherFlag(enabled))
        .invoke_handler(tauri::generate_handler![set_watcher_enabled])
        .on_window_event(|window, event| {
            // Close hides to tray; the watcher keeps running in the background.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(move |app| {
            let tray_handle = app.handle().clone();
            TrayIconBuilder::with_id("scrible-tray")
                .icon(app.default_window_icon().expect("window icon").clone())
                .tooltip("Scrible")
                .on_tray_icon_event(move |_tray, event| {
                    if matches!(event, TrayIconEvent::Click { .. }) {
                        if let Some(window) = tray_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            let emit_handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut diff = watcher_core::ProcessDiff::new();
                loop {
                    let fresh = diff.diff(watcher_core::snapshot());
                    if flag.load(Ordering::Relaxed) {
                        for name in fresh {
                            let _ = emit_handle.emit("app-opened", &name);
                        }
                    }
                    std::thread::sleep(Duration::from_secs(4));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Scrible desktop");
}
