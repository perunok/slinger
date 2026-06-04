#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod db;
mod domain;

use anyhow::Result;
use reqwest::header::{HeaderName, HeaderValue};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::State;
use tokio::sync::{oneshot, Mutex};

type RequestCancelRegistry = Mutex<HashMap<String, oneshot::Sender<()>>>;

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
async fn create_environment(
    state: State<'_, SqlitePool>,
    workspace_id: String,
    name: String,
) -> Result<domain::Environment, String> {
    db::create_environment(&state, workspace_id, name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn ensure_default_environment(
    state: State<'_, SqlitePool>,
    workspace_id: String,
) -> Result<domain::Environment, String> {
    db::ensure_default_environment(&state, workspace_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_environments(
    state: State<'_, SqlitePool>,
    workspace_id: String,
) -> Result<Vec<domain::Environment>, String> {
    db::list_environments(&state, workspace_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_environment_variables(
    state: State<'_, SqlitePool>,
    environment_id: String,
) -> Result<Vec<domain::EnvironmentVariable>, String> {
    db::list_environment_variables(&state, environment_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn upsert_environment_variable(
    state: State<'_, SqlitePool>,
    environment_id: String,
    key: String,
    value: String,
) -> Result<domain::EnvironmentVariable, String> {
    db::upsert_environment_variable(&state, environment_id, key, value)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn delete_environment_variable(
    state: State<'_, SqlitePool>,
    variable_id: String,
) -> Result<(), String> {
    db::delete_environment_variable(&state, variable_id)
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
async fn create_request(
    state: State<'_, SqlitePool>,
    input: domain::CreateRequestInput,
) -> Result<domain::ApiRequest, String> {
    db::create_request(&state, input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn update_request(
    state: State<'_, SqlitePool>,
    input: domain::UpdateRequestInput,
) -> Result<domain::ApiRequest, String> {
    db::update_request(&state, input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn rename_request(
    state: State<'_, SqlitePool>,
    request_id: String,
    name: String,
) -> Result<domain::ApiRequest, String> {
    db::rename_request(&state, request_id, name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn delete_request(state: State<'_, SqlitePool>, request_id: String) -> Result<(), String> {
    db::delete_request(&state, request_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn list_folders(
    state: State<'_, SqlitePool>,
    collection_id: String,
) -> Result<Vec<domain::ApiFolder>, String> {
    db::list_folders(&state, collection_id)
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

fn default_export_directory() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let downloads = home.join("Downloads");

    if downloads.is_dir() {
        Some(downloads)
    } else {
        Some(home)
    }
}

#[tauri::command]
fn default_export_path(file_name: String) -> Result<String, String> {
    let safe_file_name = Path::new(file_name.trim())
        .file_name()
        .ok_or_else(|| "export file name is required".to_string())?
        .to_string_lossy()
        .to_string();

    if safe_file_name.trim().is_empty() {
        return Err("export file name is required".to_string());
    }

    let path = default_export_directory()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(safe_file_name);

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn write_export_file(path: String, contents: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("export path is required".to_string());
    }

    let path = PathBuf::from(trimmed);
    if path.is_dir() {
        return Err("export path must include a file name".to_string());
    }

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err("export folder does not exist".to_string());
        }
    }

    fs::write(path, contents).map_err(|err| err.to_string())
}

fn normalize_request_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.starts_with("//") {
        return format!("http:{}", trimmed);
    }
    if !trimmed.contains("://") && !trimmed.starts_with("mailto:") {
        return format!("http://{}", trimmed);
    }
    trimmed.to_string()
}

#[tauri::command]
async fn execute_http_request(
    input: domain::HttpRequestInput,
    request_run_id: Option<String>,
    cancel_registry: State<'_, RequestCancelRegistry>,
) -> Result<domain::HttpResponseData, String> {
    let method = input
        .method
        .parse::<reqwest::Method>()
        .map_err(|err| err.to_string())?;
    let url = normalize_request_url(&input.url);

    if url.is_empty() {
        return Err("request URL is required".to_string());
    }

    if url.contains("{{") || url.contains("}}") {
        return Err("request URL contains unresolved variables".to_string());
    }

    let client = reqwest::Client::new();
    let mut builder = client.request(method, &url);

    for header in input.headers {
        let key = header.key.trim();
        let value = header.value.trim();

        if key.is_empty() {
            continue;
        }

        let header_name = HeaderName::from_bytes(key.as_bytes()).map_err(|err| err.to_string())?;
        let header_value = HeaderValue::from_str(value).map_err(|err| err.to_string())?;
        builder = builder.header(header_name, header_value);
    }

    if let Some(body) = input.body {
        if !body.is_empty() {
            builder = builder.body(body);
        }
    }

    let request_run_id = request_run_id.filter(|id| !id.is_empty());
    let request_future = async move {
        let started_at = Instant::now();
        let response = builder.send().await.map_err(|err| err.to_string())?;
        let duration_ms = started_at.elapsed().as_millis();
        let status = response.status();
        let headers = response
            .headers()
            .iter()
            .map(|(key, value)| domain::RequestHeader {
                key: key.to_string(),
                value: value.to_str().unwrap_or("").to_string(),
            })
            .collect();
        let body = response.text().await.map_err(|err| err.to_string())?;

        Ok(domain::HttpResponseData {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            duration_ms,
            headers,
            body,
        })
    };

    if let Some(request_run_id) = request_run_id {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        cancel_registry
            .lock()
            .await
            .insert(request_run_id.clone(), cancel_tx);

        let result = tokio::select! {
            result = request_future => result,
            _ = cancel_rx => Err("request canceled".to_string()),
        };

        cancel_registry.lock().await.remove(&request_run_id);
        return result;
    }

    request_future.await
}

#[tauri::command]
async fn cancel_http_request(
    request_run_id: String,
    cancel_registry: State<'_, RequestCancelRegistry>,
) -> Result<(), String> {
    if let Some(cancel_tx) = cancel_registry.lock().await.remove(&request_run_id) {
        let _ = cancel_tx.send(());
    }

    Ok(())
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
        .manage(RequestCancelRegistry::default())
        .invoke_handler(tauri::generate_handler![
            create_workspace,
            list_workspaces,
            create_environment,
            ensure_default_environment,
            list_environments,
            list_environment_variables,
            upsert_environment_variable,
            delete_environment_variable,
            create_collection,
            list_collections,
            rename_collection,
            delete_collection,
            list_requests,
            create_request,
            update_request,
            rename_request,
            delete_request,
            list_folders,
            import_postman_collection,
            default_export_path,
            write_export_file,
            execute_http_request,
            cancel_http_request,
        ])
        .run(tauri::generate_context!())?;

    Ok(())
}
