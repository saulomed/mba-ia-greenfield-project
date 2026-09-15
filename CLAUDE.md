# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with three main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express) and the Video Worker entrypoint (`src/worker/`). Modules: `auth`, `users`, `channels`, `mail`, `videos`, `storage`, `queue`, `media`. See `nestjs-project/CLAUDE.md`.
- `next-frontend/` — Frontend (Next.js). See `next-frontend/CLAUDE.md`.
- `docs/` — Project documentation, architecture diagrams, technical decisions (`docs/decisions/`) and phase planning (`docs/phases/`).

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, issues presigned storage URLs, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3-compatible; MinIO in local Docker) → video files and thumbnails
- **Message Queue** (BullMQ on Redis) → video processing and maintenance jobs
- **Email Service** (SMTP) → account confirmation and password recovery

## Video Upload & Processing (Phase 03)

Implemented in `nestjs-project/` — module map, endpoints, commands and gotchas live in `nestjs-project/CLAUDE.md`. Decisions: `docs/decisions/technical-decisions-phase-03-videos.md`. Plan and progress: `docs/phases/phase-03-videos/`.

- **Upload (up to 10 GiB, `VIDEO_MAX_UPLOAD_BYTES`):** video bytes never pass through the API. `POST /videos` creates the draft (`status = uploading`) and an S3 multipart upload; the client `PUT`s each part directly to the storage with presigned URLs, then calls `POST /videos/:publicId/upload/complete`, which checks the stored size and enqueues processing.
- **Processing:** the `video-worker` container (same codebase, entrypoint `src/worker/main.ts`) consumes the `video-processing` queue, extracts metadata with `ffprobe`, normalizes to MP4 H.264/AAC with `faststart`, extracts a thumbnail with FFmpeg and marks the video `ready` — or `failed` with a `failure_reason`.
- **Status lifecycle:** `uploading` → `processing` → `ready` | `failed`.
- **Unique URL:** each video gets an 11-character random base62 `public_id` (UNIQUE column); the UUID primary key is never exposed.
- **Streaming & download:** the API returns short-lived presigned `GetObject` URLs and the storage serves `Range` requests (206) directly. Thumbnails are the only public objects (`thumbnails/` prefix, unguessable keys).

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts. The one deliberate exception is `STORAGE_PUBLIC_ENDPOINT` (`http://localhost:9000`): it is the storage address used to sign URLs that the **browser** calls, not a container-to-container connection.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.
