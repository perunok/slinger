use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CloudSyncOperationInput {
    pub operation_id: String,
    pub workspace_id: Option<String>,
    pub resource_type: String,
    pub resource_id: String,
    pub op: String,
    pub base_version: Option<i64>,
    pub resulting_version: Option<i64>,
    pub payload: serde_json::Value,
    pub occurred_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApplyCloudWorkspaceInput {
    pub local_workspace_id: String,
    pub operations: Vec<CloudSyncOperationInput>,
}

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub version: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct Collection {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub version: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct ApiFolder {
    pub id: String,
    pub workspace_id: String,
    pub collection_id: String,
    pub parent_folder_id: Option<String>,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub version: i64,
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
    pub updated_at: i64,
    pub version: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct Environment {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub version: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, FromRow)]
pub struct EnvironmentVariable {
    pub id: String,
    pub environment_id: String,
    pub key: String,
    pub value: String,
    pub is_secret: bool,
    pub masked_value: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub version: i64,
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

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequestInput {
    pub request_id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub document_json: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequestInput {
    pub workspace_id: String,
    pub collection_id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub document_json: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WorkspaceVersioningStatus {
    pub initialized: bool,
    pub repo_path: String,
    pub changed_files: Vec<WorkspaceVersioningFileChange>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WorkspaceVersioningFileChange {
    pub path: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WorkspaceVersioningCommit {
    pub id: String,
    pub short_id: String,
    pub message: String,
    pub author: String,
    pub authored_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WorkspaceVersioningRestoreResult {
    pub commit_id: String,
    pub restored_files: usize,
}
