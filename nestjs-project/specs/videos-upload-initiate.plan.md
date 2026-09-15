---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-upload-initiate.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` inicia o upload retomável de um vídeo: valida o body, rejeita tamanhos acima de `VIDEO_MAX_UPLOAD_BYTES`, pré-cadastra o vídeo como rascunho (`status = 'uploading'`) no canal do usuário autenticado, abre o multipart no MinIO e devolve o plano de partes (`part_size_bytes`, `part_count`) para o cliente enviar os bytes direto ao storage.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a configuração global de `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` executa `cleanAllTables(dataSource)` (incluindo `videos`) e limpa o storage do throttler; helper `registerConfirmAndLogin(email)` (mesmo padrão de `test/auth.e2e-spec.ts`) cria usuário confirmado com canal e devolve o access token; um segundo usuário (`other@example.com`) representa o não dono. O processo Jest usa `VIDEO_MAX_UPLOAD_BYTES=12582912` e `STORAGE_PUBLIC_ENDPOINT` igual a `STORAGE_ENDPOINT` (SI-03.2), então as URLs pré-assinadas são alcançáveis de dentro do container; partes enviadas ao storage usam `buildSyntheticPart`.

#### 1.1. creates-draft-and-returns-part-plan

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <owner_token>` e body `{ "filename": "Minhas Férias.mov", "content_type": "video/quicktime", "size_bytes": 6291456 }`
    - expect: status 201
    - expect: `public_id` casa `/^[0-9A-Za-z]{11}$/`
    - expect: body contém `title: "Minhas Férias"`, `status: "uploading"`, `part_size_bytes: 5242880` e `part_count: 2`
  2. Consultar o repositório `Video` por `public_id`
    - expect: existe um registro com `status = 'uploading'`, `channel_id` igual ao canal do usuário dono e `upload_id` não nulo
    - expect: `original_filename = "Minhas Férias.mov"`, `mime_type = "video/quicktime"`, `size_bytes = 6291456` e `original_key = "videos/{public_id}/original"`

#### 1.2. rejects-size-above-limit-with-413

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "grande.mp4", "content_type": "video/mp4", "size_bytes": 12582913 }` (1 byte acima do limite de teste)
    - expect: status 413
    - expect: body `{ statusCode: 413, error: "VIDEO_TOO_LARGE", message: "Video exceeds the maximum upload size" }`
  2. Contar registros na tabela `videos`
    - expect: 0 registros

#### 1.3. accepts-size-exactly-at-limit

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "limite.mp4", "content_type": "video/mp4", "size_bytes": 12582912 }`
    - expect: status 201
    - expect: `part_size_bytes: 5242880` e `part_count: 3`

#### 1.4. rejects-non-video-content-type-with-400

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "foto.png", "content_type": "image/png", "size_bytes": 1024 }`
    - expect: status 400
    - expect: `error: "VALIDATION_ERROR"`
    - expect: nenhum registro em `videos`

#### 1.5. rejects-missing-token-with-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos sem header `Authorization` e com body válido
    - expect: status 401
    - expect: nenhum registro em `videos`
