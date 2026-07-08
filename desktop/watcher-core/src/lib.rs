//! Watcher core: process-name snapshots and launch detection.
//!
//! Privacy invariant: everything in this crate stays on the device. Process names
//! are diffed locally and matched locally against the user's app-triggered items —
//! they are never sent to the Scrible backend.

use std::collections::HashSet;
use sysinfo::System;

/// Normalize a raw process name for matching: lowercase, strip any path prefix and
/// common executable suffixes ("Photoshop.exe" / "Slack.app" -> "photoshop"/"slack").
pub fn normalize_process_name(raw: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(raw)
        .trim()
        .to_lowercase();
    for suffix in [".exe", ".app", ".bin"] {
        if let Some(stripped) = base.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    base
}

/// Tracks the set of running process names between polls and reports the ones that
/// newly appeared. Names that disappear are forgotten, so re-launching the same app
/// later triggers again (each launch is one event).
#[derive(Default)]
pub struct ProcessDiff {
    known: HashSet<String>,
    primed: bool,
}

impl ProcessDiff {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed the current snapshot; returns newly-appeared normalized names.
    /// The first call primes the baseline and reports nothing (apps already
    /// running when the watcher starts are not "launches").
    pub fn diff<I: IntoIterator<Item = String>>(&mut self, current: I) -> Vec<String> {
        let now: HashSet<String> = current
            .into_iter()
            .map(|n| normalize_process_name(&n))
            .filter(|n| n.len() >= 2)
            .collect();
        let new_names = if self.primed {
            let mut fresh: Vec<String> = now.difference(&self.known).cloned().collect();
            fresh.sort();
            fresh
        } else {
            self.primed = true;
            Vec::new()
        };
        self.known = now;
        new_names
    }
}

/// Snapshot the names of all running processes (cross-platform via sysinfo).
pub fn snapshot() -> Vec<String> {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    sys.processes()
        .values()
        .map(|p| p.name().to_string_lossy().into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_paths_and_suffixes() {
        assert_eq!(normalize_process_name("Photoshop.exe"), "photoshop");
        assert_eq!(normalize_process_name(r"C:\Program Files\Adobe\Photoshop.exe"), "photoshop");
        assert_eq!(normalize_process_name("/Applications/Slack.app"), "slack");
        assert_eq!(normalize_process_name("  Figma "), "figma");
    }

    #[test]
    fn first_poll_primes_without_reporting() {
        let mut d = ProcessDiff::new();
        assert!(d.diff(vec!["Photoshop.exe".into(), "finder".into()]).is_empty());
    }

    #[test]
    fn reports_only_newly_appeared() {
        let mut d = ProcessDiff::new();
        d.diff(vec!["finder".into()]);
        let fresh = d.diff(vec!["finder".into(), "Figma".into()]);
        assert_eq!(fresh, vec!["figma"]);
        // Unchanged snapshot -> nothing new.
        assert!(d.diff(vec!["finder".into(), "Figma".into()]).is_empty());
    }

    #[test]
    fn relaunch_after_quit_triggers_again() {
        let mut d = ProcessDiff::new();
        d.diff(vec!["finder".into()]);
        assert_eq!(d.diff(vec!["finder".into(), "Slack.app".into()]), vec!["slack"]);
        d.diff(vec!["finder".into()]); // slack quit
        assert_eq!(d.diff(vec!["finder".into(), "Slack.app".into()]), vec!["slack"]);
    }

    #[test]
    fn real_snapshot_returns_processes() {
        // Sanity: this test process itself is running.
        assert!(!snapshot().is_empty());
    }
}
