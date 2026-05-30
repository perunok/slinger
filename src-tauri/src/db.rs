use anyhow::{bail, Result};
use serde_json::{json, Value};
use sqlx::{
    query, query_as,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use uuid::Uuid;

use crate::domain::{ApiRequest, Collection, PostmanImportResult, Workspace};

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
            created_at INTEGER NOT NULL
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
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
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
            name TEXT NOT NULL,
            method TEXT NOT NULL,
            url TEXT NOT NULL,
            document_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
            FOREIGN KEY(collection_id) REFERENCES collections(id)
        );
        "#,
    )
    .execute(&pool)
    .await?;

    Ok(pool)
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
        SELECT id, name, created_at
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

    let workspace = Workspace {
        id: Uuid::now_v7().to_string(),
        name,
        created_at: now_unix_seconds(),
    };

    query(
        r#"
        INSERT INTO workspaces (id, name, created_at)
        VALUES (?, ?, ?)
        "#,
    )
    .bind(&workspace.id)
    .bind(&workspace.name)
    .bind(workspace.created_at)
    .execute(pool)
    .await?;

    Ok(workspace)
}

pub async fn list_collections(pool: &SqlitePool, workspace_id: String) -> Result<Vec<Collection>> {
    Ok(query_as::<_, Collection>(
        r#"
        SELECT id, workspace_id, name, created_at
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

    let collection = Collection {
        id: Uuid::now_v7().to_string(),
        workspace_id,
        name,
        created_at: now_unix_seconds(),
    };

    query(
        r#"
        INSERT INTO collections (id, workspace_id, name, created_at)
        VALUES (?, ?, ?, ?)
        "#,
    )
    .bind(&collection.id)
    .bind(&collection.workspace_id)
    .bind(&collection.name)
    .bind(collection.created_at)
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

    query("UPDATE collections SET name = ? WHERE id = ?")
        .bind(&name)
        .bind(&collection_id)
        .execute(pool)
        .await?;

    let collection = query_as::<_, Collection>(
        r#"
        SELECT id, workspace_id, name, created_at
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

    query("DELETE FROM collections WHERE id = ?")
        .bind(collection_id)
        .execute(pool)
        .await?;

    Ok(())
}

pub async fn list_requests(pool: &SqlitePool, collection_id: String) -> Result<Vec<ApiRequest>> {
    Ok(query_as::<_, ApiRequest>(
        r#"
        SELECT id, workspace_id, collection_id, name, method, url, document_json, created_at
        FROM requests
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

    let mut drafts = Vec::new();
    collect_postman_requests(items, &mut drafts);

    if drafts.is_empty() {
        bail!("no requests found in Postman collection");
    }

    let collection = create_collection(pool, workspace_id.to_string(), collection_name).await?;
    let mut requests = Vec::new();

    for draft in drafts {
        let request = ApiRequest {
            id: Uuid::now_v7().to_string(),
            workspace_id: workspace_id.clone(),
            collection_id: collection.id.clone(),
            name: draft.name,
            method: draft.method,
            url: draft.url,
            document_json: serde_json::to_string(&draft.document)?,
            created_at: now_unix_seconds(),
        };

        query(
            r#"
            INSERT INTO requests (
                id, workspace_id, collection_id, name, method, url, document_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&request.id)
        .bind(&request.workspace_id)
        .bind(&request.collection_id)
        .bind(&request.name)
        .bind(&request.method)
        .bind(&request.url)
        .bind(&request.document_json)
        .bind(request.created_at)
        .execute(pool)
        .await?;

        requests.push(request);
    }

    Ok(PostmanImportResult {
        collection,
        requests,
    })
}

struct PostmanRequestDraft {
    name: String,
    method: String,
    url: String,
    document: Value,
}

fn collect_postman_requests(items: &[Value], requests: &mut Vec<PostmanRequestDraft>) {
    for item in items {
        if let Some(children) = item.get("item").and_then(Value::as_array) {
            collect_postman_requests(children, requests);
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
            "responses": item.get("response").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
            "source": item,
        });

        requests.push(PostmanRequestDraft {
            name,
            method,
            url,
            document,
        });
    }
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
        assert_eq!(imported.requests.len(), 8);
        assert_eq!(stored_requests.len(), 8);
        assert_eq!(stored_requests[0].method, "POST");
        assert_eq!(stored_requests[0].name, "Create Charge Detail");

        pool.close().await;
        let _ = tokio::fs::remove_file(database_path).await;

        Ok(())
    }
}
