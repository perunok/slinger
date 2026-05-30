use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct Collection {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct ApiRequest {
    pub id: String,
    pub workspace_id: String,
    pub collection_id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub document_json: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PostmanImportResult {
    pub collection: Collection,
    pub requests: Vec<ApiRequest>,
}
