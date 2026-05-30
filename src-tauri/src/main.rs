#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod db;
mod domain;

use anyhow::Result;
use sqlx::SqlitePool;
use tauri::State;

#[tauri::command]
async fn create_workspace(
    state: State<'_, SqlitePool>,
    name: String,
) -> Result<domain::Workspace, String> {
    db::create_workspace(&state, name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_workspaces(state: State<'_, SqlitePool>) -> Result<Vec<domain::Workspace>, String> {
    db::list_workspaces(&state)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn create_collection(
    state: State<'_, SqlitePool>,
    workspace_id: String,
    name: String,
) -> Result<domain::Collection, String> {
    db::create_collection(&state, workspace_id, name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_collections(
    state: State<'_, SqlitePool>,
    workspace_id: String,
) -> Result<Vec<domain::Collection>, String> {
    db::list_collections(&state, workspace_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn rename_collection(
    state: State<'_, SqlitePool>,
    collection_id: String,
    name: String,
) -> Result<domain::Collection, String> {
    db::rename_collection(&state, collection_id, name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn delete_collection(
    state: State<'_, SqlitePool>,
    collection_id: String,
) -> Result<(), String> {
    db::delete_collection(&state, collection_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_requests(
    state: State<'_, SqlitePool>,
    collection_id: String,
) -> Result<Vec<domain::ApiRequest>, String> {
    db::list_requests(&state, collection_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn import_postman_collection(
    state: State<'_, SqlitePool>,
    workspace_id: String,
    payload: String,
) -> Result<domain::PostmanImportResult, String> {
    db::import_postman_collection(&state, workspace_id, payload)
        .await
        .map_err(|err| err.to_string())
}

fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let pool = runtime.block_on(db::init_database("slinger.db"))?;
    runtime.block_on(db::ensure_default_workspace(&pool))?;

    tauri::Builder::default()
        .manage(pool)
        .invoke_handler(tauri::generate_handler![
            create_workspace,
            list_workspaces,
            create_collection,
            list_collections,
            rename_collection,
            delete_collection,
            list_requests,
            import_postman_collection,
        ])
        .run(tauri::generate_context!())?;

    Ok(())
}
