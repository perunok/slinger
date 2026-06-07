use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use sqlx::{
    query, query_as,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

use crate::domain::{
    ApiFolder, ApiRequest, ApplyCloudWorkspaceInput, CloudSyncOperationInput, Collection,
    CreateRequestInput, Environment, EnvironmentVariable, PostmanImportResult, UpdateRequestInput,
    Workspace, WorkspaceVersioningCommit, WorkspaceVersioningFileChange,
    WorkspaceVersioningRestoreResult, WorkspaceVersioningStatus,
};

fn now_unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub async fn init_database(path: &str) -> Result<SqlitePool> {
    let db_path = std::path::Path::new(path);
    let database_path = if db_path.is_absolute() {
        db_path.to_path_buf()
    } else {
        std::env::current_dir()?.join(db_path)
    };

    if let Some(parent) = database_path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await?;
        }
    }

    tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&database_path)
        .await?;

    let connect_options = SqliteConnectOptions::new()
        .filename(&database_path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(connect_options)
        .await?;

    query(
        r#"
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            version INTEGER NOT NULL DEFAULT 1
        );
        "#,
    )
    .execute(&pool)
    .await?;

    query(
        r#"
        CREATE TABLE IF NOT EXISTS collections (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        "#,
    )
    .execute(&pool)
    .await?;

    query(
        r#"
        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            collection_id TEXT NOT NULL,
            parent_folder_id TEXT,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
            FOREIGN KEY(collection_id) REFERENCES collections(id),
            FOREIGN KEY(parent_folder_id) REFERENCES folders(id)
        );
        "#,
    )
    .execute(&pool)
    .await?;

    query(
        r#"
        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            collection_id TEXT NOT NULL,
            folder_id TEXT,
            name TEXT NOT NULL,
            method TEXT NOT NULL,
            url TEXT NOT NULL,
            document_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
            FOREIGN KEY(collection_id) REFERENCES collections(id),
            FOREIGN KEY(folder_id) REFERENCES folders(id)
        );
        "#,
    )
    .execute(&pool)
    .await?;

    query(
        r#"
        CREATE TABLE IF NOT EXISTS environments (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
        );
        "#,
    )
    .execute(&pool)
    .await?;

    query(
        r#"
        CREATE TABLE IF NOT EXISTS environment_variables (
            id TEXT PRIMARY KEY,
            environment_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            is_secret INTEGER NOT NULL DEFAULT 0,
            masked_value TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            UNIQUE(environment_id, key),
            FOREIGN KEY(environment_id) REFERENCES environments(id)
        );
        "#,
    )
    .execute(&pool)
    .await?;

    ensure_legacy_schema(&pool).await?;

    Ok(pool)
}

async fn ensure_legacy_schema(pool: &SqlitePool) -> Result<()> {
    ensure_column(
        pool,
        "workspaces",
        "updated_at",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    ensure_column(pool, "workspaces", "version", "INTEGER NOT NULL DEFAULT 1").await?;
    backfill_mutable_metadata(pool, "workspaces").await?;

    ensure_column(
        pool,
        "collections",
        "updated_at",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    ensure_column(pool, "collections", "version", "INTEGER NOT NULL DEFAULT 1").await?;
    backfill_mutable_metadata(pool, "collections").await?;

    ensure_column(pool, "folders", "updated_at", "INTEGER NOT NULL DEFAULT 0").await?;
    ensure_column(pool, "folders", "version", "INTEGER NOT NULL DEFAULT 1").await?;
    backfill_mutable_metadata(pool, "folders").await?;

    ensure_column(pool, "requests", "folder_id", "TEXT").await?;
    ensure_column(pool, "requests", "updated_at", "INTEGER NOT NULL DEFAULT 0").await?;
    ensure_column(pool, "requests", "version", "INTEGER NOT NULL DEFAULT 1").await?;
    backfill_mutable_metadata(pool, "requests").await?;

    ensure_column(
        pool,
        "environments",
        "updated_at",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    ensure_column(
        pool,
        "environments",
        "version",
        "INTEGER NOT NULL DEFAULT 1",
    )
    .await?;
    backfill_mutable_metadata(pool, "environments").await?;

    ensure_column(
        pool,
        "environment_variables",
        "is_secret",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    ensure_column(pool, "environment_variables", "masked_value", "TEXT").await?;
    ensure_column(
        pool,
        "environment_variables",
        "updated_at",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    ensure_column(
        pool,
        "environment_variables",
        "version",
        "INTEGER NOT NULL DEFAULT 1",
    )
    .await?;
    backfill_mutable_metadata(pool, "environment_variables").await?;

    Ok(())
}

async fn ensure_column(
    pool: &SqlitePool,
    table_name: &str,
    column_name: &str,
    definition: &str,
) -> Result<()> {
    let pragma = format!("PRAGMA table_info({})", table_name);
    let columns: Vec<(i64, String, String, i64, Option<String>, i64)> =
        query_as(&pragma).fetch_all(pool).await?;
    let has_column = columns
        .iter()
        .any(|(_, name, _, _, _, _)| name == column_name);

    if !has_column {
        let statement = format!(
            "ALTER TABLE {} ADD COLUMN {} {}",
            table_name, column_name, definition
        );
        query(&statement).execute(pool).await?;
    }

    Ok(())
}

async fn backfill_mutable_metadata(pool: &SqlitePool, table_name: &str) -> Result<()> {
    let update_updated_at = format!(
        "UPDATE {} SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = 0",
        table_name
    );
    query(&update_updated_at).execute(pool).await?;

    let update_version = format!(
        "UPDATE {} SET version = 1 WHERE version IS NULL OR version <= 0",
        table_name
    );
    query(&update_version).execute(pool).await?;

    Ok(())
}

pub async fn ensure_default_workspace(pool: &SqlitePool) -> Result<()> {
    let (count,): (i64,) = query_as("SELECT COUNT(*) FROM workspaces")
        .fetch_one(pool)
        .await?;

    if count == 0 {
        create_workspace(pool, "Personal".to_string()).await?;
    }

    Ok(())
}

pub async fn list_workspaces(pool: &SqlitePool) -> Result<Vec<Workspace>> {
    Ok(query_as::<_, Workspace>(
        r#"
        SELECT id, name, created_at, updated_at, version
        FROM workspaces
        ORDER BY created_at, id
        "#,
    )
    .fetch_all(pool)
    .await?)
}

pub async fn create_workspace(pool: &SqlitePool, name: String) -> Result<Workspace> {
    let name = name.trim().to_string();
    if name.is_empty() {
        bail!("workspace name is required");
    }

    let now = now_unix_seconds();
    let workspace = Workspace {
        id: Uuid::now_v7().to_string(),
        name,
        created_at: now,
        updated_at: now,
        version: 1,
    };

    query(
        r#"
        INSERT INTO workspaces (id, name, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?)
        "#,
    )
    .bind(&workspace.id)
    .bind(&workspace.name)
    .bind(workspace.created_at)
    .bind(workspace.updated_at)
    .bind(workspace.version)
    .execute(pool)
    .await?;

    ensure_default_environment(pool, workspace.id.clone()).await?;

    Ok(workspace)
}

pub async fn delete_workspace(pool: &SqlitePool, workspace_id: String) -> Result<()> {
    let workspace_id = Uuid::parse_str(&workspace_id)?.to_string();

    query("DELETE FROM environment_variables WHERE environment_id IN (SELECT id FROM environments WHERE workspace_id = ?)")
        .bind(&workspace_id)
        .execute(pool)
        .await?;
    query("DELETE FROM requests WHERE workspace_id = ?")
        .bind(&workspace_id)
        .execute(pool)
        .await?;
    query("DELETE FROM folders WHERE workspace_id = ?")
        .bind(&workspace_id)
        .execute(pool)
        .await?;
    query("DELETE FROM collections WHERE workspace_id = ?")
        .bind(&workspace_id)
        .execute(pool)
        .await?;
    query("DELETE FROM environments WHERE workspace_id = ?")
        .bind(&workspace_id)
        .execute(pool)
        .await?;
    let result = query("DELETE FROM workspaces WHERE id = ?")
        .bind(&workspace_id)
        .execute(pool)
        .await?;

    if result.rows_affected() == 0 {
        bail!("workspace not found");
    }

    Ok(())
}

pub async fn apply_cloud_workspace(
    pool: &SqlitePool,
    input: ApplyCloudWorkspaceInput,
) -> Result<()> {
    let local_workspace_id = input.local_workspace_id;

    let workspace_exists: Option<(String,)> = query_as("SELECT id FROM workspaces WHERE id = ?")
        .bind(&local_workspace_id)
        .fetch_optional(pool)
        .await?;
    if workspace_exists.is_none() {
        bail!("workspace not found");
    }

    for operation in input.operations {
        apply_cloud_operation(pool, &local_workspace_id, operation).await?;
    }

    Ok(())
}

async fn apply_cloud_operation(
    pool: &SqlitePool,
    local_workspace_id: &str,
    operation: CloudSyncOperationInput,
) -> Result<()> {
    if operation.op != "upsert" {
        return Ok(());
    }

    match operation.resource_type.as_str() {
        "workspace" => {
            let name = operation
                .payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Workspace")
                .trim()
                .to_string();
            let now = now_unix_seconds();
            let current_version: Option<(i64,)> =
                query_as("SELECT version FROM workspaces WHERE id = ?")
                    .bind(local_workspace_id)
                    .fetch_optional(pool)
                    .await?;
            let explicit_version = operation
                .payload
                .get("resource_version")
                .and_then(Value::as_i64);
            let version = explicit_version.unwrap_or_else(|| {
                next_sync_version(
                    current_version.map(|entry| entry.0).unwrap_or_default(),
                    operation.base_version.unwrap_or_default(),
                )
            });
            query(
                r#"
                UPDATE workspaces
                SET name = ?, updated_at = ?, version = ?
                WHERE id = ?
                "#,
            )
            .bind(name)
            .bind(now)
            .bind(version)
            .bind(local_workspace_id)
            .execute(pool)
            .await?;
            Ok(())
        }
        "collection" => {
            let name = operation
                .payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Untitled Collection")
                .trim()
                .to_string();
            let now = now_unix_seconds();
            query(
                r#"
                INSERT INTO collections (id, workspace_id, name, created_at, updated_at, version)
                VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    name = excluded.name,
                    updated_at = excluded.updated_at,
                    version = collections.version + 1
                "#,
            )
            .bind(&operation.resource_id)
            .bind(local_workspace_id)
            .bind(name)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
            Ok(())
        }
        "folder" => {
            let name = operation
                .payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Untitled Folder")
                .trim()
                .to_string();
            let collection_id = operation
                .payload
                .get("collection_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("folder collection_id is required"))?;
            let parent_folder_id = operation
                .payload
                .get("parent_folder_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let now = now_unix_seconds();
            query(
                r#"
                INSERT INTO folders (id, workspace_id, collection_id, parent_folder_id, name, created_at, updated_at, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    collection_id = excluded.collection_id,
                    parent_folder_id = excluded.parent_folder_id,
                    name = excluded.name,
                    updated_at = excluded.updated_at,
                    version = folders.version + 1
                "#,
            )
            .bind(&operation.resource_id)
            .bind(local_workspace_id)
            .bind(collection_id)
            .bind(parent_folder_id)
            .bind(name)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
            Ok(())
        }
        "request" => {
            let name = operation
                .payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Untitled Request")
                .trim()
                .to_string();
            let method = operation
                .payload
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .trim()
                .to_uppercase();
            let url = operation
                .payload
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let document_json = operation
                .payload
                .get("document_json")
                .and_then(Value::as_str)
                .unwrap_or("{}")
                .to_string();
            let collection_id = operation
                .payload
                .get("collection_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("request collection_id is required"))?;
            let folder_id = operation
                .payload
                .get("folder_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let now = now_unix_seconds();
            query(
                r#"
                INSERT INTO requests (id, workspace_id, collection_id, folder_id, name, method, url, document_json, created_at, updated_at, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    collection_id = excluded.collection_id,
                    folder_id = excluded.folder_id,
                    name = excluded.name,
                    method = excluded.method,
                    url = excluded.url,
                    document_json = excluded.document_json,
                    updated_at = excluded.updated_at,
                    version = requests.version + 1
                "#,
            )
            .bind(&operation.resource_id)
            .bind(local_workspace_id)
            .bind(collection_id)
            .bind(folder_id)
            .bind(name)
            .bind(method)
            .bind(url)
            .bind(document_json)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
            Ok(())
        }
        "environment" => {
            let name = operation
                .payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Local")
                .trim()
                .to_string();
            let now = now_unix_seconds();
            query(
                r#"
                INSERT INTO environments (id, workspace_id, name, created_at, updated_at, version)
                VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    name = excluded.name,
                    updated_at = excluded.updated_at,
                    version = environments.version + 1
                "#,
            )
            .bind(&operation.resource_id)
            .bind(local_workspace_id)
            .bind(name)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
            Ok(())
        }
        "environment_variable" => {
            let environment_id = operation
                .payload
                .get("environment_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!("environment_variable environment_id is required")
                })?;
            let key = operation
                .payload
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let value = operation
                .payload
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let is_secret = operation
                .payload
                .get("is_secret")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let now = now_unix_seconds();
            query(
                r#"
                INSERT INTO environment_variables (id, environment_id, key, value, is_secret, masked_value, created_at, updated_at, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(id) DO UPDATE SET
                    environment_id = excluded.environment_id,
                    key = excluded.key,
                    value = excluded.value,
                    is_secret = excluded.is_secret,
                    masked_value = excluded.masked_value,
                    updated_at = excluded.updated_at,
                    version = environment_variables.version + 1
                "#,
            )
            .bind(&operation.resource_id)
            .bind(environment_id)
            .bind(key)
            .bind(value)
            .bind(is_secret)
            .bind(Option::<String>::None)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
            Ok(())
        }
        _ => Ok(()),
    }
}

fn next_sync_version(current_version: i64, base_version: i64) -> i64 {
    if current_version <= 0 {
        if base_version > 0 {
            return base_version + 1;
        }
        return 1;
    }

    if base_version >= current_version {
        return base_version + 1;
    }

    current_version + 1
}

pub async fn list_environments(
    pool: &SqlitePool,
    workspace_id: String,
) -> Result<Vec<Environment>> {
    Ok(query_as::<_, Environment>(
        r#"
        SELECT id, workspace_id, name, created_at, updated_at, version
        FROM environments
        WHERE workspace_id = ?
        ORDER BY created_at, id
        "#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?)
}

pub async fn create_environment(
    pool: &SqlitePool,
    workspace_id: String,
    name: String,
) -> Result<Environment> {
    let workspace_id = Uuid::parse_str(&workspace_id)?.to_string();
    let name = name.trim().to_string();

    if name.is_empty() {
        bail!("environment name is required");
    }

    let now = now_unix_seconds();
    let environment = Environment {
        id: Uuid::now_v7().to_string(),
        workspace_id,
        name,
        created_at: now,
        updated_at: now,
        version: 1,
    };

    query(
        r#"
        INSERT INTO environments (id, workspace_id, name, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&environment.id)
    .bind(&environment.workspace_id)
    .bind(&environment.name)
    .bind(environment.created_at)
    .bind(environment.updated_at)
    .bind(environment.version)
    .execute(pool)
    .await?;

    Ok(environment)
}

pub async fn ensure_default_environment(
    pool: &SqlitePool,
    workspace_id: String,
) -> Result<Environment> {
    let workspace_id = Uuid::parse_str(&workspace_id)?.to_string();
    let existing = query_as::<_, Environment>(
        r#"
        SELECT id, workspace_id, name, created_at, updated_at, version
        FROM environments
        WHERE workspace_id = ?
        ORDER BY created_at, id
        LIMIT 1
        "#,
    )
    .bind(&workspace_id)
    .fetch_optional(pool)
    .await?;

    match existing {
        Some(environment) => Ok(environment),
        None => create_environment(pool, workspace_id, "Local".to_string()).await,
    }
}

pub async fn list_environment_variables(
    pool: &SqlitePool,
    environment_id: String,
) -> Result<Vec<EnvironmentVariable>> {
    Ok(query_as::<_, EnvironmentVariable>(
        r#"
        SELECT id, environment_id, key, value, is_secret, masked_value, created_at, updated_at, version
        FROM environment_variables
        WHERE environment_id = ?
        ORDER BY key COLLATE NOCASE, created_at, id
        "#,
    )
    .bind(environment_id)
    .fetch_all(pool)
    .await?)
}

pub async fn upsert_environment_variable(
    pool: &SqlitePool,
    environment_id: String,
    key: String,
    value: String,
) -> Result<EnvironmentVariable> {
    let environment_id = Uuid::parse_str(&environment_id)?.to_string();
    let key = key.trim().to_string();

    if key.is_empty() {
        bail!("variable key is required");
    }

    let existing_id: Option<(String,)> = query_as(
        r#"
        SELECT id
        FROM environment_variables
        WHERE environment_id = ? AND key = ?
        "#,
    )
    .bind(&environment_id)
    .bind(&key)
    .fetch_optional(pool)
    .await?;

    let now = now_unix_seconds();
    let variable = EnvironmentVariable {
        id: existing_id
            .map(|(id,)| id)
            .unwrap_or_else(|| Uuid::now_v7().to_string()),
        environment_id,
        key,
        value,
        is_secret: false,
        masked_value: None,
        created_at: now,
        updated_at: now,
        version: 1,
    };

    query(
        r#"
        INSERT INTO environment_variables (
            id, environment_id, key, value, is_secret, masked_value, created_at, updated_at, version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(environment_id, key)
        DO UPDATE SET
            value = excluded.value,
            is_secret = excluded.is_secret,
            masked_value = excluded.masked_value,
            updated_at = excluded.updated_at,
            version = environment_variables.version + 1
        "#,
    )
    .bind(&variable.id)
    .bind(&variable.environment_id)
    .bind(&variable.key)
    .bind(&variable.value)
    .bind(variable.is_secret)
    .bind(&variable.masked_value)
    .bind(variable.created_at)
    .bind(variable.updated_at)
    .bind(variable.version)
    .execute(pool)
    .await?;

    Ok(query_as::<_, EnvironmentVariable>(
        r#"
        SELECT id, environment_id, key, value, is_secret, masked_value, created_at, updated_at, version
        FROM environment_variables
        WHERE environment_id = ? AND key = ?
        "#,
    )
    .bind(&variable.environment_id)
    .bind(&variable.key)
    .fetch_one(pool)
    .await?)
}

pub async fn delete_environment_variable(pool: &SqlitePool, variable_id: String) -> Result<()> {
    query("DELETE FROM environment_variables WHERE id = ?")
        .bind(variable_id)
        .execute(pool)
        .await?;

    Ok(())
}

pub async fn list_collections(pool: &SqlitePool, workspace_id: String) -> Result<Vec<Collection>> {
    Ok(query_as::<_, Collection>(
        r#"
        SELECT id, workspace_id, name, created_at, updated_at, version
        FROM collections
        WHERE workspace_id = ?
        ORDER BY created_at, id
        "#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?)
}

pub async fn create_collection(
    pool: &SqlitePool,
    workspace_id: String,
    name: String,
) -> Result<Collection> {
    let workspace_id = Uuid::parse_str(&workspace_id)?.to_string();
    let name = name.trim().to_string();

    if name.is_empty() {
        bail!("collection name is required");
    }

    let now = now_unix_seconds();
    let collection = Collection {
        id: Uuid::now_v7().to_string(),
        workspace_id,
        name,
        created_at: now,
        updated_at: now,
        version: 1,
    };

    query(
        r#"
        INSERT INTO collections (id, workspace_id, name, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&collection.id)
    .bind(&collection.workspace_id)
    .bind(&collection.name)
    .bind(collection.created_at)
    .bind(collection.updated_at)
    .bind(collection.version)
    .execute(pool)
    .await?;

    Ok(collection)
}

pub async fn rename_collection(
    pool: &SqlitePool,
    collection_id: String,
    name: String,
) -> Result<Collection> {
    let name = name.trim().to_string();

    if name.is_empty() {
        bail!("collection name is required");
    }

    let now = now_unix_seconds();
    query("UPDATE collections SET name = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .bind(&name)
        .bind(now)
        .bind(&collection_id)
        .execute(pool)
        .await?;

    let collection = query_as::<_, Collection>(
        r#"
        SELECT id, workspace_id, name, created_at, updated_at, version
        FROM collections
        WHERE id = ?
        "#,
    )
    .bind(collection_id)
    .fetch_optional(pool)
    .await?;

    match collection {
        Some(collection) => Ok(collection),
        None => bail!("collection not found"),
    }
}

pub async fn delete_collection(pool: &SqlitePool, collection_id: String) -> Result<()> {
    query("DELETE FROM requests WHERE collection_id = ?")
        .bind(&collection_id)
        .execute(pool)
        .await?;

    query("DELETE FROM folders WHERE collection_id = ?")
        .bind(&collection_id)
        .execute(pool)
        .await?;

    query("DELETE FROM collections WHERE id = ?")
        .bind(collection_id)
        .execute(pool)
        .await?;

    Ok(())
}

pub async fn list_requests(pool: &SqlitePool, collection_id: String) -> Result<Vec<ApiRequest>> {
    Ok(query_as::<_, ApiRequest>(
        r#"
        SELECT id, workspace_id, collection_id, folder_id, name, method, url, document_json, created_at, updated_at, version
        FROM requests
        WHERE collection_id = ?
        ORDER BY created_at, id
        "#,
    )
    .bind(collection_id)
    .fetch_all(pool)
    .await?)
}

pub async fn create_request(pool: &SqlitePool, input: CreateRequestInput) -> Result<ApiRequest> {
    let workspace_id = Uuid::parse_str(&input.workspace_id)?.to_string();
    let collection_id = Uuid::parse_str(&input.collection_id)?.to_string();
    let name = input.name.trim().to_string();
    let method = input.method.trim().to_uppercase();

    if name.is_empty() {
        bail!("request name is required");
    }

    if method.is_empty() {
        bail!("request method is required");
    }

    let document: Value = serde_json::from_str(&input.document_json)?;
    let collection_exists: (i64,) = query_as(
        r#"
        SELECT COUNT(*)
        FROM collections
        WHERE id = ? AND workspace_id = ?
        "#,
    )
    .bind(&collection_id)
    .bind(&workspace_id)
    .fetch_one(pool)
    .await?;

    if collection_exists.0 == 0 {
        bail!("collection not found");
    }

    insert_request(
        pool,
        &workspace_id,
        &collection_id,
        None,
        name,
        method,
        input.url,
        document,
    )
    .await
}

pub async fn update_request(pool: &SqlitePool, input: UpdateRequestInput) -> Result<ApiRequest> {
    let request_id = Uuid::parse_str(&input.request_id)?.to_string();
    let name = input.name.trim().to_string();
    let method = input.method.trim().to_uppercase();
    if name.is_empty() {
        bail!("request name is required");
    }
    if method.is_empty() {
        bail!("request method is required");
    }
    let _: Value = serde_json::from_str(&input.document_json)?;

    let now = now_unix_seconds();
    let result = query(
        r#"
        UPDATE requests
        SET name = ?, method = ?, url = ?, document_json = ?, updated_at = ?, version = version + 1
        WHERE id = ?
        "#,
    )
    .bind(name)
    .bind(method)
    .bind(input.url)
    .bind(input.document_json)
    .bind(now)
    .bind(&request_id)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        bail!("request not found");
    }

    Ok(query_as::<_, ApiRequest>(
        r#"
        SELECT id, workspace_id, collection_id, folder_id, name, method, url, document_json, created_at, updated_at, version
        FROM requests
        WHERE id = ?
        "#,
    )
    .bind(request_id)
    .fetch_one(pool)
    .await?)
}

pub async fn rename_request(
    pool: &SqlitePool,
    request_id: String,
    name: String,
) -> Result<ApiRequest> {
    let request_id = Uuid::parse_str(&request_id)?.to_string();
    let name = name.trim().to_string();
    if name.is_empty() {
        bail!("request name is required");
    }

    let document_json: (String,) = query_as(
        r#"
        SELECT document_json
        FROM requests
        WHERE id = ?
        "#,
    )
    .bind(&request_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow::anyhow!("request not found"))?;

    let mut document: Value = serde_json::from_str(&document_json.0)?;
    match &mut document {
        Value::Object(map) => {
            map.insert("name".to_string(), Value::String(name.clone()));
        }
        _ => {
            document = json!({ "name": name });
        }
    }
    let document_json = serde_json::to_string(&document)?;

    let now = now_unix_seconds();
    query(
        r#"
        UPDATE requests
        SET name = ?, document_json = ?, updated_at = ?, version = version + 1
        WHERE id = ?
        "#,
    )
    .bind(&name)
    .bind(document_json)
    .bind(now)
    .bind(&request_id)
    .execute(pool)
    .await?;

    Ok(query_as::<_, ApiRequest>(
        r#"
        SELECT id, workspace_id, collection_id, folder_id, name, method, url, document_json, created_at, updated_at, version
        FROM requests
        WHERE id = ?
        "#,
    )
    .bind(request_id)
    .fetch_one(pool)
    .await?)
}

pub async fn delete_request(pool: &SqlitePool, request_id: String) -> Result<()> {
    let request_id = Uuid::parse_str(&request_id)?.to_string();
    let result = query("DELETE FROM requests WHERE id = ?")
        .bind(request_id)
        .execute(pool)
        .await?;

    if result.rows_affected() == 0 {
        bail!("request not found");
    }

    Ok(())
}

pub async fn list_folders(pool: &SqlitePool, collection_id: String) -> Result<Vec<ApiFolder>> {
    Ok(query_as::<_, ApiFolder>(
        r#"
        SELECT id, workspace_id, collection_id, parent_folder_id, name, created_at, updated_at, version
        FROM folders
        WHERE collection_id = ?
        ORDER BY created_at, id
        "#,
    )
    .bind(collection_id)
    .fetch_all(pool)
    .await?)
}

pub async fn import_postman_collection(
    pool: &SqlitePool,
    workspace_id: String,
    payload: String,
) -> Result<PostmanImportResult> {
    let workspace_id = Uuid::parse_str(&workspace_id)?.to_string();
    let parsed: Value = serde_json::from_str(&payload)?;
    let collection_name = parsed
        .get("info")
        .and_then(|info| info.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Imported Collection")
        .to_string();

    let items = parsed
        .get("item")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("Postman collection must contain an item array"))?;

    let collection = create_collection(pool, workspace_id.to_string(), collection_name).await?;
    let mut folder_drafts = Vec::new();
    let mut request_drafts = Vec::new();
    let mut next_folder_id = 1;
    collect_postman_entries(
        items,
        None,
        &mut next_folder_id,
        &mut folder_drafts,
        &mut request_drafts,
    );

    if request_drafts.is_empty() {
        delete_collection(pool, collection.id.clone()).await?;
        bail!("no requests found in Postman collection");
    }

    let mut folders = Vec::new();
    let mut requests = Vec::new();
    let mut folder_ids = HashMap::new();

    for draft in folder_drafts {
        let parent_folder_id = draft
            .parent_temp_id
            .and_then(|temp_id| folder_ids.get(&temp_id).cloned());
        let folder = insert_folder(
            pool,
            &workspace_id,
            &collection.id,
            parent_folder_id,
            draft.name,
        )
        .await?;

        folder_ids.insert(draft.temp_id, folder.id.clone());
        folders.push(folder);
    }

    for draft in request_drafts {
        let folder_id = draft
            .folder_temp_id
            .and_then(|temp_id| folder_ids.get(&temp_id).cloned());
        let request = insert_request(
            pool,
            &workspace_id,
            &collection.id,
            folder_id,
            draft.name,
            draft.method,
            draft.url,
            draft.document,
        )
        .await?;

        requests.push(request);
    }

    Ok(PostmanImportResult {
        collection,
        folders,
        requests,
    })
}

struct PostmanFolderDraft {
    temp_id: usize,
    parent_temp_id: Option<usize>,
    name: String,
}

struct PostmanRequestDraft {
    folder_temp_id: Option<usize>,
    name: String,
    method: String,
    url: String,
    document: Value,
}

fn collect_postman_entries(
    items: &[Value],
    parent_temp_id: Option<usize>,
    next_folder_id: &mut usize,
    folders: &mut Vec<PostmanFolderDraft>,
    requests: &mut Vec<PostmanRequestDraft>,
) {
    for item in items {
        if let Some(children) = item.get("item").and_then(Value::as_array) {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or("Untitled Folder")
                .to_string();
            let temp_id = *next_folder_id;
            *next_folder_id += 1;

            folders.push(PostmanFolderDraft {
                temp_id,
                parent_temp_id,
                name,
            });
            collect_postman_entries(children, Some(temp_id), next_folder_id, folders, requests);
            continue;
        }

        let Some(request) = item.get("request") else {
            continue;
        };

        let name = item
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or("Untitled Request")
            .to_string();
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|method| !method.is_empty())
            .unwrap_or("GET")
            .to_uppercase();
        let url = postman_url_to_string(request.get("url"));
        let document = json!({
            "name": name,
            "method": method,
            "url": url,
            "description": request.get("description").cloned().unwrap_or(Value::Null),
            "headers": request.get("header").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
            "body": request.get("body").cloned().unwrap_or(Value::Null),
            "auth": request.get("auth").cloned().unwrap_or(Value::Null),
            "scripts": item.get("event").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
            "responses": item.get("response").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
            "source": item,
        });

        requests.push(PostmanRequestDraft {
            folder_temp_id: parent_temp_id,
            name,
            method,
            url,
            document,
        });
    }
}

async fn insert_folder(
    pool: &SqlitePool,
    workspace_id: &str,
    collection_id: &str,
    parent_folder_id: Option<String>,
    name: String,
) -> Result<ApiFolder> {
    let now = now_unix_seconds();
    let folder = ApiFolder {
        id: Uuid::now_v7().to_string(),
        workspace_id: workspace_id.to_string(),
        collection_id: collection_id.to_string(),
        parent_folder_id,
        name,
        created_at: now,
        updated_at: now,
        version: 1,
    };

    query(
        r#"
        INSERT INTO folders (
            id, workspace_id, collection_id, parent_folder_id, name, created_at, updated_at, version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&folder.id)
    .bind(&folder.workspace_id)
    .bind(&folder.collection_id)
    .bind(&folder.parent_folder_id)
    .bind(&folder.name)
    .bind(folder.created_at)
    .bind(folder.updated_at)
    .bind(folder.version)
    .execute(pool)
    .await?;

    Ok(folder)
}

async fn insert_request(
    pool: &SqlitePool,
    workspace_id: &str,
    collection_id: &str,
    folder_id: Option<String>,
    name: String,
    method: String,
    url: String,
    document: Value,
) -> Result<ApiRequest> {
    let now = now_unix_seconds();
    let request = ApiRequest {
        id: Uuid::now_v7().to_string(),
        workspace_id: workspace_id.to_string(),
        collection_id: collection_id.to_string(),
        folder_id,
        name,
        method,
        url,
        document_json: serde_json::to_string(&document)?,
        created_at: now,
        updated_at: now,
        version: 1,
    };

    query(
        r#"
        INSERT INTO requests (
            id, workspace_id, collection_id, folder_id, name, method, url, document_json,
            created_at, updated_at, version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&request.id)
    .bind(&request.workspace_id)
    .bind(&request.collection_id)
    .bind(&request.folder_id)
    .bind(&request.name)
    .bind(&request.method)
    .bind(&request.url)
    .bind(&request.document_json)
    .bind(request.created_at)
    .bind(request.updated_at)
    .bind(request.version)
    .execute(pool)
    .await?;

    Ok(request)
}

fn postman_url_to_string(url: Option<&Value>) -> String {
    match url {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Object(map)) => {
            if let Some(raw) = map.get("raw").and_then(Value::as_str) {
                return raw.to_string();
            }

            let host = map
                .get("host")
                .and_then(Value::as_array)
                .map(|parts| join_postman_url_parts(parts, "."))
                .unwrap_or_default();
            let path = map
                .get("path")
                .and_then(Value::as_array)
                .map(|parts| join_postman_url_parts(parts, "/"))
                .unwrap_or_default();

            match (host.is_empty(), path.is_empty()) {
                (true, true) => String::new(),
                (false, true) => host,
                (true, false) => path,
                (false, false) => format!("{}/{}", host.trim_end_matches('/'), path),
            }
        }
        _ => String::new(),
    }
}

fn join_postman_url_parts(parts: &[Value], separator: &str) -> String {
    parts
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(separator)
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
struct WorkspaceSnapshot {
    workspace: Workspace,
    collections: Vec<Collection>,
    folders: Vec<ApiFolder>,
    requests: Vec<ApiRequest>,
    environments: Vec<Environment>,
    environment_variables: Vec<EnvironmentVariable>,
}

pub async fn init_workspace_versioning(
    pool: &SqlitePool,
    workspace_id: String,
) -> Result<WorkspaceVersioningStatus> {
    let workspace_id = Uuid::parse_str(&workspace_id)?.to_string();
    ensure_workspace_exists(pool, &workspace_id).await?;
    ensure_git_available()?;

    let repo_path = workspace_repo_path(&workspace_id)?;
    fs::create_dir_all(&repo_path)?;

    if !repo_path.join(".git").is_dir() {
        run_git(&repo_path, ["init"])?;
        run_git(
            &repo_path,
            ["config", "user.name", "Slinger Local Versioning"],
        )?;
        run_git(
            &repo_path,
            ["config", "user.email", "slinger@local.invalid"],
        )?;
    }

    export_workspace_to_repo(pool, &workspace_id, &repo_path).await?;
    get_workspace_versioning_status(pool, workspace_id).await
}

pub async fn get_workspace_versioning_status(
    pool: &SqlitePool,
    workspace_id: String,
) -> Result<WorkspaceVersioningStatus> {
    let workspace_id = Uuid::parse_str(&workspace_id)?.to_string();
    ensure_workspace_exists(pool, &workspace_id).await?;

    let repo_path = workspace_repo_path(&workspace_id)?;
    let initialized = repo_path.join(".git").is_dir();
    if !initialized {
        return Ok(WorkspaceVersioningStatus {
            initialized: false,
            repo_path: repo_path.to_string_lossy().to_string(),
            changed_files: Vec::new(),
        });
    }

    ensure_git_available()?;
    export_workspace_to_repo(pool, &workspace_id, &repo_path).await?;

    let output = run_git(&repo_path, ["status", "--short"])?;
    let changed_files = output
        .lines()
        .filter_map(parse_git_status_line)
        .collect::<Vec<_>>();

    Ok(WorkspaceVersioningStatus {
        initialized: true,
        repo_path: repo_path.to_string_lossy().to_string(),
        changed_files,
    })
}

pub async fn commit_workspace_versioning(
    pool: &SqlitePool,
    workspace_id: String,
    message: String,
) -> Result<WorkspaceVersioningCommit> {
    let workspace_id = Uuid::parse_str(&workspace_id)?.to_string();
    ensure_workspace_exists(pool, &workspace_id).await?;
    ensure_git_available()?;

    let trimmed = message.trim();
    if trimmed.is_empty() {
        bail!("commit message is required");
    }

    let repo_path = workspace_repo_path(&workspace_id)?;
    if !repo_path.join(".git").is_dir() {
        bail!("workspace versioning is not initialized");
    }

    export_workspace_to_repo(pool, &workspace_id, &repo_path).await?;
    run_git(&repo_path, ["add", "-A"])?;

    if run_git(&repo_path, ["status", "--short"])?
        .trim()
        .is_empty()
    {
        bail!("no local workspace changes to commit");
    }

    run_git(&repo_path, ["commit", "-m", trimmed])?;

    list_workspace_versioning_history(pool, workspace_id)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("commit succeeded but no history entry was returned"))
}

pub async fn list_workspace_versioning_history(
    pool: &SqlitePool,
    workspace_id: String,
) -> Result<Vec<WorkspaceVersioningCommit>> {
    let workspace_id = Uuid::parse_str(&workspace_id)?.to_string();
    ensure_workspace_exists(pool, &workspace_id).await?;

    let repo_path = workspace_repo_path(&workspace_id)?;
    if !repo_path.join(".git").is_dir() {
        return Ok(Vec::new());
    }

    ensure_git_available()?;
    export_workspace_to_repo(pool, &workspace_id, &repo_path).await?;
    if !repo_has_commits(&repo_path)? {
        return Ok(Vec::new());
    }

    let output = run_git(
        &repo_path,
        [
            "log",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s",
            "--max-count=50",
        ],
    )?;

    Ok(output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            let id = parts.next()?.to_string();
            let short_id = parts.next()?.to_string();
            let author = parts.next()?.to_string();
            let authored_at = parts.next()?.parse::<i64>().ok()?;
            let message = parts.next()?.to_string();

            Some(WorkspaceVersioningCommit {
                id,
                short_id,
                message,
                author,
                authored_at,
            })
        })
        .collect())
}

pub async fn restore_workspace_versioning_commit(
    pool: &SqlitePool,
    workspace_id: String,
    commit_id: String,
) -> Result<WorkspaceVersioningRestoreResult> {
    let workspace_id = Uuid::parse_str(&workspace_id)?.to_string();
    ensure_workspace_exists(pool, &workspace_id).await?;
    ensure_git_available()?;

    let commit_id = commit_id.trim().to_string();
    if commit_id.is_empty() {
        bail!("commit id is required");
    }

    let repo_path = workspace_repo_path(&workspace_id)?;
    if !repo_path.join(".git").is_dir() {
        bail!("workspace versioning is not initialized");
    }

    let snapshot_spec = format!("{commit_id}:snapshot.json");
    let snapshot_json = run_git(&repo_path, ["show", &snapshot_spec])?;
    let snapshot: WorkspaceSnapshot =
        serde_json::from_str(&snapshot_json).context("failed to parse workspace snapshot")?;

    if snapshot.workspace.id != workspace_id {
        bail!("selected commit does not belong to this workspace");
    }

    let restored_files = 2
        + snapshot.collections.len()
        + snapshot.folders.len()
        + snapshot.requests.len()
        + snapshot.environments.len()
        + snapshot.environment_variables.len();

    apply_workspace_snapshot(pool, snapshot).await?;
    export_workspace_to_repo(pool, &workspace_id, &repo_path).await?;

    Ok(WorkspaceVersioningRestoreResult {
        commit_id,
        restored_files,
    })
}

async fn ensure_workspace_exists(pool: &SqlitePool, workspace_id: &str) -> Result<()> {
    let exists: Option<(String,)> = query_as("SELECT id FROM workspaces WHERE id = ?")
        .bind(workspace_id)
        .fetch_optional(pool)
        .await?;

    if exists.is_none() {
        bail!("workspace not found");
    }

    Ok(())
}

fn ensure_git_available() -> Result<()> {
    let status = Command::new("git")
        .arg("--version")
        .status()
        .context("failed to launch git")?;

    if !status.success() {
        bail!("git is not available on this machine");
    }

    Ok(())
}

fn repo_has_commits(repo_path: &Path) -> Result<bool> {
    let status = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--verify", "HEAD"])
        .status()
        .context("failed to inspect git history")?;

    Ok(status.success())
}

fn workspace_repo_path(workspace_id: &str) -> Result<PathBuf> {
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);

    Ok(base
        .join(".slinger-versioning")
        .join("workspaces")
        .join(workspace_id))
}

fn run_git<const N: usize>(repo_path: &Path, args: [&str; N]) -> Result<String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(args)
        .output()
        .with_context(|| format!("failed to run git {}", args.join(" ")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if !stderr.is_empty() { stderr } else { stdout };
        bail!(
            "git {} failed{}",
            args.join(" "),
            if message.is_empty() {
                String::new()
            } else {
                format!(": {message}")
            }
        );
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_git_status_line(line: &str) -> Option<WorkspaceVersioningFileChange> {
    let trimmed = line.trim_end();
    if trimmed.len() < 4 {
        return None;
    }

    let status = trimmed.get(0..2)?.trim().to_string();
    let path = trimmed.get(3..)?.trim().to_string();

    if path.is_empty() {
        return None;
    }

    Some(WorkspaceVersioningFileChange { path, status })
}

async fn export_workspace_to_repo(
    pool: &SqlitePool,
    workspace_id: &str,
    repo_path: &Path,
) -> Result<()> {
    fs::create_dir_all(repo_path)?;
    clear_directory_except_git(repo_path)?;

    let snapshot = load_workspace_snapshot(pool, workspace_id).await?;
    write_json_file(&repo_path.join("snapshot.json"), &snapshot)?;
    write_json_file(&repo_path.join("workspace.json"), &snapshot.workspace)?;

    write_entity_group(repo_path, "collections", &snapshot.collections, |item| {
        item.id.as_str()
    })?;
    write_entity_group(repo_path, "folders", &snapshot.folders, |item| {
        item.id.as_str()
    })?;
    write_entity_group(repo_path, "requests", &snapshot.requests, |item| {
        item.id.as_str()
    })?;
    write_entity_group(repo_path, "environments", &snapshot.environments, |item| {
        item.id.as_str()
    })?;
    write_entity_group(
        repo_path,
        "environment-variables",
        &snapshot.environment_variables,
        |item| item.id.as_str(),
    )?;

    Ok(())
}

fn clear_directory_except_git(root: &Path) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_name() == OsStr::new(".git") {
            continue;
        }

        if path.is_dir() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
    }

    Ok(())
}

fn write_entity_group<T, F>(repo_path: &Path, folder_name: &str, items: &[T], id: F) -> Result<()>
where
    T: serde::Serialize,
    F: Fn(&T) -> &str,
{
    let directory = repo_path.join(folder_name);
    fs::create_dir_all(&directory)?;

    for item in items {
        write_json_file(&directory.join(format!("{}.json", id(item))), item)?;
    }

    Ok(())
}

fn write_json_file<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut json = serde_json::to_string_pretty(value)?;
    json.push('\n');
    fs::write(path, json)?;
    Ok(())
}

async fn load_workspace_snapshot(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<WorkspaceSnapshot> {
    let workspace = query_as::<_, Workspace>(
        r#"
        SELECT id, name, created_at, updated_at, version
        FROM workspaces
        WHERE id = ?
        "#,
    )
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow!("workspace not found"))?;

    let collections = query_as::<_, Collection>(
        r#"
        SELECT id, workspace_id, name, created_at, updated_at, version
        FROM collections
        WHERE workspace_id = ?
        ORDER BY created_at, id
        "#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;

    let folders = query_as::<_, ApiFolder>(
        r#"
        SELECT id, workspace_id, collection_id, parent_folder_id, name, created_at, updated_at, version
        FROM folders
        WHERE workspace_id = ?
        ORDER BY created_at, id
        "#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;

    let requests = query_as::<_, ApiRequest>(
        r#"
        SELECT id, workspace_id, collection_id, folder_id, name, method, url, document_json, created_at, updated_at, version
        FROM requests
        WHERE workspace_id = ?
        ORDER BY created_at, id
        "#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;

    let environments = query_as::<_, Environment>(
        r#"
        SELECT id, workspace_id, name, created_at, updated_at, version
        FROM environments
        WHERE workspace_id = ?
        ORDER BY created_at, id
        "#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;

    let environment_variables = query_as::<_, EnvironmentVariable>(
        r#"
        SELECT environment_variables.id, environment_variables.environment_id, environment_variables.key, environment_variables.value,
               environment_variables.is_secret, environment_variables.masked_value,
               environment_variables.created_at, environment_variables.updated_at, environment_variables.version
        FROM environment_variables
        INNER JOIN environments ON environments.id = environment_variables.environment_id
        WHERE environments.workspace_id = ?
        ORDER BY environment_variables.environment_id, environment_variables.key COLLATE NOCASE, environment_variables.id
        "#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await?;

    Ok(WorkspaceSnapshot {
        workspace,
        collections,
        folders,
        requests,
        environments,
        environment_variables,
    })
}

async fn apply_workspace_snapshot(pool: &SqlitePool, snapshot: WorkspaceSnapshot) -> Result<()> {
    let mut tx = pool.begin().await?;

    query("DELETE FROM environment_variables WHERE environment_id IN (SELECT id FROM environments WHERE workspace_id = ?)")
        .bind(&snapshot.workspace.id)
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM requests WHERE workspace_id = ?")
        .bind(&snapshot.workspace.id)
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM folders WHERE workspace_id = ?")
        .bind(&snapshot.workspace.id)
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM collections WHERE workspace_id = ?")
        .bind(&snapshot.workspace.id)
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM environments WHERE workspace_id = ?")
        .bind(&snapshot.workspace.id)
        .execute(&mut *tx)
        .await?;

    let updated = query(
        r#"
        UPDATE workspaces
        SET name = ?, created_at = ?, updated_at = ?, version = ?
        WHERE id = ?
        "#,
    )
    .bind(&snapshot.workspace.name)
    .bind(snapshot.workspace.created_at)
    .bind(snapshot.workspace.updated_at)
    .bind(snapshot.workspace.version)
    .bind(&snapshot.workspace.id)
    .execute(&mut *tx)
    .await?;

    if updated.rows_affected() == 0 {
        bail!("workspace not found");
    }

    for item in snapshot.collections {
        query(
            r#"
            INSERT INTO collections (id, workspace_id, name, created_at, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&item.id)
        .bind(&item.workspace_id)
        .bind(&item.name)
        .bind(item.created_at)
        .bind(item.updated_at)
        .bind(item.version)
        .execute(&mut *tx)
        .await?;
    }

    for item in snapshot.folders {
        query(
            r#"
            INSERT INTO folders (id, workspace_id, collection_id, parent_folder_id, name, created_at, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&item.id)
        .bind(&item.workspace_id)
        .bind(&item.collection_id)
        .bind(&item.parent_folder_id)
        .bind(&item.name)
        .bind(item.created_at)
        .bind(item.updated_at)
        .bind(item.version)
        .execute(&mut *tx)
        .await?;
    }

    for item in snapshot.requests {
        query(
            r#"
            INSERT INTO requests (id, workspace_id, collection_id, folder_id, name, method, url, document_json, created_at, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&item.id)
        .bind(&item.workspace_id)
        .bind(&item.collection_id)
        .bind(&item.folder_id)
        .bind(&item.name)
        .bind(&item.method)
        .bind(&item.url)
        .bind(&item.document_json)
        .bind(item.created_at)
        .bind(item.updated_at)
        .bind(item.version)
        .execute(&mut *tx)
        .await?;
    }

    for item in snapshot.environments {
        query(
            r#"
            INSERT INTO environments (id, workspace_id, name, created_at, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&item.id)
        .bind(&item.workspace_id)
        .bind(&item.name)
        .bind(item.created_at)
        .bind(item.updated_at)
        .bind(item.version)
        .execute(&mut *tx)
        .await?;
    }

    for item in snapshot.environment_variables {
        query(
            r#"
            INSERT INTO environment_variables (id, environment_id, key, value, is_secret, masked_value, created_at, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&item.id)
        .bind(&item.environment_id)
        .bind(&item.key)
        .bind(&item.value)
        .bind(item.is_secret)
        .bind(&item.masked_value)
        .bind(item.created_at)
        .bind(item.updated_at)
        .bind(item.version)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn imports_sample_postman_collection() -> Result<()> {
        let database_path =
            std::env::temp_dir().join(format!("slinger-import-{}.db", Uuid::now_v7()));
        let database_path = database_path.to_string_lossy().into_owned();
        let pool = init_database(&database_path).await?;
        let workspace = create_workspace(&pool, "Import Test".to_string()).await?;
        let sample_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../example-postman-collection.json");
        let payload = std::fs::read_to_string(sample_path)?;

        let imported = import_postman_collection(&pool, workspace.id.to_string(), payload).await?;
        let stored_requests = list_requests(&pool, imported.collection.id.to_string()).await?;

        assert_eq!(imported.collection.name, "thub-collection");
        assert_eq!(imported.folders.len(), 0);
        assert_eq!(imported.requests.len(), 8);
        assert_eq!(stored_requests.len(), 8);
        assert_eq!(stored_requests[0].method, "POST");
        assert_eq!(stored_requests[0].name, "Create Charge Detail");

        pool.close().await;
        let _ = tokio::fs::remove_file(database_path).await;

        Ok(())
    }

    #[tokio::test]
    async fn imports_nested_postman_folders() -> Result<()> {
        let database_path =
            std::env::temp_dir().join(format!("slinger-folders-{}.db", Uuid::now_v7()));
        let database_path = database_path.to_string_lossy().into_owned();
        let pool = init_database(&database_path).await?;
        let workspace = create_workspace(&pool, "Folder Test".to_string()).await?;
        let payload = serde_json::json!({
            "info": { "name": "nested" },
            "item": [
                {
                    "name": "Admin",
                    "item": [
                        {
                            "name": "Users",
                            "item": [
                                {
                                    "name": "List Users",
                                    "request": {
                                        "method": "GET",
                                        "url": { "raw": "https://example.com/users" }
                                    }
                                }
                            ]
                        }
                    ]
                }
            ]
        })
        .to_string();

        let imported = import_postman_collection(&pool, workspace.id.to_string(), payload).await?;
        let stored_folders = list_folders(&pool, imported.collection.id.to_string()).await?;
        let stored_requests = list_requests(&pool, imported.collection.id.to_string()).await?;

        assert_eq!(stored_folders.len(), 2);
        assert_eq!(stored_requests.len(), 1);
        assert_eq!(stored_folders[0].name, "Admin");
        assert_eq!(stored_folders[1].name, "Users");
        assert_eq!(
            stored_folders[1].parent_folder_id,
            Some(stored_folders[0].id.clone())
        );
        assert_eq!(
            stored_requests[0].folder_id,
            Some(stored_folders[1].id.clone())
        );

        pool.close().await;
        let _ = tokio::fs::remove_file(database_path).await;

        Ok(())
    }

    #[tokio::test]
    async fn creates_request_in_collection() -> Result<()> {
        let database_path =
            std::env::temp_dir().join(format!("slinger-request-{}.db", Uuid::now_v7()));
        let database_path = database_path.to_string_lossy().into_owned();
        let pool = init_database(&database_path).await?;
        let workspace = create_workspace(&pool, "Request Test".to_string()).await?;
        let collection = create_collection(
            &pool,
            workspace.id.to_string(),
            "Saved Requests".to_string(),
        )
        .await?;
        let document = json!({
            "name": "Ping",
            "method": "POST",
            "url": "https://example.test/ping",
            "headers": [],
            "body": { "mode": "raw", "raw": "{\"ok\":true}" },
            "auth": null,
            "scripts": [],
            "responses": []
        });

        let request = create_request(
            &pool,
            CreateRequestInput {
                workspace_id: workspace.id.to_string(),
                collection_id: collection.id.to_string(),
                name: "Ping".to_string(),
                method: "post".to_string(),
                url: "https://example.test/ping".to_string(),
                document_json: document.to_string(),
            },
        )
        .await?;
        let stored_requests = list_requests(&pool, collection.id.to_string()).await?;

        assert_eq!(request.name, "Ping");
        assert_eq!(request.method, "POST");
        assert_eq!(request.collection_id, collection.id);
        assert_eq!(stored_requests.len(), 1);
        assert_eq!(stored_requests[0].id, request.id);

        pool.close().await;
        let _ = tokio::fs::remove_file(database_path).await;

        Ok(())
    }

    #[tokio::test]
    async fn stores_environment_variables() -> Result<()> {
        let database_path = std::env::temp_dir().join(format!("slinger-env-{}.db", Uuid::now_v7()));
        let database_path = database_path.to_string_lossy().into_owned();
        let pool = init_database(&database_path).await?;
        let workspace = create_workspace(&pool, "Env Test".to_string()).await?;
        let environment = ensure_default_environment(&pool, workspace.id.to_string()).await?;

        let first = upsert_environment_variable(
            &pool,
            environment.id.to_string(),
            "thub_url".to_string(),
            "https://example.test".to_string(),
        )
        .await?;
        let updated = upsert_environment_variable(
            &pool,
            environment.id.to_string(),
            "thub_url".to_string(),
            "https://api.example.test".to_string(),
        )
        .await?;
        let variables = list_environment_variables(&pool, environment.id.to_string()).await?;

        assert_eq!(first.id, updated.id);
        assert_eq!(variables.len(), 1);
        assert_eq!(variables[0].key, "thub_url");
        assert_eq!(variables[0].value, "https://api.example.test");

        pool.close().await;
        let _ = tokio::fs::remove_file(database_path).await;

        Ok(())
    }
}
