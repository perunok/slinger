use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct Workspace {
    pub id: Uuid,
    pub name: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct Collection {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub created_at: i64,
}
