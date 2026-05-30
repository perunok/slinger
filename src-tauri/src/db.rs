use anyhow::Result;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use uuid::Uuid;

use crate::domain::Workspace;

fn now_unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub async fn init_database(path: &str) -> Result<SqlitePool> {
    let database_url = format!("sqlite://{}", path);
    let pool = SqlitePoolOptions::new().max_connections(5).connect(&database_url).await?;

    sqlx::query(
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

    sqlx::query(
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

pub async fn create_workspace(pool: &SqlitePool, name: String) -> Result<Workspace> {
    let workspace = Workspace {
        id: Uuid::now_v7(),
        name,
        created_at: now_unix_seconds(),
    };

    sqlx::query(
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
