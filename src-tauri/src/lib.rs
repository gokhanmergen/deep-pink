use rand::RngCore;
use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendConfig {
    url: String,
    token: String,
    platform: String,
    port: u16,
}

struct BackendProcess {
    child: Mutex<Option<CommandChild>>,
    config: BackendConfig,
    close_started: AtomicBool,
}

fn kill_backend_child(backend: &BackendProcess) {
    let child = backend.child.lock().ok().and_then(|mut child| child.take());
    if let Some(child) = child {
        let _ = child.kill();
    }
}

#[tauri::command]
fn backend_config(state: tauri::State<'_, Arc<BackendProcess>>) -> BackendConfig {
    state.config.clone()
}

fn choose_port() -> Result<u16, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn request_backend_shutdown(port: u16, token: &str) -> std::io::Result<()> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    write!(
        stream,
        "POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-DeepPink-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )?;

    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response)?;
    if response.starts_with("HTTP/1.1 200 ") {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "Backend shutdown returned {}",
            response.trim()
        )))
    }
}

fn data_directory(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Electron used the product slug below the platform's configuration root.
    // Reuse it so a Tauri install opens the existing database and attachments.
    let path = app.path().config_dir()?.join("deep-pink");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

fn secret_encryption_key() -> String {
    let entry = match keyring::Entry::new("dev.deeppink.app", "deep-pink-storage-key-v1") {
        Ok(entry) => entry,
        Err(error) => {
            eprintln!("OS credential storage is unavailable: {error}");
            return String::new();
        }
    };

    match entry.get_password() {
        Ok(key) if key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()) => key,
        Ok(_) => {
            eprintln!("The stored Deep Pink encryption key has an invalid format.");
            String::new()
        }
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0_u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            let key = bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            match entry.set_password(&key) {
                Ok(()) => key,
                Err(error) => {
                    eprintln!("Could not store the Deep Pink encryption key: {error}");
                    String::new()
                }
            }
        }
        Err(error) => {
            eprintln!("Could not access the OS credential store: {error}");
            String::new()
        }
    }
}

fn spawn_backend(app: &AppHandle) -> Result<Arc<BackendProcess>, Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let user_data = data_directory(app)?;
    let downloads = app.path().download_dir()?;
    let port = choose_port()?;
    let token: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect();

    let backend_resources = resource_dir.join("resources");
    let backend_script = backend_resources.join("backend.cjs");
    if !backend_script.is_file() {
        return Err(format!(
            "Tauri backend bundle not found at {}",
            backend_script.display()
        )
        .into());
    }

    let command = app
        .shell()
        .sidecar("deep-pink-node")?
        .arg(backend_script.to_string_lossy().as_ref())
        .env("NODE_PATH", backend_resources.join("node_modules").to_string_lossy().as_ref())
        .env("DEEP_PINK_RUNTIME", "tauri")
        .env("DEEP_PINK_USER_DATA_DIR", user_data.to_string_lossy().as_ref())
        .env("DEEP_PINK_DOWNLOADS_DIR", downloads.to_string_lossy().as_ref())
        .env("DEEP_PINK_SERVICE_PORT", port.to_string())
        .env("DEEP_PINK_SERVICE_TOKEN", &token)
        .env("DEEP_PINK_SERVICE_URL", format!("http://127.0.0.1:{port}"))
        .env("DEEP_PINK_VERSION", env!("CARGO_PKG_VERSION"))
        .env("DEEP_PINK_TAURI_VERSION", "2")
        .env("DEEP_PINK_STORAGE_KEY", secret_encryption_key())
        .env("DEEP_PINK_ALLOWED_ORIGINS", "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420")
        .env("DEEP_PINK_PACKAGED", if cfg!(debug_assertions) { "0" } else { "1" });

    let (mut events, child) = command.spawn()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                    print!("{}", String::from_utf8_lossy(&line));
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                    eprint!("{}", String::from_utf8_lossy(&line));
                }
                tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                    eprintln!("Deep Pink backend exited: {payload:?}");
                    let _ = app_handle.emit("backend:stopped", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(Arc::new(BackendProcess {
        child: Mutex::new(Some(child)),
        config: BackendConfig {
            url: format!("http://127.0.0.1:{port}"),
            token,
            platform: platform_name().to_owned(),
            port,
        },
        close_started: AtomicBool::new(false),
    }))
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let backend = spawn_backend(app.handle())?;
            app.manage(backend);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<Arc<BackendProcess>>();
                if !state.close_started.swap(true, Ordering::SeqCst) {
                    api.prevent_close();
                    let backend = Arc::clone(state.inner());
                    let closing_window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        let config = backend.config.clone();
                        let result = tauri::async_runtime::spawn_blocking(move || {
                            request_backend_shutdown(config.port, &config.token)
                        })
                        .await;
                        let failed = !matches!(&result, Ok(Ok(())));
                        if failed {
                            eprintln!("Could not stop the local backend cleanly: {result:?}");
                            kill_backend_child(&backend);
                        }
                        let _ = closing_window.close();
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![backend_config]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Arc<BackendProcess>>() {
                    kill_backend_child(&state);
                }
            }
        });
}
