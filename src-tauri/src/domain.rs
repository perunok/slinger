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
pub struct ApiFolder {
    pub id: String,
    pub workspace_id: String,
    pub collection_id: String,
    pub parent_folder_id: Option<String>,
    pub name: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct ApiRequest {
    pub id: String,
    pub workspace_id: String,
    pub collection_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub method: String,
    pub url: String,
    pub document_json: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PostmanImportResult {
    pub collection: Collection,
    pub folders: Vec<ApiFolder>,
    pub requests: Vec<ApiRequest>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RequestHeader {
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HttpRequestInput {
    pub method: String,
    pub url: String,
    pub headers: Vec<RequestHeader>,
    pub body: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HttpResponseData {
    pub status: u16,
    pub status_text: String,
    pub duration_ms: u128,
    pub headers: Vec<RequestHeader>,
    pub body: String,
}
