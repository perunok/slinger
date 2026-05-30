use anyhow::Result;
use sqlx::{query, query_as, sqlite::{SqliteConnectOptions, SqlitePoolOptions}, SqlitePool};
use uuid::Uuid;

use crate::domain::Workspace;

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
        ORDER BY created_at
        "#,
    )
    .fetch_all(pool)
    .await?)
}

pub async fn create_workspace(pool: &SqlitePool, name: String) -> Result<Workspace> {
    let workspace = Workspace {
        id: Uuid::now_v7(),
        name,
        created_at: now_unix_seconds(),
    };

    query(
        r#"
        INSERT INTO workspaces (id, name, created_at)
        VALUES (?, ?, ?)
        "#,
    )
    .bind(workspace.id.to_string())
    .bind(&workspace.name)
    .bind(workspace.created_at)
    .execute(pool)
    .await?;

    Ok(workspace)
}
