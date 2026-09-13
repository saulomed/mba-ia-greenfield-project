---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.9
target_file: nestjs-project/test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete Test Plan

## Application Overview

`POST /videos/:publicId/upload/complete` conclui o multipart no storage, confere o tamanho real do objeto contra o declarado e o limite, move o vídeo para `'processing'` e publica o job `process` na fila `video-processing` com `jobId` igual ao `id` do vídeo. Partes inválidas mantêm o rascunho para nova tentativa; divergência de tamanho remove objeto e rascunho; complete repetido é recusado sem duplicar o job.

## Test Scenarios

### 1. POST /videos/:publicId/upload/complete

**Setup:** `beforeAll` compila `Test.createTestingModule({ imports: [AppModule] })` e reproduz a configuração global de `main.ts` (`ValidationPipe` com `whitelist`, `forbidNonWhitelisted` e `transform`; `DomainExceptionFilter` e `ValidationExceptionFilter`); `beforeEach` executa `cleanAllTables(dataSource)` (incluindo `videos`) e limpa o storage do throttler; helper `registerConfirmAndLogin(email)` (mesmo padrão de `test/auth.e2e-spec.ts`) cria usuário confirmado com canal e devolve o access token; um segundo usuário (`other@example.com`) representa o não dono. O processo Jest usa `VIDEO_MAX_UPLOAD_BYTES=12582912` e `STORAGE_PUBLIC_ENDPOINT` igual a `STORAGE_ENDPOINT` (SI-03.2), então as URLs pré-assinadas são alcançáveis de dentro do container; partes enviadas ao storage usam `buildSyntheticPart`. A fila `video-processing` é obtida por `app.get(getQueueToken('video-processing'))` e pausada no `beforeAll` (`queue.pause()`) para que um `video-worker` em execução no Compose não consuma os jobs durante a suíte; `afterEach` remove os jobs criados pelo teste e `afterAll` executa `queue.resume()` antes de `app.close()`. Helper `uploadParts(token, publicId, sizes)` pede as URLs, envia `buildSyntheticPart` de cada tamanho por PUT e devolve `[{ part_number, etag }]`.

#### 1.1. completes-upload-and-enqueues-processing

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos pelo dono com `size_bytes: 6291456` e enviar as partes de 5242880 e 1048576 bytes via `uploadParts`
    - expect: dois PUTs com status 200 e `ETag`
  2. POST /videos/{public_id}/upload/complete pelo dono com `{ "parts": [...] }` retornado pelo helper
    - expect: status 202
    - expect: body `{ public_id: <public_id>, status: "processing" }`
  3. Consultar o repositório `Video` por `public_id`
    - expect: `status = 'processing'`, `upload_completed_at` não nulo e `upload_id` nulo
  4. `queue.getJob(video.id)`
    - expect: job existe com `name = 'process'` e `data` igual a `{ videoId: video.id }`

#### 1.2. repeated-complete-returns-409-without-second-job

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. Executar o fluxo do cenário 1.1 até o complete com 202
  2. Repetir POST /videos/{public_id}/upload/complete com as mesmas partes
    - expect: status 409
    - expect: `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`
  3. Contar jobs `process` da fila cujo `data.videoId` é o `id` do vídeo (`queue.getJobs(['waiting', 'paused', 'delayed'])`)
    - expect: exatamente 1 job

#### 1.3. wrong-etag-returns-400-and-keeps-draft

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos pelo dono com `size_bytes: 6291456` e enviar as duas partes via `uploadParts`
  2. POST /videos/{public_id}/upload/complete com a `etag` da parte 2 substituída por `"\"00000000000000000000000000000000\""`
    - expect: status 400
    - expect: `error: "INVALID_UPLOAD_PARTS"`
  3. Consultar o repositório `Video`
    - expect: `status = 'uploading'` e `upload_id` não nulo
  4. POST /videos/{public_id}/upload/complete com as `etag` corretas
    - expect: status 202 (o rascunho continua utilizável)

#### 1.4. size-mismatch-returns-422-and-removes-object-and-draft

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos pelo dono com `size_bytes: 6291456` e enviar partes de 5242880 e 2097152 bytes via `uploadParts` (total 7340032)
  2. POST /videos/{public_id}/upload/complete com as partes enviadas
    - expect: status 422
    - expect: `error: "UPLOAD_SIZE_MISMATCH"`
  3. Consultar o repositório `Video` por `public_id`
    - expect: nenhum registro
  4. `StorageService.headObject("videos/{public_id}/original")`
    - expect: falha com o erro tipado de objeto inexistente
  5. `queue.getJob` para o `id` que o vídeo tinha
    - expect: nenhum job

#### 1.5. non-owner-returns-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos pelo dono com `size_bytes: 6291456` e enviar as duas partes via `uploadParts`
  2. POST /videos/{public_id}/upload/complete com o token do não dono e as partes corretas
    - expect: status 404
    - expect: `error: "VIDEO_NOT_FOUND"`
  3. Consultar o repositório `Video`
    - expect: `status = 'uploading'` (nada foi concluído)

#### 1.6. empty-parts-returns-400-validation-error

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos/{public_id}/upload/complete pelo dono com `{ "parts": [] }`
    - expect: status 400
    - expect: `error: "VALIDATION_ERROR"`

#### 1.7. missing-token-returns-401

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-13T17:32:58Z

**Steps:**
  1. POST /videos/{public_id}/upload/complete sem header `Authorization`
    - expect: status 401
