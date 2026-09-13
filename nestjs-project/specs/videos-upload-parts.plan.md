---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.8
target_file: nestjs-project/test/videos-upload-parts.e2e-spec.ts
---

# Upload Parts Endpoints Test Plan

## Application Overview

`POST /videos/:publicId/upload/part-urls` emite URLs pré-assinadas de `UploadPart` para um lote de partes, e `GET /videos/:publicId/upload/parts` lista as partes já recebidas pelo storage. Juntos permitem que o cliente envie os bytes direto ao MinIO e retome o upload após falha de conexão. Só o dono acessa; não dono recebe 404 como se o vídeo não existisse, e vídeos fora de `'uploading'` recebem 409.

## Test Scenarios

### 1. POST /videos/:publicId/upload/part-urls

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a configuração global de `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` executa `cleanAllTables(dataSource)` (incluindo `videos`) e limpa o storage do throttler; helper `registerConfirmAndLogin(email)` (mesmo padrão de `test/auth.e2e-spec.ts`) cria usuário confirmado com canal e devolve o access token; um segundo usuário (`other@example.com`) representa o não dono. O processo Jest usa `VIDEO_MAX_UPLOAD_BYTES=12582912` e `STORAGE_PUBLIC_ENDPOINT` igual a `STORAGE_ENDPOINT` (SI-03.2), então as URLs pré-assinadas são alcançáveis de dentro do container; partes enviadas ao storage usam `buildSyntheticPart`. Cada cenário cria o rascunho com `POST /videos` (`size_bytes: 6291456`, logo `part_count: 2`) pelo dono.

#### 1.1. returns-presigned-urls-for-requested-parts

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos/{public_id}/upload/part-urls pelo dono com `{ "part_numbers": [1, 2] }`
    - expect: status 200
    - expect: `parts` tem 2 entradas `{ part_number, url }` com `part_number` 1 e 2 e `url` não vazia
    - expect: `expires_at` é ISO-8601 e posterior ao instante da requisição

#### 1.2. presigned-url-accepts-part-upload

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos/{public_id}/upload/part-urls pelo dono com `{ "part_numbers": [1] }`
    - expect: status 200
  2. PUT na `url` da parte 1 com `buildSyntheticPart(1, 5242880)` como corpo
    - expect: status 200 do storage
    - expect: header `ETag` presente

#### 1.3. rejects-more-than-100-part-numbers-with-400

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos/{public_id}/upload/part-urls pelo dono com `part_numbers` contendo 101 inteiros distintos (1..101)
    - expect: status 400
    - expect: `error: "VALIDATION_ERROR"`

#### 1.4. rejects-part-number-above-part-count-with-400

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos/{public_id}/upload/part-urls pelo dono com `{ "part_numbers": [3] }` para um rascunho com `part_count: 2`
    - expect: status 400
    - expect: `error: "VALIDATION_ERROR"`

### 2. GET /videos/:publicId/upload/parts

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a configuração global de `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` executa `cleanAllTables(dataSource)` (incluindo `videos`) e limpa o storage do throttler; helper `registerConfirmAndLogin(email)` (mesmo padrão de `test/auth.e2e-spec.ts`) cria usuário confirmado com canal e devolve o access token; um segundo usuário (`other@example.com`) representa o não dono. O processo Jest usa `VIDEO_MAX_UPLOAD_BYTES=12582912` e `STORAGE_PUBLIC_ENDPOINT` igual a `STORAGE_ENDPOINT` (SI-03.2), então as URLs pré-assinadas são alcançáveis de dentro do container; partes enviadas ao storage usam `buildSyntheticPart`. Cada cenário cria o rascunho com `POST /videos` (`size_bytes: 6291456`) pelo dono.

#### 2.1. lists-uploaded-parts-after-put

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. Obter a URL da parte 1 via POST /videos/{public_id}/upload/part-urls e enviar `buildSyntheticPart(1, 5242880)` por PUT
    - expect: status 200 do storage com header `ETag`
  2. GET /videos/{public_id}/upload/parts pelo dono
    - expect: status 200
    - expect: `parts` igual a `[{ part_number: 1, etag: <ETag do PUT>, size_bytes: 5242880 }]`

#### 2.2. lists-empty-when-no-part-uploaded

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. GET /videos/{public_id}/upload/parts pelo dono logo após criar o rascunho
    - expect: status 200
    - expect: `parts` igual a `[]`

### 3. Autorização e estado (ambas as rotas)

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a configuração global de `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` executa `cleanAllTables(dataSource)` (incluindo `videos`) e limpa o storage do throttler; helper `registerConfirmAndLogin(email)` (mesmo padrão de `test/auth.e2e-spec.ts`) cria usuário confirmado com canal e devolve o access token; um segundo usuário (`other@example.com`) representa o não dono. O processo Jest usa `VIDEO_MAX_UPLOAD_BYTES=12582912` e `STORAGE_PUBLIC_ENDPOINT` igual a `STORAGE_ENDPOINT` (SI-03.2), então as URLs pré-assinadas são alcançáveis de dentro do container; partes enviadas ao storage usam `buildSyntheticPart`. O rascunho é criado pelo dono; o não dono faz login separadamente.

#### 3.1. non-owner-receives-404-on-both-routes

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos/{public_id}/upload/part-urls com o token do não dono e `{ "part_numbers": [1] }`
    - expect: status 404
    - expect: `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/{public_id}/upload/parts com o token do não dono
    - expect: status 404
    - expect: `error: "VIDEO_NOT_FOUND"`

#### 3.2. unknown-public-id-receives-same-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos/AAAAAAAAAAA/upload/part-urls pelo dono com `{ "part_numbers": [1] }`
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"` e o mesmo `message` do cenário 3.1
  2. GET /videos/AAAAAAAAAAA/upload/parts pelo dono
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`

#### 3.3. processing-video-receives-409-on-both-routes

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. Atualizar o rascunho diretamente no repositório para `status = 'processing'`
  2. POST /videos/{public_id}/upload/part-urls pelo dono com `{ "part_numbers": [1] }`
    - expect: status 409
    - expect: `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`
  3. GET /videos/{public_id}/upload/parts pelo dono
    - expect: status 409
    - expect: `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`

#### 3.4. missing-token-receives-401

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos/{public_id}/upload/part-urls e GET /videos/{public_id}/upload/parts sem header `Authorization`
    - expect: status 401 nas duas chamadas
