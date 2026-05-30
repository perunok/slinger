# Slinger

> A modern, local-first API development and collaboration platform built with Rust, Tauri, React, and Go.

---

# Vision

Slinger is a cross-platform API development platform designed for individual developers, teams, and organizations.

The platform provides:

- API testing
- Request collections
- Environment management
- Offline operation
- Team collaboration
- Self-hosted synchronization
- Enterprise deployment capabilities
- Import from Postman

The system is designed from day one to support both:

- Single-user local workflows
- Multi-user collaborative workflows

without requiring major architectural changes.

---

# Getting Started

```bash
npm install
npm run dev
```

In another shell, if you want to build the Rust Tauri backend:

```bash
cd src-tauri
cargo build
```

---

# Core Principles

## Local First

The local database is the primary source of truth.

Users should never lose functionality because a remote server is unavailable.

---

## Offline First

All core functionality must work without internet access.

Synchronization is optional.

---

## Workspace First

Every resource belongs to a workspace.

No exceptions.

A default workspace is automatically created:

```text
Personal
```

---

## Collaboration Ready

Every entity is designed for future synchronization.

The MVP must not assume a single-user environment.

---

## Self Hosted Friendly

Organizations must be able to deploy:

```text
Desktop App
+
Go Backend
+
PostgreSQL
```

inside their own infrastructure.

---

## Extensible

The architecture must support future:

- Plugins
- New protocols
- Team collaboration
- Enterprise features

without major rewrites.

---

# Supported Platforms

Primary Target:

- Linux (Wayland First)

Secondary Targets:

- Windows
- macOS

---

# Final Technology Decisions

## Desktop

### Framework

- Tauri v2

### Backend Language

- Rust

### Frontend

- React
- TypeScript
- Vite

### Styling

- TailwindCSS

### Component Library

- shadcn/ui

### State Management

- Zustand

### Async State

- TanStack Query

### Database

- SQLite

### Database Access

- sqlx

### HTTP

- reqwest
- tokio

### Serialization

- serde
- serde_json

### Logging

- tracing
- tracing-subscriber

### Error Handling

- anyhow
- thiserror

### Secret Management

- keyring

### IDs

- UUIDv7

---

# Future Backend

## Language

- Go

## Framework

- Fiber

## Database

- PostgreSQL

## Authentication

- JWT

Future:

- OAuth2
- LDAP
- SAML

---

# UUID Strategy

Every entity uses UUIDv7.

Reason:

- Offline generation
- Sync friendly
- Time sortable
- Better database locality

Rust:

```toml
uuid = { version = "1", features = ["v7", "serde"] }
```

Example:

```rust
let id = Uuid::now_v7();
```

---

# Secret Storage Strategy

Never store secrets directly in SQLite.

Store secrets using OS-native secure storage.

Linux:

- Secret Service
- GNOME Keyring
- KWallet

Windows:

- Credential Manager

macOS:

- Keychain

Rust:

```toml
keyring = "3"
```

SQLite stores references only.

---

# High-Level Architecture

```text
┌──────────────────────────────────────────────┐
│                Desktop Client                │
├──────────────────────────────────────────────┤
│ React                                        │
│ TypeScript                                   │
│ TailwindCSS                                  │
│ shadcn/ui                                    │
├──────────────────────────────────────────────┤
│ Tauri                                        │
├──────────────────────────────────────────────┤
│ Application Layer                            │
├──────────────────────────────────────────────┤
│ Services                                     │
├──────────────────────────────────────────────┤
│ Domain Models                               │
├──────────────────────────────────────────────┤
│ Repositories                                │
├──────────────────────────────────────────────┤
│ SQLite                                       │
└───────────────────┬──────────────────────────┘
                    │
                    │ Future
                    ▼
┌──────────────────────────────────────────────┐
│                Go Backend                    │
├──────────────────────────────────────────────┤
│ Authentication                               │
│ Users                                        │
│ Workspaces                                   │
│ Collections                                  │
│ Environments                                 │
│ Permissions                                  │
│ Sync Engine                                  │
│ Audit Logs                                   │
└───────────────────┬──────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────┐
│ PostgreSQL                                   │
└──────────────────────────────────────────────┘
```

---

# Architectural Layers

```text
UI
 ↓
Tauri Commands
 ↓
Application Services
 ↓
Domain Models
 ↓
Repositories
 ↓
Database
```

The UI must never directly manipulate persistence.

Business logic belongs in services.

---

# Product Roadmap

## Phase 1 — Local MVP

Features:

- Workspaces
- Collections
- Folders
- Requests
- Environments
- History
- Tabs
- Persistence

No backend.

---

## Phase 2 — Sync Foundation

Features:

- Versioning
- Sync metadata
- Change tracking
- Sync queue

Still offline.

---

## Phase 3 — Cloud Backend

Features:

- Registration
- Login
- Workspace synchronization
- Collection synchronization
- Environment synchronization

---

## Phase 4 — Collaboration

Features:

- Team workspaces
- Invitations
- Shared collections
- Shared environments
- Roles

---

## Phase 5 — Enterprise

Features:

- LDAP
- SAML
- Audit logs
- API tokens
- Backup and restore

---

# Workspace Model

Every resource belongs to a workspace.

```text
Workspace
│
├── Collections
├── Environments
├── History
├── Members
├── Audit Logs
└── Settings
```

---

# Workspace Types

```text
Personal
Team
```

Database:

```sql
workspace_type TEXT NOT NULL
```

Personal workspace is automatically created during first launch.

---

# Roles

## Owner

Can:

- Delete workspace
- Manage members
- Manage roles

---

## Admin

Can:

- Invite users
- Manage collections
- Manage environments

---

## Editor

Can:

- Create and modify content

---

## Viewer

Can:

- View collections
- Execute requests

---

# MVP Features

## Collections

Support:

- Create
- Update
- Delete
- Search

---

## Folders

Support:

- Nested folders
- Drag and drop

---

## Request Methods

- GET
- POST
- PUT
- PATCH
- DELETE
- HEAD
- OPTIONS

---

## Authentication

Support:

- None
- Basic Auth
- Bearer Token
- API Key

Future:

- OAuth2

---

## Body Types

- JSON
- Text
- Multipart
- Form URL Encoded

---

## Response Viewer

- Raw
- JSON
- XML
- Headers
- Status
- Timing

---

## Variables

```text
{{base_url}}
{{token}}
{{username}}
```

Resolved before execution.

---

## History

Store:

- URL
- Method
- Duration
- Timestamp
- Status

---

# Protocol Roadmap

## MVP

- HTTP
- HTTPS

## Future

- GraphQL
- gRPC
- WebSocket
- SSE
- Kafka
- MQTT
- SOAP

The architecture must remain protocol extensible.

---

# Plugin Roadmap

Not part of MVP.

Potential plugins:

```text
GraphQL
gRPC
Kafka
MQTT
SOAP
WebSocket
```

Plugins must integrate with the domain layer.

---

# Request Storage Strategy

Request definitions are stored as structured JSON documents.

Example:

```json
{
  "id": "uuid",
  "name": "Get Users",
  "method": "GET",
  "url": "https://api.example.com/users",
  "headers": [],
  "params": [],
  "auth": {},
  "body": {}
}
```

Benefits:

- Easier synchronization
- Easier import/export
- Easier versioning
- Fewer schema migrations

---

# Database Design

Every synchronized entity contains:

```sql
id TEXT PRIMARY KEY,
version INTEGER DEFAULT 1,
deleted BOOLEAN DEFAULT FALSE,
created_at DATETIME,
updated_at DATETIME
```

All IDs are UUIDv7.

---

## workspaces

```sql
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workspace_type TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    deleted BOOLEAN DEFAULT FALSE,
    created_at DATETIME,
    updated_at DATETIME
);
```

---

## collections

```sql
CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    deleted BOOLEAN DEFAULT FALSE,
    created_at DATETIME,
    updated_at DATETIME
);
```

---

## folders

```sql
CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL,
    parent_folder_id TEXT,
    name TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    deleted BOOLEAN DEFAULT FALSE,
    created_at DATETIME,
    updated_at DATETIME
);
```

---

## requests

```sql
CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    collection_id TEXT,
    folder_id TEXT,
    name TEXT NOT NULL,
    document_json TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    deleted BOOLEAN DEFAULT FALSE,
    created_at DATETIME,
    updated_at DATETIME
);
```

---

## environments

```sql
CREATE TABLE environments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    deleted BOOLEAN DEFAULT FALSE,
    created_at DATETIME,
    updated_at DATETIME
);
```

---

## environment_variables

```sql
CREATE TABLE environment_variables (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL
);
```

---

## history

```sql
CREATE TABLE history (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    request_id TEXT,
    method TEXT,
    url TEXT,
    status_code INTEGER,
    duration_ms INTEGER,
    created_at DATETIME
);
```

---

## sync_queue

```sql
CREATE TABLE sync_queue (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    created_at DATETIME
);
```

---

# Sync Architecture

Local database remains source of truth.

Workflow:

```text
Local Change
      ↓
Sync Queue
      ↓
Push To Server
      ↓
Receive Remote Changes
      ↓
Merge
```

---

# Sync Event Format

Future API contract:

```json
{
  "entityType": "collection",
  "entityId": "uuid",
  "version": 4,
  "operation": "update",
  "payload": {}
}
```

This contract should remain stable.

---

# Import / Export Roadmap

Future support:

- OpenAPI Import
- OpenAPI Export
- Collection Import
- Collection Export

---

# Project Export Format

Future support:

```text
workspace/
├── collections/
├── environments/
└── slinger.json
```

This allows:

- Git integration
- Backup
- Sharing
- Review workflows

---

# Database Migrations

Directory:

```text
src-tauri/migrations/
```

Example:

```text
0001_create_workspaces.sql
0002_create_collections.sql
0003_create_requests.sql
```

Never generate schema in code.

Always use migration files.

---

# Frontend Structure

```text
src/

app/
components/
hooks/
lib/
services/

features/
├── workspaces/
├── collections/
├── requests/
├── environments/
├── history/
├── settings/
└── sync/
```

Feature-first architecture is mandatory.

---

# Rust Structure

```text
src-tauri/src/

commands/
├── workspaces.rs
├── collections.rs
├── requests.rs
├── environments.rs
├── history.rs
└── sync.rs

services/
├── workspace_service.rs
├── collection_service.rs
├── request_service.rs
├── environment_service.rs

repositories/
├── workspace_repository.rs
├── collection_repository.rs
├── request_repository.rs
├── environment_repository.rs

models/
├── workspace.rs
├── collection.rs
├── request.rs
├── environment.rs

http/
├── client.rs
└── executor.rs

sync/
├── queue.rs
├── versioning.rs
└── protocol.rs

utils/
├── ids.rs
├── secrets.rs
└── resolver.rs
```

---

# Testing Strategy

## Rust

- cargo test
- cargo-nextest

## Frontend

- Vitest
- React Testing Library
- Playwright

## Future Backend

- Go testing
- Testify

---

# Frontend Layout

```text
┌────────────────────────────────────────────────────┐
│ Top Navigation                                     │
├────────────────────────────────────────────────────┤
│ Workspace Selector                                │
├───────────────┬────────────────────────────────────┤
│ Collections   │ Request Tabs                       │
│ Tree          ├────────────────────────────────────┤
│               │ URL + Method + Send                │
│               ├────────────────────────────────────┤
│               │ Params                             │
│               │ Headers                            │
│               │ Auth                               │
│               │ Body                               │
│               ├────────────────────────────────────┤
│               │ Response                           │
│               └────────────────────────────────────┘
└───────────────┴────────────────────────────────────┘
```

---

# Performance Targets

Startup:

```text
< 2 seconds
```

Memory:

```text
< 300 MB
```

Request Execution:

```text
Non-blocking
```

---

# Security Requirements

- Never store plaintext secrets in SQLite
- Use OS credential storage
- Never log credentials
- Validate all user input
- HTTPS required for synchronization
- Encrypt sensitive local references when appropriate

---

# Definition of MVP Done

A user can:

- Create workspaces
- Create collections
- Create folders
- Create requests
- Execute requests
- Manage environments
- Use variables
- View responses
- View history
- Restart the application and retain all data

without requiring:

- Internet
- Authentication
- Cloud backend

while remaining fully compatible with future:

- Synchronization
- Collaboration
- Team workspaces
- Self-hosted deployments
- Enterprise features
- Plugin support
- Additional protocols
