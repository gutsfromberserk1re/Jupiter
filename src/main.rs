
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use eframe::egui;
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::Duration,
};

#[derive(Default)]
struct PanelRun {
    apk: Option<PathBuf>,
    backend: String,
    backend_status: String,
    log: String,
    running: bool,
    child: Option<Child>,
    rx: Option<Receiver<String>>,
}

impl PanelRun {
    fn pick_apk(&mut self) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("Android package", &["apk", "apks", "xapk"])
            .pick_file()
        {
            self.apk = Some(path);
            self.log.clear();
        }
    }

    fn start(&mut self) {
        let Some(apk) = self.apk.clone() else {
            self.log = "Choose an APK first.".into();
            return;
        };

        let backend = self.backend.trim();
        if backend.is_empty() {
            self.log = "Set the path to a compatible Android runtime executable first.".into();
            return;
        }
        let backend_path = PathBuf::from(backend);
        if !backend_path.is_file() {
            self.log = format!("Runtime executable not found:\n{}", backend_path.display());
            return;
        }
        if !apk.is_file() {
            self.log = "The selected package file no longer exists.".into();
            return;
        }

        // This is intentionally a generic adapter. The backend's actual CLI must be
        // verified before claiming a package format or launch syntax is supported.
        let (tx, rx) = mpsc::channel();
        let exe = backend_path.clone();
        let apk_for_thread = apk.clone();
        thread::spawn(move || {
            let result = Command::new(&exe)
                .arg(&apk_for_thread)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn();

            match result {
                Ok(mut child) => {
                    let _ = tx.send(format!(
                        "Started backend process: {}\nPackage: {}\n\n\
                         This prototype can launch a backend process, but does not yet \
                         implement Android runtime APIs or verify app compatibility.",
                        exe.display(),
                        apk_for_thread.display()
                    ));
                    // Keep this thread lightweight; the GUI owns no blocking wait.
                    match child.wait() {
                        Ok(status) => {
                            let _ = tx.send(format!("Backend exited with status: {status}"));
                        }
                        Err(e) => {
                            let _ = tx.send(format!("Could not wait for backend: {e}"));
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(format!("Could not start backend: {e}"));
                }
            }
        });

        self.rx = Some(rx);
        self.running = true;
        self.log = format!(
            "Launching backend for:\n{}\n\nRuntime integration is not configured yet.",
            apk.display()
        );
    }

    fn poll_backend(&mut self) {
        if let Some(rx) = &self.rx {
            while let Ok(line) = rx.try_recv() {
                self.log.push_str("\n\n");
                self.log.push_str(&line);
                if line.starts_with("Backend exited") || line.starts_with("Could not") {
                    self.running = false;
                }
            }
        }
    }
}

impl eframe::App for PanelRun {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll_backend();
        ctx.request_repaint_after(Duration::from_millis(200));

        egui::CentralPanel::default()
            .frame(egui::Frame::default().fill(egui::Color32::from_rgb(20, 23, 28)))
            .show(ctx, |ui| {
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    ui.heading(egui::RichText::new("PanelRun").size(25.0).strong()
                        .color(egui::Color32::from_rgb(235, 239, 245)));
                    ui.label(egui::RichText::new("APK runtime experiment").color(egui::Color32::GRAY));
                });
                ui.add_space(16.0);

                ui.group(|ui| {
                    ui.set_width(ui.available_width());
                    ui.label("ANDROID PACKAGE");
                    ui.horizontal(|ui| {
                        let shown = self.apk.as_ref()
                            .map(|p| p.display().to_string())
                            .unwrap_or_else(|| "Choose an .apk file…".into());
                        ui.add(egui::Label::new(shown).truncate());
                        if ui.button("Browse…").clicked() {
                            self.pick_apk();
                        }
                    });
                    ui.add_space(10.0);
                    ui.label("RUNTIME EXECUTABLE");
                    ui.text_edit_singleline(&mut self.backend);
                    ui.label(egui::RichText::new(
                        "Backend CLI is not yet configured. A runtime must implement Android app execution; a launcher alone cannot run APKs."
                    ).small().color(egui::Color32::from_rgb(180, 185, 194)));
                    ui.add_space(12.0);
                    ui.horizontal(|ui| {
                        if ui.add_enabled(!self.running, egui::Button::new("Run APK")).clicked() {
                            self.start();
                        }
                        if ui.button("Clear log").clicked() {
                            self.log.clear();
                        }
                    });
                });

                ui.add_space(12.0);
                ui.label(egui::RichText::new("OUTPUT").strong());
                egui::ScrollArea::vertical().max_height(300.0).show(ui, |ui| {
                    ui.add(egui::TextEdit::multiline(&mut self.log)
                        .desired_rows(10)
                        .font(egui::TextStyle::Monospace)
                        .desired_width(f32::INFINITY)
                        .interactive(false));
                });

                ui.with_layout(egui::Layout::bottom_up(egui::Align::LEFT), |ui| {
                    ui.label(egui::RichText::new(
                        "Prototype only • No Android runtime included • Windows x64"
                    ).small().color(egui::Color32::GRAY));
                });
            });
    }
}

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([620.0, 500.0])
            .with_min_inner_size([500.0, 420.0])
            .with_title("PanelRun"),
        ..Default::default()
    };
    eframe::run_native(
        "PanelRun",
        options,
        Box::new(|_cc| Ok(Box::new(PanelRun::default()))),
    )
}
