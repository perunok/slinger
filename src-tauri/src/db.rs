use anyhow::{bail, Result};
use serde_json::{json, Value};
use sqlx::{
    query, query_as,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use std::collections::HashMap;
use uuid::Uuid;

use crate::domain::{
    ApiFolder, ApiRequest, ApplyCloudWorkspaceInput, CloudSyncOperationInput, Collection,
    CreateRequestInput, Environment, EnvironmentVariable, PostmanImportResult, UpdateRequestInput,
    Workspace,
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
        "workspace" => Ok(()),
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
