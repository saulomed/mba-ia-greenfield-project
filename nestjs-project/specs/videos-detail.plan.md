---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.11
target_file: nestjs-project/test/videos-detail.e2e-spec.ts
---

# GET /videos/:publicId Test Plan

## Application Overview

`GET /videos/:publicId` expõe ao dono o estado do vídeo e os metadados extraídos pelo worker, para acompanhar o processamento. Inclui a `thumbnail_url` pública e estável sob `thumbnails/` quando existe, nunca expõe identificadores ou chaves internas e responde 404 ao não dono como se o vídeo não existisse.

## Test Scenarios

### 1. GET /videos/:publicId

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a configuração global de `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` executa `cleanAllTables(dataSource)` (incluindo `videos`) e limpa o storage do throttler; helper `registerConfirmAndLogin(email)` (mesmo padrão de `test/auth.e2e-spec.ts`) cria usuário confirmado com canal e devolve o access token; um segundo usuário (`other@example.com`) representa o não dono. O processo Jest usa `VIDEO_MAX_UPLOAD_BYTES=12582912` e `STORAGE_PUBLIC_ENDPOINT` igual a `STORAGE_ENDPOINT` (SI-03.2), então as URLs pré-assinadas são alcançáveis de dentro do container; partes enviadas ao storage usam `buildSyntheticPart`. Vídeos em `'ready'` e `'failed'` são semeados direto no repositório `Video` no canal do dono (o worker não roda no processo de teste); para o vídeo `'ready'`, uma thumbnail JPEG é gravada em `thumbnails/{hex aleatório}.jpg` via `StorageService.uploadFile` a partir de um frame extraído da fixture `mp4-h264-aac-faststart`.

#### 1.1. owner-sees-draft-with-null-metadata

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos pelo dono com `{ "filename": "clipe.mp4", "content_type": "video/mp4", "size_bytes": 6291456 }`
    - expect: status 201
  2. GET /videos/{public_id} pelo dono
    - expect: status 200
    - expect: `status: "uploading"`, `thumbnail_url: null`, `failure_reason: null`, `processed_at: null`
    - expect: `duration_seconds`, `width`, `height`, `video_codec` e `audio_codec` nulos
    - expect: `original_filename: "clipe.mp4"`, `mime_type: "video/mp4"`, `size_bytes: 6291456` (número) e `created_at` ISO-8601
    - expect: body não contém as chaves `id`, `channel_id`, `upload_id`, `original_key` nem `playback_key`

#### 1.2. owner-sees-ready-video-with-metadata-and-public-thumbnail

**Covers AC:** #2, #5
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. Semear vídeo `'ready'` com `duration_seconds: 2.000`, `width: 320`, `height: 240`, `video_codec: 'h264'`, `audio_codec: 'aac'`, `playback_key`, `thumbnail_key` e `processed_at`
  2. GET /videos/{public_id} pelo dono
    - expect: status 200
    - expect: `status: "ready"`, `duration_seconds: 2` (número), `width: 320`, `height: 240`, `video_codec: "h264"`, `audio_codec: "aac"` e `processed_at` ISO-8601
    - expect: `thumbnail_url` igual a `{STORAGE_PUBLIC_ENDPOINT}/{STORAGE_BUCKET}/{thumbnail_key}`
    - expect: body não contém `id`, `channel_id`, `upload_id`, `original_key` nem `playback_key`
  3. GET anônimo (sem credenciais) em `thumbnail_url`
    - expect: status 200 com `Content-Type: image/jpeg`

#### 1.3. owner-sees-failure-reason-for-failed-video

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. Semear vídeo `'failed'` com `failure_reason: 'INVALID_MEDIA'` e `processed_at` preenchido
  2. GET /videos/{public_id} pelo dono
    - expect: status 200
    - expect: `status: "failed"` e `failure_reason: "INVALID_MEDIA"`
    - expect: `thumbnail_url: null`

#### 1.4. non-owner-and-unknown-id-receive-identical-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. GET /videos/{public_id} de um vídeo do dono com o token do não dono
    - expect: status 404
    - expect: `error: "VIDEO_NOT_FOUND"` e `message: "Video not found"`
  2. GET /videos/AAAAAAAAAAA com o token do dono
    - expect: status 404 com body idêntico ao do passo 1

#### 1.5. missing-token-returns-401

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. GET /videos/{public_id} sem header `Authorization`
    - expect: status 401
