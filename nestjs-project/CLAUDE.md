# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, storage, queue, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `docker compose exec minio mc ready local` — exits with code 0 when ready (same command as the Compose healthcheck)
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`

`docker compose up -d` also starts the `video-worker` service, which runs `npm run start:worker:dev` (watch mode) by itself. It is the queue consumer for video processing, not the HTTP API.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

**Known issue — UID mismatch on bind mount:** both `nestjs-api` and `video-worker` run as `node` (uid 1000) — see `Dockerfile.dev`'s `USER node`. Both bind-mount the same host directory (`.:/home/node/app`). If the host user's uid differs from 1000 (check with `id -u` on the host), the top-level project directory is owned by the host uid/gid, and `node` has no write access to it — not because of individual file ownership, but because creating or removing an entry (a file or a directory) requires **write permission on the parent directory**, and `node`'s uid is in neither the owning user nor the owning group. This surfaces as `EACCES` on `npm install` (can't create `node_modules/`) and on `nest start --watch` for either service (can't create/rmdir `dist/` on every rebuild — this repeats on **every** watch-mode recompile, not just the first run, so per-command `-u root` workarounds have to be reapplied constantly).

**Permanent fix (apply once per host clone/checkout):** grant the `node` uid write access to the project root via a POSIX ACL, without changing the ownership of any file. This is scoped to uid 1000 specifically (unlike `chmod o+w`, which would open write access to every other user on the host) and is inherited by future top-level entries via a default ACL:

```bash
# Run on the HOST, from nestjs-project/ (needs the acl package: apt/dnf/brew install acl)
setfacl -m u:1000:rwx .
setfacl -d -m u:1000:rwx .

# Verify:
getfacl -p .   # expect "user:1000:rwx" and "default:user:1000:rwx"
```

After this, `docker compose exec nestjs-api ...` and `docker compose exec video-worker` (or `docker compose restart video-worker`) work as the regular `node` user — no `-u root` needed, and `nest start --watch` survives repeated rebuilds. Re-run the two `setfacl` commands only if the project is re-cloned into a new directory (ACLs don't travel with `git clone`/`cp`).

**Fallback (host has no `setfacl`, or the ACL hasn't been applied yet):** the old escape hatch still works for one-off recovery, but does not survive the next `nest --watch` rebuild:

```bash
docker compose exec -u root nestjs-api npm install
docker compose exec -u root nestjs-api chown -R node:node node_modules package-lock.json dist
docker compose exec -u root nestjs-api npm run start:dev   # or: docker compose exec -u root video-worker npm run start:worker:dev
```

**First-time `.env` setup:** the repo ships only `.env.example`; copy it before first run:

```bash
cp .env.example .env
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — Video Worker (same image and codebase as the API, entrypoint `src/worker/main.ts`), no exposed port; FFmpeg/ffprobe are installed by `Dockerfile.dev`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP on port `1025`, web UI on port `8025`
- `minio` — MinIO (S3-compatible object storage), API on `127.0.0.1:9000`, console on `127.0.0.1:9001`, user/password `minioadmin`
- `redis` — Redis 7 (BullMQ backend), port `6379`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL, MinIO and Redis are ready (run inside their containers)
docker compose exec db pg_isready -U streamtube
docker compose exec minio mc ready local
docker compose exec redis redis-cli ping

# Check container logs
docker compose logs nestjs-api
docker compose logs video-worker
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
npm run openapi:export                   # Regenerate openapi.json
```

### Video worker

The `video-worker` service already runs `npm run start:worker:dev` (`nest start --watch --entryFile worker/main`). Restart it with `docker compose restart video-worker` and follow it with `docker compose logs -f video-worker`. `npm run start:worker:prod` runs the compiled `dist/worker/main`.

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec minio mc ready local
docker compose exec redis redis-cli ping
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Video, storage, queue and media suites use the real `minio` and `redis` services and the FFmpeg binaries of the container — keep those services healthy before running them.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker:dev`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config, `rootDir: src`) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config", ...]` — without `dotenv/config`, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `setupFiles` also loads `src/test/setup-env.ts`, which forces `VIDEO_MAX_UPLOAD_BYTES=12582912` (12 MiB, so size-limit tests never need 10 GiB) and sets `STORAGE_PUBLIC_ENDPOINT` to `STORAGE_ENDPOINT`, so presigned URLs are signed for `minio:9000`, the host reachable from inside the container.
- `globalSetup: src/test/global-setup.ts` — generates the video fixtures once with FFmpeg `lavfi` (`src/test/video-fixtures.ts`, cached under `os.tmpdir()/streamtube-video-fixtures`). Multipart tests build part payloads with `src/test/synthetic-bytes.ts`.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- The Video Worker is a second process of the same codebase: `src/worker/main.ts` boots `WorkerModule` with `NestFactory.createApplicationContext` (no HTTP server)

## Videos Module (Phase 03)

Flow summary in the root `CLAUDE.md`; full specification in `docs/phases/phase-03-videos/phase-03-videos.md`; decisions in `docs/decisions/technical-decisions-phase-03-videos.md`.

### Module map

| Path | Responsibility |
|------|----------------|
| `src/videos/` | `VideosController` (endpoints below), `VideosService` (draft creation, multipart orchestration, ownership lookup, presigned stream/download URLs), `VideoProcessingProducer` (enqueues `process`), `Video` entity, `public-id.util.ts` |
| `src/storage/` | `StorageService` (AWS SDK v3: multipart, presign, upload/download, delete; translates SDK errors into `StorageInvalidPartsException`/`StorageObjectNotFoundException`), `StorageBootstrapService` (creates the bucket, applies the multipart-abort lifecycle rule and the public-read policy for `thumbnails/*`) |
| `src/queue/` | `QueueModule` — `BullModule.forRootAsync` connected to `queue.host`/`queue.port` |
| `src/media/` | `MediaService` — thin wrapper over the system `ffprobe`/`ffmpeg` via `child_process.spawn` (probe, normalize, thumbnail) |
| `src/worker/` | `main.ts`, `WorkerModule`, `VideoProcessingConsumer`, `VideoMaintenanceConsumer`, `VideoMaintenanceScheduler` |
| `src/database/migrations/1789324957302-CreateVideos.ts` | `videos` table, `videos_status_enum`, UNIQUE `public_id`, FK `channel_id` → `channels` |

### Endpoints

All video endpoints require a JWT. Ownership is resolved through the caller's channel: a video from another channel and an unknown `public_id` both return the same `404 VIDEO_NOT_FOUND`.

| Endpoint | Success | Notes |
|----------|---------|-------|
| `POST /videos` | 201 | Validates `content_type` (`video/*`) and `size_bytes` ≤ `VIDEO_MAX_UPLOAD_BYTES`; creates the draft and the multipart upload; returns `public_id`, `part_size_bytes`, `part_count` |
| `POST /videos/:publicId/upload/part-urls` | 200 | Presigned `PUT` URLs for 1–100 unique `part_numbers` (each ≤ `part_count`) |
| `GET /videos/:publicId/upload/parts` | 200 | Parts already stored, for resuming an upload |
| `POST /videos/:publicId/upload/complete` | 202 | Completes the multipart upload, checks the stored size, sets `processing` and enqueues the job |
| `GET /videos/:publicId` | 200 | Owner detail: status, metadata, `failure_reason`, `thumbnail_url` |
| `GET /videos/:publicId/stream` | 200 | Presigned URL of `playback.mp4` (TTL `VIDEO_PLAYBACK_URL_TTL_SECONDS`); only when `ready` |
| `GET /videos/:publicId/download` | 200 | Presigned URL of the original file with `Content-Disposition: attachment`; only when `ready` |

Domain errors: `VIDEO_NOT_FOUND` (404), `VIDEO_TOO_LARGE` (413), `VIDEO_UPLOAD_NOT_IN_PROGRESS` (409), `INVALID_UPLOAD_PARTS` (400), `UPLOAD_SIZE_MISMATCH` (422 — the object and the draft are removed), `VIDEO_NOT_READY` (409). All video endpoints are in `openapi.json`.

### Status, storage keys and jobs

- **Status:** `uploading` (draft) → `processing` (after complete) → `ready` | `failed`. Processing failures never become HTTP errors: the worker stores `failure_reason` = `INVALID_MEDIA` or `SOURCE_MISSING` (unrecoverable, no retry) or `PROCESSING_ERROR` (after the last of 3 attempts, exponential backoff starting at 5 s). A job for a video that is already `ready` is a no-op.
- **Storage keys** (single bucket `STORAGE_BUCKET`): `videos/{public_id}/original`, `videos/{public_id}/playback.mp4`, `thumbnails/{32 hex chars}.jpg` (public read, `Cache-Control: public, max-age=31536000, immutable`). Everything outside `thumbnails/` is private and reachable only through presigned URLs.
- **Queues** (`VIDEO_QUEUES`/`VIDEO_JOBS` in `src/videos/videos.constants.ts`):
  - `video-processing` → job `process` with `{ videoId }` and `jobId = videoId`, so the same video is never enqueued twice.
  - `video-maintenance` → job `expire-drafts`, scheduled every hour by `VideoMaintenanceScheduler`; deletes `uploading` drafts older than `VIDEO_DRAFT_TTL_HOURS` and aborts their multipart upload.

### Environment variables

`STORAGE_*`, `QUEUE_*` and `VIDEO_*` are listed in `.env.example` and validated in `src/config/env.validation.ts` (`STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` are required). `STORAGE_ENDPOINT` (`http://minio:9000`) is used for storage operations; `STORAGE_PUBLIC_ENDPOINT` (`http://localhost:9000`) is used only to sign the URLs returned to the browser — a presigned URL only works against the host it was signed for.

### Gotchas

- **The worker has its own module graph:** `WorkerModule` does not import `AppModule`. Configs, entities (`TypeOrmModule.forFeature([Video, Channel, User])`) and queues used by the consumers must be registered there; `VideosModule` and `WorkerModule` each call `BullModule.registerQueue` for both queues.
- **MinIO lifecycle warning is expected:** on boot, `StorageBootstrapService` logs `Storage rejected the multipart-abort lifecycle rule...`. MinIO does not support the `AbortIncompleteMultipartUpload` lifecycle action; locally, abandoned parts are cleaned by `MINIO_API_STALE_UPLOADS_EXPIRY=24h` (`compose.yaml`). The rule takes effect on AWS S3.
- **MinIO image:** `compose.yaml` pins `quay.io/minio/minio` by digest because `minio/minio` is no longer available on Docker Hub (see SI-03.1 in `docs/phases/phase-03-videos/progress.md`). Development only.
- **Browser uploads need CORS:** parts are `PUT` straight to MinIO; `MINIO_API_CORS_ALLOW_ORIGIN=*` in `compose.yaml` allows it locally.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
