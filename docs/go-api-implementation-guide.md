# Cloud API documentation moved

The old Go API implementation guide that lived here described a backend that no longer exists and has been removed.
The Slinger Cloud backend is a TypeScript service in the separate `slinger-admin` repository:

- Overview and architecture: `slinger-admin/README.md`
- API server (Node.js / Fastify / Prisma / PostgreSQL): `slinger-admin/server/README.md`
- Machine-readable API: `slinger-admin/server/openapi.yaml`
- Contract used by the desktop app: `slinger-admin/docs/api-contract-v2.md`

The desktop app's cloud client is `src/features/cloud/` (paths in `endpoints.ts`); see the Cloud section of the
[README](../README.md).
