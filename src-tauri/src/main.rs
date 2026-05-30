#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod db;
mod domain;

use anyhow::Result;
use sqlx::SqlitePool;
use tauri::{Manager, State};

#[tauri::command]
async fn create_workspace(state: State<'_, SqlitePool>, name: String) -> Result<domain::Workspace, String> {
    db::create_workspace(&state, name)
        .await
        .map_err(|err| err.to_string())
}

fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let pool = runtime.block_on(db::init_database("slinger.db"))?;

    tauri::Builder::default()
        .manage(pool)
        .invoke_handler(tauri::generate_handler![create_workspace])
        .run(tauri::generate_context!())?;

    Ok(())
}
