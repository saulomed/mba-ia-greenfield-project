---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.12
target_file: nestjs-project/test/videos-stream-download.e2e-spec.ts
---

# Stream and Download Endpoints Test Plan

## Application Overview

`GET /videos/:publicId/stream` e `GET /videos/:publicId/download` entregam reprodução e download sem que os bytes passem pela API: devolvem URLs pré-assinadas curtas de `GetObject` — do `playback.mp4` normalizado para o stream (com suporte a Range) e do arquivo original com `Content-Disposition: attachment` para o download. Só vídeos `'ready'` são servidos (409 nos demais) e o não dono recebe 404.

## Test Scenarios

### 1. GET /videos/:publicId/stream

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a configuração global de `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` executa `cleanAllTables(dataSource)` (incluindo `videos`) e limpa o storage do throttler; helper `registerConfirmAndLogin(email)` (mesmo padrão de `test/auth.e2e-spec.ts`) cria usuário confirmado com canal e devolve o access token; um segundo usuário (`other@example.com`) representa o não dono. O processo Jest usa `VIDEO_MAX_UPLOAD_BYTES=12582912` e `STORAGE_PUBLIC_ENDPOINT` igual a `STORAGE_ENDPOINT` (SI-03.2), então as URLs pré-assinadas são alcançáveis de dentro do container; partes enviadas ao storage usam `buildSyntheticPart`. Um vídeo `'ready'` é semeado direto no repositório `Video` no canal do dono com `original_filename: "Minhas Férias.mp4"`; os objetos `videos/{public_id}/original` e `videos/{public_id}/playback.mp4` são gravados via `StorageService.uploadFile` a partir da fixture `mp4-h264-aac-faststart` (`getVideoFixture`). Vídeos nos demais status são semeados da mesma forma, sem objetos.

#### 1.1. owner-gets-playback-url-for-ready-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. GET /videos/{public_id}/stream pelo dono
    - expect: status 200
    - expect: `url` não vazia, `expires_at` ISO-8601 no futuro e `content_type: "video/mp4"`

#### 1.2. playback-url-serves-range-requests-directly

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. GET /videos/{public_id}/stream pelo dono
    - expect: status 200
  2. GET na `url` com header `Range: bytes=0-1023` (requisição direta ao storage, fora do `app.getHttpServer()`)
    - expect: status 206
    - expect: corpo com exatamente 1024 bytes e header `Content-Range` iniciando em `bytes 0-1023/`

### 2. GET /videos/:publicId/download

**Setup:** Mesmo setup do grupo 1.

#### 2.1. owner-downloads-original-as-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. GET /videos/{public_id}/download pelo dono
    - expect: status 200
    - expect: `url` não vazia, `expires_at` ISO-8601 no futuro e `filename: "Minhas Férias.mp4"`
  2. GET na `url` direto no storage
    - expect: status 200
    - expect: header `Content-Disposition` começa com `attachment`, contém um `filename="..."` ASCII e `filename*=UTF-8''Minhas%20F%C3%A9rias.mp4`
    - expect: tamanho do corpo igual ao da fixture gravada como original

### 3. Estado, autorização e expiração (ambas as rotas)

**Setup:** Mesmo setup do grupo 1.

#### 3.1. not-ready-statuses-return-409-on-both-routes

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. Para cada status em `'uploading'`, `'processing'` e `'failed'`: semear o vídeo e chamar GET /videos/{public_id}/stream pelo dono
    - expect: status 409 com `error: "VIDEO_NOT_READY"`
  2. Para os mesmos vídeos, GET /videos/{public_id}/download pelo dono
    - expect: status 409 com `error: "VIDEO_NOT_READY"`

#### 3.2. non-owner-receives-404-on-both-routes

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. GET /videos/{public_id}/stream com o token do não dono para o vídeo `'ready'`
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/{public_id}/download com o token do não dono
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
  3. GET /videos/AAAAAAAAAAA/stream e /download com o token do dono
    - expect: status 404 com body idêntico aos passos 1 e 2

#### 3.3. expired-url-is-refused-by-storage

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. Compilar um `TestingModule` dedicado com `VIDEO_PLAYBACK_URL_TTL_SECONDS=1` (variável definida antes do bootstrap e restaurada no `afterAll` do bloco) e chamar GET /videos/{public_id}/stream pelo dono
    - expect: status 200 com `expires_at` cerca de 1 segundo após a requisição
  2. Aguardar até passar `expires_at` (poll com timeout de 5 s) e fazer GET na `url`
    - expect: status 403 do storage

#### 3.4. missing-token-returns-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. GET /videos/{public_id}/stream e /download sem header `Authorization`
    - expect: status 401 nas duas chamadas
