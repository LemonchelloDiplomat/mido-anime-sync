mod commands;
mod animego_bridge;
mod animego_event_bridge;
mod animego_script_inspector;

#[cfg(all(windows, not(debug_assertions)))]
use std::process::{Child, Command, Stdio};
#[cfg(all(windows, not(debug_assertions)))]
use std::sync::Mutex;
#[cfg(all(windows, not(debug_assertions)))]
use std::net::{SocketAddr, TcpStream};
#[cfg(all(windows, not(debug_assertions)))]
use std::time::{Duration, Instant};
#[cfg(all(windows, not(debug_assertions)))]
use std::fs::OpenOptions;
#[cfg(all(windows, not(debug_assertions)))]
use std::io::Write;

#[cfg(all(windows, not(debug_assertions)))]
use tauri::Manager;

#[cfg(all(windows, not(debug_assertions)))]
struct LocalApiProcess(Mutex<Child>);

#[cfg(all(windows, not(debug_assertions)))]
impl Drop for LocalApiProcess {
    fn drop(&mut self) {
        if let Ok(child) = self.0.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(all(windows, not(debug_assertions)))]
fn start_local_api(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let node = resource_dir.join("node.exe");
    let server_dir = resource_dir.join("server");
    let entrypoint = server_dir.join("index.mjs");
    let data_dir = app.path().app_data_dir()?;

    if !node.is_file() || !entrypoint.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "Bundled runtime missing. node={}, server={}",
                node.display(),
                entrypoint.display()
            ),
        ).into());
    }
    std::fs::create_dir_all(&data_dir)?;

    let api_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("api.log"))?;
    let api_error_log = api_log.try_clone()?;

    let mut child = Command::new(node)
        .arg(entrypoint)
        .current_dir(&server_dir)
        .env("MIDO_DATA_DIR", &data_dir)
        .env("HOST", "127.0.0.1")
        .env("PORT", "3001")
        .stdin(Stdio::null())
        .stdout(Stdio::from(api_log))
        .stderr(Stdio::from(api_error_log))
        .spawn()?;

    let address = SocketAddr::from(([127, 0, 0, 1], 3001));
    let deadline = Instant::now() + Duration::from_secs(12);
    let mut ready = false;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Local API server exited during startup: {status}. See api.log."),
            ).into());
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    if !ready {
        let _ = child.kill();
        let _ = child.wait();
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "Local API server did not become ready within 12 seconds. See api.log.",
        ).into());
    }

    app.manage(LocalApiProcess(Mutex::new(child)));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(all(windows, not(debug_assertions)))]
            if let Err(error) = start_local_api(app) {
                let message = format!("Local API startup failed: {error}");
                eprintln!("{message}");
                if let Ok(data_dir) = app.path().app_data_dir() {
                    let _ = std::fs::create_dir_all(&data_dir);
                    if let Ok(mut log) = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(data_dir.join("startup.log"))
                    {
                        let _ = writeln!(log, "{message}");
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "animego-auth" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::streaming_secret_get,
            commands::streaming_secret_set,
            commands::streaming_secret_remove,
            commands::streaming_http_request,
            commands::animego_auth_open,
            commands::animego_auth_complete,
            commands::animego_auth_status,
            commands::animego_auth_disconnect,
            commands::animego_account_list_fetch,
            commands::animego_account_write_inspect,
            commands::animego_account_rating_write,
            commands::animego_account_status_write,
            commands::animego_account_delete,
            commands::animego_account_progress_fetch,
            commands::animego_account_progress_write,
            commands::animego_network_inspect,
            commands::animego_ipc_ready,
            animego_bridge::animego_ipc_test,
            animego_event_bridge::animego_bridge_stage,
            animego_event_bridge::animego_bridge_complete,
            animego_event_bridge::animego_bridge_ping
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mido Anime Sync");
}
