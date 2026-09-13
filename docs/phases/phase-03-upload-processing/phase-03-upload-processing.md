---
kind: phase
name: phase-03-upload-processing
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-upload-processing/context.md: "2026-09-13T14:04:35-03:00"
  docs/phases/phase-03-upload-processing/library-refs.md: "2026-09-13T14:04:37-03:00"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-09-13T14:04:25-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-13T11:07:43-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-09-13T11:07:43-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-09-13T11:07:43-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-09-13T11:07:43-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar no `nestjs-project` o upload de vídeos de até 10GB sem impacto na performance (multipart retomável direto ao object storage, com pré-cadastro automático do rascunho), o processamento automático em segundo plano por fila e Video Worker (extração de duração e metadados, normalização para reprodução e geração de thumbnail a partir de um frame), a URL única por vídeo sem conflito, a reprodução via streaming e o download do vídeo pelo usuário.

---

## Step Implementations

### SI-03.1 — Infra: Dependências, Configuração e Serviços de Storage, Fila e Worker

**Description:** Instalar as bibliotecas decididas, criar os namespaces de configuração `storage`, `queue` e `video` no padrão `registerAs` herdado e subir MinIO, Redis e o container `video-worker` no Compose, com FFmpeg disponível na imagem de desenvolvimento.

**Technical actions:**

1. Instalar no `nestjs-project` (dentro do container): `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (mesma minor), `@nestjs/bullmq`, `bullmq` — versões fixadas no momento da instalação conforme `library-refs.md` (per `phase-03-upload-processing/TD-01`, `phase-03-upload-processing/TD-02`, `phase-03-upload-processing/TD-03`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` com `STORAGE_ENDPOINT` (interno, ex.: `http://minio:9000`), `STORAGE_PUBLIC_ENDPOINT` (usado só para assinar URLs acessíveis pelo navegador, ex.: `http://localhost:9000`), `STORAGE_REGION` (default `'us-east-1'`), `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET` (default `'streamtube'`); `src/config/queue.config.ts` — `registerAs('queue', ...)` com `QUEUE_HOST` (default `'redis'`), `QUEUE_PORT` (default `6379`); `src/config/video.config.ts` — `registerAs('video', ...)` com `VIDEO_MAX_UPLOAD_BYTES` (default `10737418240`), `VIDEO_UPLOAD_PART_URL_TTL_SECONDS` (default `3600`), `VIDEO_PLAYBACK_URL_TTL_SECONDS` (default `900`), `VIDEO_DRAFT_TTL_HOURS` (default `24`), `VIDEO_MULTIPART_ABORT_DAYS` (default `1`) (per `phase-01-configuracao-base/TD-03`, `phase-03-upload-processing/TD-02`, `phase-03-upload-processing/TD-09`, `phase-03-upload-processing/TD-10`, `phase-03-upload-processing/TD-12`)
3. Atualizar `src/config/env.validation.ts` com todas as chaves acima (`STORAGE_ACCESS_KEY` e `STORAGE_SECRET_KEY` obrigatórias; demais com default) e `.env.example` com valores compatíveis com o Compose (hosts pelo nome do serviço: `minio`, `redis`) (per `phase-01-configuracao-base/TD-02`)
4. Adicionar a `compose.yaml`: serviço `minio` (`minio/minio`, `server /data --console-address :9001`, portas `9000`/`9001`, volume nomeado, healthcheck, `MINIO_API_CORS_ALLOW_ORIGIN` para permitir o `PUT` de partes pelo navegador e `MINIO_API_STALE_UPLOADS_EXPIRY` como rede de segurança de multipart abandonado); serviço `redis` (`redis:7`, healthcheck `redis-cli ping`); serviço `video-worker` com o mesmo `build`/volume do `nestjs-api`, comando `npm run start:worker:dev` e `depends_on` de `db`, `minio` e `redis`; `nestjs-api` passa a depender de `minio` e `redis` (per `phase-03-upload-processing/TD-02`, `phase-03-upload-processing/TD-03`, `phase-03-upload-processing/TD-04`)
5. Instalar `ffmpeg` (que inclui `ffprobe`) em `Dockerfile.dev` via `apt-get` — a imagem de desenvolvimento é compartilhada por `nestjs-api` e `video-worker` (mesmo codebase) e é onde as suítes de teste rodam; o código da API nunca invoca o binário (só o `WorkerModule` importa o `MediaModule`), e a restrição do binário à imagem do worker vale para a imagem de produção, fora do escopo desta fase (per `phase-03-upload-processing/TD-05`, `phase-03-upload-processing/TD-12`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: bootstrap falha sem `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`; defaults de `QUEUE_*` e `VIDEO_*` aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `nestjs-api`, `db`, `mailpit`, `minio`, `redis` e `video-worker` em execução, com `minio` e `redis` saudáveis
- Iniciar a aplicação sem `STORAGE_SECRET_KEY` gera erro de validação Joi no bootstrap e a aplicação não sobe
- `docker compose exec video-worker ffprobe -version` e `docker compose exec nestjs-api ffprobe -version` retornam a versão instalada
- O console do MinIO responde em `localhost:9001` e `docker compose exec redis redis-cli ping` retorna `PONG`
- O teste E2E existente (`GET /` retorna 200) continua passando

---

### SI-03.2 — Vídeos de Teste Gerados sob Demanda e Bytes Sintéticos

**Description:** Criar a infraestrutura de fixtures da fase sem versionar binários: clipes curtos gerados com FFmpeg `lavfi` e cacheados em `os.tmpdir()`, fluxo de bytes sintético em partes de 5 MiB para o multipart e limite de upload reduzido no ambiente de teste para validar a regra de 10GB.

**Technical actions:**

1. Criar `src/test/video-fixtures.ts` — matriz declarada em código (`mp4-h264-aac-faststart`, `mp4-h264-aac-no-faststart`, `mkv-hevc-aac`, `webm-vp9-opus`, `mp4-video-only`, `truncated`), cada item com os argumentos `ffmpeg -f lavfi -i testsrc2=duration=2:size=320x240:rate=25` + `-f lavfi -i sine=frequency=440:duration=2` (exceto `mp4-video-only`); `truncated` corta os bytes finais de um MP4 válido; `getVideoFixture(name): Promise<string>` devolve o caminho em `os.tmpdir()/streamtube-video-fixtures/{hash dos argumentos}/` e gera só quando o arquivo não existe (per `phase-03-upload-processing/TD-12`, `phase-03-upload-processing/TD-05`)
2. Criar `src/test/global-setup.ts` que pré-gera toda a matriz e registrar como `globalSetup` na configuração Jest de `package.json` e em `test/jest-e2e.json` (per `phase-03-upload-processing/TD-12`)
3. Criar `src/test/synthetic-bytes.ts` — `createSyntheticStream(totalBytes: number): Readable` com conteúdo determinístico gerado em blocos sem alocar o total em memória, e `buildSyntheticPart(partNumber: number, sizeBytes: number): Buffer` para partes de exatamente 5 MiB (mínimo S3/MinIO, exceto a última) (per `phase-03-upload-processing/TD-12`, `phase-03-upload-processing/TD-01`)
4. Criar `src/test/setup-env.ts`, registrado em `setupFiles` após `dotenv/config`, que define para o processo Jest `VIDEO_MAX_UPLOAD_BYTES=12582912` (12 MiB) e `STORAGE_PUBLIC_ENDPOINT` igual a `STORAGE_ENDPOINT` quando não definidos explicitamente, para que URLs pré-assinadas sejam alcançáveis de dentro do container (per `phase-03-upload-processing/TD-12`, `phase-03-upload-processing/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `getVideoFixture` | Integration: cada item da matriz existe após o `globalSetup`, `ffprobe` reporta duração ≈ 2 s e 320x240; `truncated` falha no `ffprobe`; segunda chamada não regenera (mtime inalterado) | `src/test/video-fixtures.integration-spec.ts` |
| `createSyntheticStream` / `buildSyntheticPart` | Unit: stream emite exatamente `totalBytes`; parte tem exatamente o tamanho pedido; conteúdo é determinístico entre execuções | `src/test/synthetic-bytes.spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg na imagem e chave `VIDEO_MAX_UPLOAD_BYTES` validada

**Acceptance criteria:**

- Após `npm test`, o diretório `streamtube-video-fixtures` em `os.tmpdir()` contém os 6 arquivos da matriz e nenhum arquivo de vídeo é adicionado ao repositório (`git status` limpo em `src/` e `test/`)
- Uma segunda execução da suíte não regenera os clipes (mesmo mtime)
- Dentro do processo Jest, `ConfigService` resolve `VIDEO_MAX_UPLOAD_BYTES` como `12582912`, enquanto o `.env` de desenvolvimento mantém `10737418240`
- `ffprobe` sobre `mp4-h264-aac-faststart` reporta `codec_name` `h264` e `aac`; sobre `mp4-video-only` não reporta stream de áudio

---

### SI-03.3 — StorageModule com Multipart, URLs Pré-assinadas e Bootstrap do Bucket

**Description:** Encapsular todo acesso ao object storage num `StorageModule` reutilizável pela API e pelo worker, com um client interno para operações e um client de endpoint público só para assinar URLs, e preparar o bucket (lifecycle de multipart e leitura pública do prefixo `thumbnails/`) no bootstrap.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.constants.ts` com dois providers de `S3Client` injetados por token (`STORAGE_CLIENT` com `STORAGE_ENDPOINT`, `STORAGE_PRESIGN_CLIENT` com `STORAGE_PUBLIC_ENDPOINT`), ambos com `forcePathStyle: true`, `region` e credenciais do namespace `storage` (per `phase-03-upload-processing/TD-02`, `phase-01-configuracao-base/TD-03`)
2. Criar `src/storage/storage.service.ts` com as operações de multipart via client interno: `createMultipartUpload(key, contentType)`, `listParts(key, uploadId)` (paginando por `PartNumberMarker` até `IsTruncated = false`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (tratando `NoSuchUpload` como sucesso), `headObject(key)` e `deleteObject(key)`; erros do SDK (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchKey`) são traduzidos para erros tipados do módulo, nunca vazam para os serviços de domínio (per `phase-03-upload-processing/TD-01`, `phase-03-upload-processing/TD-06`)
3. Adicionar a `StorageService` as operações de objeto e assinatura: `downloadToFile(key, path)` e `uploadFile(path, key, { contentType, cacheControl })` por stream (sem carregar o arquivo em memória), `presignUploadPart(key, uploadId, partNumber, expiresIn)` e `presignGetObject(key, expiresIn, { responseContentDisposition? })` via `getSignedUrl` com o client de endpoint público (per `phase-03-upload-processing/TD-01`, `phase-03-upload-processing/TD-09`)
4. Criar `src/storage/storage-bootstrap.service.ts` (`OnApplicationBootstrap`): cria o bucket se não existir; aplica `PutBucketLifecycleConfiguration` com `AbortIncompleteMultipartUpload.DaysAfterInitiation = VIDEO_MULTIPART_ABORT_DAYS` (se o MinIO rejeitar a regra, registra aviso — o `MINIO_API_STALE_UPLOADS_EXPIRY` da SI-03.1 cobre o ambiente local); aplica `PutBucketPolicy` com `s3:GetObject` anônimo restrito a `arn:aws:s3:::{bucket}/thumbnails/*`, sem `s3:ListBucket`; operações idempotentes (per `phase-03-upload-processing/TD-10`, `phase-03-upload-processing/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test com configuração de teste | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration (MinIO real): multipart com 2 partes sintéticas enviadas por `PUT` na URL pré-assinada → `listParts` → `completeMultipartUpload` → `headObject.ContentLength` correto; parte intermediária < 5 MiB gera erro tipado de partes inválidas; `abortMultipartUpload` repetido não falha; `presignGetObject` com `Range: bytes=0-99` retorna 206 | `src/storage/storage.service.integration-spec.ts` |
| `StorageBootstrapService` | Integration (MinIO real): bootstrap em bucket inexistente cria o bucket; `GET` anônimo em `thumbnails/{key}` retorna 200; `GET` anônimo em `videos/{key}` retorna 403; listagem anônima do bucket retorna 403; segunda execução não falha | `src/storage/storage-bootstrap.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — dependências do AWS SDK, namespace `storage` e serviço `minio`

**Acceptance criteria:**

- Uma parte enviada por `PUT` na URL devolvida por `presignUploadPart` aparece em `listParts` com `PartNumber`, `ETag` e `Size` corretos
- Após `completeMultipartUpload` de 2 partes (5 MiB + 1 MiB), `headObject` reporta `ContentLength = 6291456`
- `GET` anônimo em `{STORAGE_ENDPOINT}/{bucket}/thumbnails/{key}` retorna 200, e em qualquer chave fora de `thumbnails/` retorna 403
- `GET` com `Range: bytes=0-99` na URL de `presignGetObject` retorna 206 com 100 bytes
- A URL de `presignGetObject` com `responseContentDisposition` retorna o header `Content-Disposition: attachment` correspondente
- Reiniciar a aplicação com o bucket já configurado não gera erro

---

### SI-03.4 — Entidade Video, Migration e Gerador de public_id

**Description:** Criar a entidade `Video` pertencente ao canal, a migration correspondente e o gerador de `public_id` base62 aleatório que garante URL curta, única e não enumerável.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com as colunas, tipos, constraints e índices de `### Data Model → Video` (enum `status` com `'uploading'`, `'processing'`, `'ready'`, `'failed'` e default `'uploading'`; `size_bytes` `bigint` mapeado com transformer para `number`; `duration_seconds` `numeric(10,3)` com transformer para `number`) e `@ManyToOne(() => Channel)` via `channel_id` (per `phase-03-upload-processing/TD-07`, `phase-03-upload-processing/TD-08`, `phase-03-upload-processing/TD-11`)
2. Adicionar o lado inverso `@OneToMany(() => Video, (video) => video.channel)` em `src/channels/entities/channel.entity.ts`
3. Gerar a migration via TypeORM CLI (`CreateVideos`) criando o enum, a tabela `videos`, a FK para `channels.id` e os índices `(public_id)` unique, `(channel_id)` e `(status, created_at)`; incluir `Video` nas entidades de `data-source.ts` e de `src/test/create-test-data-source.ts` (per `phase-01-configuracao-base/TD-04`)
4. Criar `src/videos/public-id.util.ts` — `generatePublicId(length = 11): string` com `crypto.randomBytes` e amostragem por rejeição sobre o alfabeto base62 (sem viés de módulo) (per `phase-03-upload-processing/TD-07`)
5. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `status` default `'uploading'`; `public_id` duplicado viola unique; `channel_id` inexistente viola FK; `size_bytes` acima de 2^31 persiste e retorna como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: comprimento 11; só caracteres `[0-9A-Za-z]`; 10.000 gerações sem colisão; distribuição por caractere sem viés grosseiro | `src/videos/public-id.util.spec.ts` |
| Migration `CreateVideos` | Integration: apply/revert bidirecional (suíte existente) | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com o enum de status e os três índices; `migration:revert` remove tudo sem resíduo
- Inserir um `Video` sem `status` persiste `'uploading'`
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unique
- Inserir um vídeo com `channel_id` inexistente falha com violação de FK
- Um vídeo com `size_bytes = 10737418240` é lido de volta com o mesmo valor numérico

---

### SI-03.5 — Infra: Fila BullMQ e Entrypoint do Video Worker

**Description:** Configurar a conexão BullMQ com Redis, registrar as filas `video-processing` e `video-maintenance` e criar o entrypoint próprio do Video Worker no mesmo codebase, executado no container `video-worker` sem servidor HTTP.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` lendo `QUEUE_HOST`/`QUEUE_PORT` do namespace `queue` via `ConfigService` (per `phase-03-upload-processing/TD-03`, `phase-01-configuracao-base/TD-01`)
2. Criar `src/videos/videos.constants.ts` com `VIDEO_QUEUES = { PROCESSING: 'video-processing', MAINTENANCE: 'video-maintenance' } as const` e `VIDEO_JOBS = { PROCESS: 'process', EXPIRE_DRAFTS: 'expire-drafts' } as const`, e registrar `BullModule.registerQueue` das duas filas no `VideosModule` (produtor) (per `phase-03-upload-processing/TD-03`)
3. Criar `src/worker/worker.module.ts` importando `ConfigModule` (mesmo schema de validação), `TypeOrmModule.forRootAsync` (mesmo `databaseConfig`), `QueueModule`, `StorageModule` e o registro das duas filas; nenhum controller e nenhum `@Processor` no `AppModule` (per `phase-03-upload-processing/TD-04`, `phase-01-configuracao-base/TD-01`)
4. Criar `src/worker/main.ts` com `NestFactory.createApplicationContext(WorkerModule)` e `enableShutdownHooks()` para encerrar workers BullMQ de forma graciosa no `SIGTERM` (per `phase-03-upload-processing/TD-04`)
5. Adicionar scripts `start:worker:dev` (`nest start --watch --entryFile worker/main`) e `start:worker:prod` (`node dist/worker/main`) em `package.json`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test resolvendo as filas `video-processing` e `video-maintenance` por `getQueueToken` | `src/queue/queue.module.spec.ts` |
| `WorkerModule` | Unit: compilation test do contexto do worker sem módulos HTTP | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.1 — dependências BullMQ, namespace `queue` e serviço `redis`; SI-03.3 — `StorageModule` importado pelo worker

**Acceptance criteria:**

- `docker compose logs video-worker` mostra o contexto Nest inicializado sem erros e sem bind em porta HTTP
- `docker compose restart video-worker` encerra o processo sem erro de conexão pendente com Redis
- A API inicia sem registrar nenhum consumer das filas de vídeo (nenhum job é consumido pelo processo `nestjs-api`)
- Um job adicionado manualmente em `video-processing` aparece como `waiting` no Redis enquanto nenhum consumer está registrado

---

### SI-03.6 — Wrapper de FFmpeg/FFprobe para Metadados, Normalização e Thumbnail

**Description:** Implementar o wrapper enxuto sobre `child_process.spawn` que extrai metadados, normaliza o vídeo para MP4 H.264/AAC com `+faststart` e gera a thumbnail, usado exclusivamente pelo worker.

**Technical actions:**

1. Criar `src/media/ffmpeg.runner.ts` — executa `ffmpeg`/`ffprobe` via `spawn` com argumentos em array (sem shell), timeout configurável, captura de `stderr` limitada e erro tipado `MediaCommandError` com código de saída (per `phase-03-upload-processing/TD-05`)
2. Criar `src/media/media.service.ts` com `probe(path)` — `ffprobe -v error -print_format json -show_format -show_streams`; devolve `{ duration_seconds, width, height, video_codec, audio_codec }` com os nomes de `### Data Model → Video`; lança `InvalidMediaError` quando o `ffprobe` falha ou não há stream de vídeo (per `phase-03-upload-processing/TD-05`)
3. Adicionar `normalize(inputPath, outputPath, probe)` — remux (`-c copy`) quando `video_codec = 'h264'` e `audio_codec` é `'aac'` ou nulo; caso contrário transcodifica com `-c:v libx264 -pix_fmt yuv420p -c:a aac`; sempre `-movflags +faststart` e saída `.mp4` (per `phase-03-upload-processing/TD-08`)
4. Adicionar `extractThumbnail(inputPath, outputPath, durationSeconds)` — um frame JPEG em `min(1, durationSeconds / 2)` segundos com largura máxima de 1280 px preservando proporção (per `phase-03-upload-processing/TD-05`, `phase-03-upload-processing/TD-11`)
5. Criar `src/media/media.module.ts` exportando `MediaService` e importá-lo **somente** no `WorkerModule` (per `phase-03-upload-processing/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaService` | Integration (FFmpeg real + fixtures da SI-03.2): `probe` de cada item da matriz retorna duração ≈ 2 s, 320x240 e codecs esperados; `truncated` lança `InvalidMediaError`; `normalize` de `mkv-hevc-aac` produz MP4 `h264`/`aac`; `normalize` de `mp4-h264-aac-no-faststart` produz arquivo com átomo `moov` antes de `mdat`; `extractThumbnail` produz JPEG legível | `src/media/media.service.integration-spec.ts` |
| `MediaService` | Unit: decisão remux vs transcodificação por combinação de codecs; argumentos sempre incluem `+faststart`; timestamp da thumbnail para durações curtas | `src/media/media.service.spec.ts` |

**Dependencies:** SI-03.2 — fixtures de vídeo geradas sob demanda

**Acceptance criteria:**

- `probe` sobre um MP4 H.264/AAC de 2 s retorna `duration_seconds` entre 1.9 e 2.1, `width = 320`, `height = 240`, `video_codec = 'h264'` e `audio_codec = 'aac'`
- `probe` sobre um vídeo sem faixa de áudio retorna `audio_codec = null`
- `probe` sobre um arquivo truncado ou não-vídeo lança `InvalidMediaError`
- `normalize` sobre um MKV HEVC produz MP4 cujo `ffprobe` reporta `h264` e `aac` e cujo átomo `moov` precede `mdat`
- `normalize` sobre um MP4 H.264/AAC já compatível termina sem transcodificar (argumentos com `-c copy`)
- `extractThumbnail` gera um JPEG com largura ≤ 1280 px

---

### SI-03.7 — Endpoint POST /videos (Início do Upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-upload-initiate.plan.md`
**Authorization:** Authenticated (vídeo criado no canal do usuário)

**Description:** Iniciar o upload retomável: pré-cadastrar o vídeo como rascunho no canal do usuário e abrir o multipart no storage, devolvendo o plano de partes ao cliente.

**Technical actions:**

1. Criar `src/videos/dto/create-video-upload.dto.ts` com `filename`, `content_type` e `size_bytes` conforme `### API Contracts → POST /videos` e `#### Validation Rules — Upload de vídeos` (per `phase-02-auth/TD-06`)
2. Criar `src/videos/video.exceptions.ts` com as subclasses de `DomainException` de `### Error Catalog` (`VideoNotFoundException`, `VideoTooLargeException`, `VideoUploadNotInProgressException`, `InvalidUploadPartsException`, `UploadSizeMismatchException`, `VideoNotReadyException`) com `errorCode`, HTTP e mensagem exatamente como no catálogo (per `phase-02-auth/TD-07`)
3. Criar `src/videos/videos.service.ts` com `initiateUpload(userId, dto)`: resolve o canal do usuário via `ChannelsService` (adicionando `findByUserId` se ainda não existir — a entidade `Channel` continua sob `ChannelsModule`); rejeita `size_bytes > VIDEO_MAX_UPLOAD_BYTES` com `VIDEO_TOO_LARGE`; deriva `title` do nome sem extensão truncado a 100 caracteres (AMB-3); gera `public_id` com retry em violação de unique; calcula `part_size_bytes`/`part_count` pela fórmula do contrato; chama `StorageService.createMultipartUpload` com `original_key = videos/{public_id}/original` e persiste o rascunho com `upload_id` (per `phase-03-upload-processing/TD-01`, `phase-03-upload-processing/TD-07`, `phase-03-upload-processing/TD-12`)
4. Criar `src/videos/videos.controller.ts` com `POST /videos` retornando 201 no shape de `### API Contracts → POST /videos`, usando `@CurrentUser()` e decoradores explícitos `@ApiOperation`, `@ApiBody`, `@ApiResponse` por status (201, 400, 401, 413) com o envelope de erro de `phase-02-auth/TD-07` (per `openapi-docs-nestjs/TD-01`)
5. Importar `StorageModule` e `ChannelsModule` no `VideosModule` e declarar controller e service

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit (mocks de repositório, `ChannelsService` e `StorageService`): limite excedido lança `VideoTooLargeException` sem chamar o storage; título derivado e truncado; `part_size_bytes` mínimo de 5242880 e `part_count` ≤ 10000 para 10 GB; retry de `public_id` após violação de unique | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (Postgres + MinIO reais): rascunho persistido com `status = 'uploading'`, `channel_id` do usuário e `upload_id` que aceita `listParts` no MinIO | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test com `StorageModule`, `ChannelsModule` e filas registradas | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 — `StorageService.createMultipartUpload`; SI-03.4 — entidade `Video` e `generatePublicId`

**Acceptance criteria:**

- `POST /videos` autenticado com `{ filename: "Minhas Férias.mov", content_type: "video/quicktime", size_bytes: 6291456 }` retorna `201` com `public_id` de 11 caracteres base62, `title: "Minhas Férias"`, `status: "uploading"`, `part_size_bytes: 5242880` e `part_count: 2`
- Após a chamada, existe um registro em `videos` com `status = 'uploading'`, `channel_id` igual ao canal do usuário e `upload_id` não nulo
- `POST /videos` com `size_bytes` acima de `VIDEO_MAX_UPLOAD_BYTES` retorna `413` com `error: "VIDEO_TOO_LARGE"` e nenhum registro é criado
- `POST /videos` com `content_type: "image/png"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem access token retorna `401`
- Para `size_bytes = 10737418240` (com o limite de produção), `part_count` é ≤ 10000

---

### SI-03.8 — Endpoints de URLs de Partes e Listagem para Retomada

**Route:** POST /videos/:publicId/upload/part-urls, GET /videos/:publicId/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner (não dono recebe 404)

**Description:** Permitir que o cliente envie as partes direto ao storage e retome o upload após falha de conexão, emitindo URLs pré-assinadas por lote e listando as partes já recebidas.

**Technical actions:**

1. Criar `src/videos/dto/create-part-urls.dto.ts` com `part_numbers` conforme `### API Contracts → POST /videos/:publicId/upload/part-urls` e as `Validation Rules`
2. Adicionar a `VideosService` o lookup `findOwnedByPublicId(userId, publicId)` — busca por `public_id` com `channel_id` do canal do usuário e lança `VideoNotFoundException` tanto para inexistente quanto para vídeo de outro canal (AMB-1, AMB-2)
3. Adicionar `createPartUrls(userId, publicId, dto)` — exige `status = 'uploading'` (senão `VIDEO_UPLOAD_NOT_IN_PROGRESS`), rejeita `part_number > part_count` com erro de validação e assina cada parte com `StorageService.presignUploadPart` usando `VIDEO_UPLOAD_PART_URL_TTL_SECONDS`, devolvendo `parts[]` e `expires_at` (per `phase-03-upload-processing/TD-01`)
4. Adicionar `listUploadedParts(userId, publicId)` — exige `status = 'uploading'` e mapeia `StorageService.listParts` para `{ part_number, etag, size_bytes }` (per `phase-03-upload-processing/TD-01`)
5. Adicionar ao `VideosController` `POST /videos/:publicId/upload/part-urls` (200) e `GET /videos/:publicId/upload/parts` (200) com `@ApiOperation`, `@ApiParam`, `@ApiBody` e `@ApiResponse` para 200, 400, 401, 404 e 409 (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createPartUrls` / `listUploadedParts` / `findOwnedByPublicId` | Unit: vídeo de outro canal lança `VideoNotFoundException`; status diferente de `'uploading'` lança `VideoUploadNotInProgressException`; `part_number` acima de `part_count` é rejeitado; `expires_at` respeita o TTL configurado | `src/videos/videos.service.spec.ts` |
| `VideosService.createPartUrls` / `listUploadedParts` | Integration (Postgres + MinIO reais): `PUT` de uma parte sintética de 5 MiB na URL emitida é aceito pelo MinIO e a parte aparece em `listUploadedParts` com `size_bytes = 5242880` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.7 — rascunho com `upload_id` e `VideosController`

**Acceptance criteria:**

- `POST /videos/:publicId/upload/part-urls` pelo dono com `{ part_numbers: [1, 2] }` retorna `200` com duas entradas `{ part_number, url }` e `expires_at` no futuro
- Um `PUT` de 5 MiB na `url` da parte 1 retorna `200` do storage com header `ETag`
- `GET /videos/:publicId/upload/parts` após esse `PUT` retorna `200` com `[{ part_number: 1, etag, size_bytes: 5242880 }]`
- As duas rotas chamadas por outro usuário autenticado retornam `404` com `error: "VIDEO_NOT_FOUND"`, igual a um `public_id` inexistente
- `POST /videos/:publicId/upload/part-urls` com `part_numbers` de 101 itens retorna `400` com `error: "VALIDATION_ERROR"`
- As duas rotas para um vídeo em `status = 'processing'` retornam `409` com `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"`

---

### SI-03.9 — Endpoint de Conclusão do Upload e Enfileiramento

**Route:** POST /videos/:publicId/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner (não dono recebe 404)

**Description:** Concluir o multipart pela API, validar tamanho real e posse antes de gastar CPU e enfileirar o processamento de forma idempotente.

**Technical actions:**

1. Criar `src/videos/dto/complete-video-upload.dto.ts` com `parts[]` (`part_number`, `etag`) conforme `### API Contracts → POST /videos/:publicId/upload/complete` e as `Validation Rules`
2. Adicionar a `VideosService` `completeUpload(userId, publicId, dto)`: exige `status = 'uploading'`; chama `StorageService.completeMultipartUpload` ordenando `parts` por `part_number` e traduz o erro tipado de partes inválidas em `INVALID_UPLOAD_PARTS` (rascunho continua `'uploading'` para nova tentativa) (per `phase-03-upload-processing/TD-06`)
3. Na mesma operação, validar `StorageService.headObject(original_key).ContentLength`: acima de `VIDEO_MAX_UPLOAD_BYTES` remove objeto e rascunho e lança `VIDEO_TOO_LARGE`; diferente de `size_bytes` remove objeto e rascunho e lança `UPLOAD_SIZE_MISMATCH` (per `phase-03-upload-processing/TD-06`, `phase-03-upload-processing/TD-12`)
4. Com o tamanho válido, persistir `status = 'processing'`, `upload_completed_at = now()` e `upload_id = null`, e publicar `VIDEO_JOBS.PROCESS` em `video-processing` com payload `{ videoId }`, `jobId = videoId`, `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` e `removeOnComplete`, conforme `### Events/Messages` (per `phase-03-upload-processing/TD-03`, `phase-03-upload-processing/TD-06`)
5. Adicionar ao `VideosController` `POST /videos/:publicId/upload/complete` retornando `202` com `{ public_id, status }` e decoradores `@ApiOperation`, `@ApiParam`, `@ApiBody`, `@ApiResponse` para 202, 400, 401, 404, 409, 413 e 422 (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (mocks de repositório, storage e fila): partes inválidas lançam `InvalidUploadPartsException` sem mudar status; tamanho acima do limite remove objeto e rascunho; divergência de tamanho lança `UploadSizeMismatchException`; sucesso publica job com `jobId = videoId`; status diferente de `'uploading'` lança `VideoUploadNotInProgressException` sem tocar o storage | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (Postgres + MinIO + Redis reais, limite de teste de 12 MiB): upload real de 5 MiB + 1 MiB via URLs pré-assinadas → complete → vídeo `'processing'` e job `process` presente na fila com `jobId` igual ao `id`; upload de 5 MiB × 3 com `size_bytes` declarado acima do limite do teste é rejeitado e o objeto não existe no bucket | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.8 — URLs de partes para o upload real; SI-03.5 — fila `video-processing` registrada

**Acceptance criteria:**

- `POST /videos/:publicId/upload/complete` pelo dono com as partes corretas retorna `202` com `{ public_id, status: "processing" }`, e o registro passa a ter `upload_completed_at` preenchido e `upload_id` nulo
- Após o complete, existe um job `process` em `video-processing` com payload `{ videoId }` e `jobId` igual ao `id` do vídeo
- Repetir o complete para o mesmo vídeo retorna `409` com `error: "VIDEO_UPLOAD_NOT_IN_PROGRESS"` e não cria um segundo job
- Complete com uma `etag` incorreta retorna `400` com `error: "INVALID_UPLOAD_PARTS"` e o vídeo permanece `'uploading'`
- Complete cujo objeto final tem tamanho diferente de `size_bytes` retorna `422` com `error: "UPLOAD_SIZE_MISMATCH"`, e o objeto e o rascunho deixam de existir
- Complete chamado por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.10 — Consumer de Processamento do Vídeo

**Description:** Consumir `video-processing` no Video Worker para extrair metadados, normalizar o vídeo para reprodução, gerar a thumbnail e registrar o resultado (`ready` ou `failed` com motivo).

**Technical actions:**

1. Criar `src/worker/video-processing.consumer.ts` — `@Processor('video-processing')` estendendo `WorkerHost`; `process(job)` carrega o `Video` por `job.data.videoId`, ignora vídeos já `'ready'` (idempotência at-least-once) e trabalha num diretório temporário exclusivo removido em `finally` (per `phase-03-upload-processing/TD-03`, `phase-03-upload-processing/TD-04`)
2. No `process`: `StorageService.downloadToFile(original_key)` (objeto ausente → `failed`/`'SOURCE_MISSING'` + `UnrecoverableError`) → `MediaService.probe` (`InvalidMediaError` → `failed`/`'INVALID_MEDIA'` + `UnrecoverableError`) → `MediaService.normalize` → `MediaService.extractThumbnail`, atualizando `job.updateProgress` a cada etapa (per `phase-03-upload-processing/TD-05`, `phase-03-upload-processing/TD-08`)
3. Enviar `playback.mp4` para `videos/{public_id}/playback.mp4` (`Content-Type: video/mp4`) e a thumbnail para `thumbnails/{randomBytes(16) em hex}.jpg` (`Content-Type: image/jpeg`, `Cache-Control: public, max-age=31536000, immutable`); persistir `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `playback_key`, `thumbnail_key`, `processed_at` e `status = 'ready'` (per `phase-03-upload-processing/TD-08`, `phase-03-upload-processing/TD-11`)
4. Adicionar `@OnWorkerEvent('failed')` que, quando `job.attemptsMade >= job.opts.attempts` e o vídeo ainda não está `'failed'`, persiste `status = 'failed'`, `failure_reason = 'PROCESSING_ERROR'` e `processed_at` (per `phase-03-upload-processing/TD-03`)
5. Registrar `VideoProcessingConsumer`, `MediaModule` e `TypeOrmModule.forFeature([Video])` no `WorkerModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingConsumer` | Integration (Postgres + MinIO + FFmpeg reais, fixtures da SI-03.2, `process` chamado com job de teste): `mkv-hevc-aac` termina `'ready'` com metadados, `playback.mp4` H.264/AAC no bucket e thumbnail acessível anonimamente; `truncated` termina `'failed'`/`'INVALID_MEDIA'` lançando `UnrecoverableError`; objeto original ausente termina `'failed'`/`'SOURCE_MISSING'`; reprocessar vídeo `'ready'` não altera chaves | `src/worker/video-processing.consumer.integration-spec.ts` |
| `VideoProcessingConsumer` | Unit (mocks): handler `failed` só marca `PROCESSING_ERROR` na última tentativa; diretório temporário é removido mesmo quando `normalize` falha | `src/worker/video-processing.consumer.spec.ts` |

**Dependencies:** SI-03.9 — jobs publicados com o payload definido; SI-03.5 — `WorkerModule` e fila; SI-03.6 — `MediaService`

**Acceptance criteria:**

- Um vídeo `mkv-hevc-aac` concluído pelo fluxo de upload passa de `'processing'` para `'ready'` com `duration_seconds` ≈ 2, `width = 320`, `height = 240`, `video_codec = 'hevc'` e `audio_codec = 'aac'`
- Após o processamento, `ffprobe` sobre o objeto `videos/{public_id}/playback.mp4` reporta `h264` e `aac` com o átomo `moov` antes de `mdat`
- `GET` anônimo em `{STORAGE_ENDPOINT}/{bucket}/{thumbnail_key}` retorna `200` com `Content-Type: image/jpeg` e `Cache-Control` contendo `immutable`
- Um upload cujo conteúdo não é vídeo termina com `status = 'failed'` e `failure_reason = 'INVALID_MEDIA'` sem novas tentativas
- Uma falha transitória do FFmpeg nas 3 tentativas termina com `status = 'failed'` e `failure_reason = 'PROCESSING_ERROR'`
- Nenhum arquivo temporário do processamento permanece no container `video-worker` após um job, com sucesso ou com falha

---

### SI-03.11 — Endpoint GET /videos/:publicId (Detalhe para o Dono)

**Route:** GET /videos/:publicId
**Test Specs:** see `nestjs-project/specs/videos-detail.plan.md`
**Authorization:** Owner (não dono recebe 404)

**Description:** Expor ao dono o estado do vídeo e os metadados extraídos, para acompanhar o processamento, incluindo a URL pública estável da thumbnail.

**Technical actions:**

1. Criar `src/videos/dto/video-response.dto.ts` com os campos de `### API Contracts → GET /videos/:publicId` (sem expor `id`, `channel_id`, `upload_id` nem chaves internas de vídeo) e decoradores `@ApiProperty` com nulabilidade explícita (per `openapi-docs-nestjs/TD-01`)
2. Adicionar a `VideosService` `getOwnedVideo(userId, publicId)` reutilizando `findOwnedByPublicId` e montando `thumbnail_url` como `{STORAGE_PUBLIC_ENDPOINT}/{STORAGE_BUCKET}/{thumbnail_key}` quando `thumbnail_key` não é nulo (per `phase-03-upload-processing/TD-11`)
3. Adicionar ao `VideosController` `GET /videos/:publicId` retornando `200` e decoradores `@ApiOperation`, `@ApiParam`, `@ApiResponse` para 200, 401 e 404 (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwnedVideo` | Unit: `thumbnail_url` nulo sem `thumbnail_key` e montado com endpoint público quando presente; `size_bytes` e `duration_seconds` serializados como número | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.7 — `VideosController`, `VideosService` e rascunhos persistidos

**Acceptance criteria:**

- `GET /videos/:publicId` pelo dono de um rascunho retorna `200` com `status: "uploading"`, `thumbnail_url: null` e metadados nulos
- `GET /videos/:publicId` pelo dono de um vídeo processado retorna `200` com `status: "ready"`, `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` e `thumbnail_url` acessível anonimamente
- `GET /videos/:publicId` de um vídeo `'failed'` retorna `200` com `failure_reason` preenchido
- `GET /videos/:publicId` por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`, igual a um `public_id` inexistente
- A resposta nunca contém `id`, `channel_id`, `upload_id`, `original_key` ou `playback_key`

---

### SI-03.12 — Endpoints de Streaming e Download

**Route:** GET /videos/:publicId/stream, GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-stream-download.plan.md`
**Authorization:** Owner (não dono recebe 404)

**Description:** Entregar reprodução por streaming e download sem que os bytes passem pela API, emitindo URLs pré-assinadas curtas para o artefato normalizado e para o arquivo original.

**Technical actions:**

1. Criar `src/videos/dto/video-stream-response.dto.ts` e `src/videos/dto/video-download-response.dto.ts` com os campos de `### API Contracts → GET /videos/:publicId/stream` e `→ GET /videos/:publicId/download` (per `openapi-docs-nestjs/TD-01`)
2. Adicionar a `VideosService` `getStreamUrl(userId, publicId)` — exige `status = 'ready'` (senão `VIDEO_NOT_READY`) e assina `playback_key` com `StorageService.presignGetObject` usando `VIDEO_PLAYBACK_URL_TTL_SECONDS`, devolvendo `content_type: 'video/mp4'` (per `phase-03-upload-processing/TD-09`, `phase-03-upload-processing/TD-08`)
3. Adicionar `getDownloadUrl(userId, publicId)` — exige `status = 'ready'` e assina `original_key` com `responseContentDisposition` `attachment; filename="{ascii fallback}"; filename*=UTF-8''{original_filename codificado}` (AMB-1) (per `phase-03-upload-processing/TD-09`)
4. Adicionar ao `VideosController` `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` retornando `200` e decoradores `@ApiOperation`, `@ApiParam`, `@ApiResponse` para 200, 401, 404 e 409 (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl` / `getDownloadUrl` | Unit: cada status diferente de `'ready'` lança `VideoNotReadyException`; `Content-Disposition` com nome acentuado gera fallback ASCII e `filename*` UTF-8; TTL aplicado em `expires_at` | `src/videos/videos.service.spec.ts` |
| `VideosService.getStreamUrl` / `getDownloadUrl` | Integration (Postgres + MinIO reais, vídeo `'ready'` com objetos gravados): `GET` com `Range: bytes=0-1023` na URL de stream retorna 206; `GET` na URL de download retorna `Content-Disposition: attachment` com o nome original | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.10 — `playback_key` gravado pelo processamento; SI-03.11 — `findOwnedByPublicId` e DTOs de vídeo

**Acceptance criteria:**

- `GET /videos/:publicId/stream` pelo dono de um vídeo `'ready'` retorna `200` com `url`, `expires_at` e `content_type: "video/mp4"`
- Um `GET` com `Range: bytes=0-1023` na `url` de stream retorna `206` com 1024 bytes, sem passar pela API
- `GET /videos/:publicId/download` pelo dono retorna `200` com `url` e `filename`, e um `GET` nessa `url` retorna o arquivo original com `Content-Disposition: attachment`
- As duas rotas para um vídeo `'uploading'`, `'processing'` ou `'failed'` retornam `409` com `error: "VIDEO_NOT_READY"`
- As duas rotas chamadas por outro usuário autenticado retornam `404` com `error: "VIDEO_NOT_FOUND"`
- Uma `url` usada após `expires_at` é recusada pelo storage com `403`

---

### SI-03.13 — Job Agendado de Limpeza de Rascunhos Expirados

**Description:** Remover rascunhos cujo upload foi abandonado antes do complete, abortando o multipart correspondente, com o lifecycle do bucket cobrindo partes órfãs sem registro.

**Technical actions:**

1. Criar `src/worker/video-maintenance.scheduler.ts` (`OnApplicationBootstrap` no `WorkerModule`) que chama `queue.upsertJobScheduler('expire-drafts', { every: 3600000 }, { name: VIDEO_JOBS.EXPIRE_DRAFTS })` na fila `video-maintenance` — idempotente entre reinícios (per `phase-03-upload-processing/TD-10`, `phase-03-upload-processing/TD-03`)
2. Criar `src/worker/video-maintenance.consumer.ts` — `@Processor('video-maintenance')`; busca vídeos com `status = 'uploading'` e `created_at < now - VIDEO_DRAFT_TTL_HOURS` (usa o índice `(status, created_at)`) em lotes (per `phase-03-upload-processing/TD-10`)
3. Para cada rascunho expirado, chamar `StorageService.abortMultipartUpload(original_key, upload_id)` (`NoSuchUpload` já tratado como sucesso) e remover o registro; falha num item é registrada em log e não interrompe o lote (per `phase-03-upload-processing/TD-10`)
4. Registrar `VideoMaintenanceScheduler` e `VideoMaintenanceConsumer` no `WorkerModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoMaintenanceConsumer` | Integration (Postgres + MinIO reais): rascunho com `created_at` retroativo além do TTL e multipart real aberto é removido e o `upload_id` deixa de existir no MinIO; rascunho recente e vídeos `'processing'`/`'ready'` antigos permanecem; segunda execução não falha | `src/worker/video-maintenance.consumer.integration-spec.ts` |
| `VideoMaintenanceScheduler` | Integration (Redis real): bootstrap duas vezes resulta em um único job scheduler `expire-drafts` | `src/worker/video-maintenance.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.5 — `WorkerModule` e fila `video-maintenance`; SI-03.7 — rascunhos com `upload_id`

**Acceptance criteria:**

- Um rascunho `'uploading'` com `created_at` anterior a `VIDEO_DRAFT_TTL_HOURS` é removido da tabela `videos` após a execução do job, e `ListParts` do seu `upload_id` retorna `NoSuchUpload`
- Um rascunho `'uploading'` criado dentro do prazo não é alterado
- Vídeos antigos em `'processing'`, `'ready'` ou `'failed'` não são alterados
- Reiniciar o `video-worker` mantém exatamente um job scheduler `expire-drafts` no Redis
- Um rascunho cujo multipart já foi abortado pelo storage é removido sem erro

---

### SI-03.14 — Regenerar o Artefato OpenAPI com os Endpoints de Vídeo

**Description:** Manter o contrato versionado em dia com os novos endpoints e o envelope de erro, preservando a fonte que o frontend consome quando entrar numa fatia futura.

**Technical actions:**

1. Rodar o script de exportação existente (`src/openapi-export.ts`) dentro do container e versionar o `openapi.json` gerado do `nestjs-project` com os 7 endpoints de `### API Contracts` (per `openapi-docs-nestjs/TD-02`)
2. Conferir que cada operação de vídeo documenta request, respostas por status e o schema de erro compartilhado (`api-error-envelope.dto.ts`) conforme a revisão de `openapi-docs-nestjs/TD-01`; ajustar decoradores nas SIs de controller se faltar algo (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Exportação OpenAPI | Integration: suíte existente verifica que o documento exportado inclui `/videos`, `/videos/{publicId}/upload/part-urls`, `/videos/{publicId}/upload/parts`, `/videos/{publicId}/upload/complete`, `/videos/{publicId}`, `/videos/{publicId}/stream` e `/videos/{publicId}/download` | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.9, SI-03.11, SI-03.12 — todos os endpoints de vídeo implementados

**Acceptance criteria:**

- O `openapi.json` versionado contém as 7 operações de vídeo com os status codes de `### API Contracts`
- As respostas 4xx das operações de vídeo referenciam o schema do envelope `{ statusCode, error, message }`
- Rodar a exportação novamente sem mudanças de código não gera diff no `openapi.json`

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos` (entidade `Video`, módulo `VideosModule`).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Identificador interno; nunca exposto em URL *(per phase-03-upload-processing/TD-07)* |
| public_id | varchar(16) | unique, not null | ID curto base62 aleatório gerado na aplicação; usado em todas as rotas públicas *(per phase-03-upload-processing/TD-07)* |
| channel_id | uuid | FK → channels.id, not null | Dono do vídeo é o canal (clarificação AMB-3) |
| title | varchar(100) | not null | Inicialmente derivado do nome do arquivo sem extensão, truncado a 100 caracteres (AMB-3) |
| description | text | nullable | Preenchida na Fase 04 |
| status | enum | not null, default `'uploading'`, values: `'uploading'`, `'processing'`, `'ready'`, `'failed'` | PostgreSQL enum type (AMB-4) |
| failure_reason | text | nullable | Motivo persistido quando `status = 'failed'` (AMB-4) |
| original_filename | varchar(255) | not null | Nome enviado pelo cliente; usado no `Content-Disposition` do download (AMB-1) |
| mime_type | varchar(100) | not null | Declarado no início do upload |
| size_bytes | bigint | not null | Declarado no início; confirmado por `HeadObject.ContentLength` na conclusão *(per phase-03-upload-processing/TD-06)* |
| original_key | varchar(512) | not null | Chave do arquivo original no bucket (`videos/{public_id}/original`) |
| upload_id | varchar(1024) | nullable | `UploadId` do multipart; limpo após o complete *(per phase-03-upload-processing/TD-01)* |
| playback_key | varchar(512) | nullable | MP4 H.264/AAC com `+faststart` (`videos/{public_id}/playback.mp4`) *(per phase-03-upload-processing/TD-08)* |
| thumbnail_key | varchar(512) | nullable | Chave imprevisível e imutável sob `thumbnails/` *(per phase-03-upload-processing/TD-11)* |
| duration_seconds | numeric(10,3) | nullable | Extraído via `ffprobe` (AMB-4) |
| width | integer | nullable | AMB-4 |
| height | integer | nullable | AMB-4 |
| video_codec | varchar(50) | nullable | Codec do arquivo original (AMB-4) |
| audio_codec | varchar(50) | nullable | Codec do arquivo original; null quando não há faixa de áudio (AMB-4) |
| upload_completed_at | timestamp | nullable | Momento do complete bem-sucedido |
| processed_at | timestamp | nullable | Momento em que o processamento terminou (`ready` ou `failed`) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn`; base do prazo de rascunhos expirados *(per phase-03-upload-processing/TD-10)* |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel → Video (one-to-many, lado inverso adicionado em `Channel`)
**Indexes:** `(public_id)` — unique, `(channel_id)` — FK, `(status, created_at)` — composite para o job de rascunhos expirados

---

### API Contracts

Todas as rotas usam o `public_id` (TD-07) e exigem `Authorization: Bearer <access_token>` (guard JWT global herdado de phase-02-auth). Recurso de outro canal responde **404 `VIDEO_NOT_FOUND`**, nunca 403, para não revelar existência (AMB-1, AMB-2). Formato de erro herdado: `{ statusCode, error, message }` (phase-02-auth/TD-07). Os bytes de vídeo nunca trafegam pela API: o cliente envia as partes direto ao storage via URL pré-assinada *(per phase-03-upload-processing/TD-01)*.

#### POST /videos (SI-03.7)

Inicia o upload: cria o rascunho (`status = 'uploading'`) e o multipart no storage (`CreateMultipartUpload`).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- filename: string, required — 1 a 255 caracteres
- content_type: string, required — deve começar com `video/`
- size_bytes: integer, required — ≥ 1 e ≤ `VIDEO_MAX_UPLOAD_BYTES` (padrão 10737418240)

**Response 201:**
- public_id: string (base62)
- title: string
- status: `'uploading'`
- part_size_bytes: integer — `max(5242880, ceil(size_bytes / 10000))`, arredondado para cima em múltiplo de 1 MiB
- part_count: integer — `ceil(size_bytes / part_size_bytes)` (≤ 10000)

**Error responses:**
- 413 VIDEO_TOO_LARGE: quando `size_bytes` excede `VIDEO_MAX_UPLOAD_BYTES`
- 400 validation error: quando o body falha na validação
- 401: access token ausente ou inválido

---

#### POST /videos/:publicId/upload/part-urls (SI-03.8)

Emite URLs pré-assinadas de `UploadPart` para um lote de partes (retomável: o cliente pede só as partes que faltam).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1 a 100 itens, cada um entre 1 e `part_count`, sem repetição

**Response 200:**
- parts: array of `{ part_number: integer, url: string }`
- expires_at: string (ISO-8601) — `now + VIDEO_UPLOAD_PART_URL_TTL_SECONDS`

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: quando `status != 'uploading'`
- 400 validation error: quando o body falha na validação ou algum `part_number` > `part_count`

---

#### GET /videos/:publicId/upload/parts (SI-03.8)

Lista as partes já recebidas pelo storage (`ListParts`) para retomada após falha de conexão.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- parts: array of `{ part_number: integer, etag: string, size_bytes: integer }`

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: quando `status != 'uploading'`

---

#### POST /videos/:publicId/upload/complete (SI-03.9)

Conclui o multipart, valida o tamanho real e enfileira o processamento *(per phase-03-upload-processing/TD-06)*.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required — 1 a 10000 itens de `{ part_number: integer ≥ 1, etag: string não vazia }`

**Response 202:**
- public_id: string
- status: `'processing'`

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: quando `status != 'uploading'` (inclui complete repetido)
- 400 INVALID_UPLOAD_PARTS: quando o storage rejeita a lista de partes (parte ausente, ETag divergente, ordem inválida ou parte intermediária < 5 MB)
- 422 UPLOAD_SIZE_MISMATCH: quando `HeadObject.ContentLength` difere de `size_bytes` declarado
- 413 VIDEO_TOO_LARGE: quando `HeadObject.ContentLength` excede `VIDEO_MAX_UPLOAD_BYTES` (objeto é removido)
- 400 validation error: quando o body falha na validação

---

#### GET /videos/:publicId (SI-03.11)

Detalhe do vídeo para o dono (acompanhar status do processamento).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- public_id: string
- title: string
- status: `'uploading' | 'processing' | 'ready' | 'failed'`
- failure_reason: string | null
- original_filename: string
- mime_type: string
- size_bytes: integer
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- audio_codec: string | null
- thumbnail_url: string | null — URL pública estável `{STORAGE_PUBLIC_ENDPOINT}/{STORAGE_BUCKET}/{thumbnail_key}` *(per phase-03-upload-processing/TD-11)*
- created_at: string (ISO-8601)
- processed_at: string (ISO-8601) | null

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal

---

#### GET /videos/:publicId/stream (SI-03.12)

Emite URL pré-assinada de `GetObject` do artefato de reprodução; o navegador faz Range requests direto ao storage *(per phase-03-upload-processing/TD-09, TD-08)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — assinada com o client de endpoint público
- expires_at: string (ISO-8601) — `now + VIDEO_PLAYBACK_URL_TTL_SECONDS`
- content_type: `'video/mp4'`

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_READY: quando `status` é `'uploading'`, `'processing'` ou `'failed'` (AMB-2)

---

#### GET /videos/:publicId/download (SI-03.12)

Emite URL pré-assinada do **arquivo original** com `ResponseContentDisposition=attachment` (AMB-1) *(per phase-03-upload-processing/TD-09)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — assinada com o client de endpoint público
- expires_at: string (ISO-8601) — `now + VIDEO_PLAYBACK_URL_TTL_SECONDS`
- filename: string — `original_filename`

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_READY: quando `status != 'ready'`

#### Validation Rules — Upload de vídeos

| Field | Rule | Error message |
|-------|------|---------------|
| filename | String, 1 a 255 caracteres | filename must be shorter than or equal to 255 characters |
| content_type | String com prefixo `video/` | content_type must match /^video\// regular expression |
| size_bytes | Inteiro ≥ 1 | size_bytes must not be less than 1 |
| part_numbers | Array de 1 a 100 inteiros ≥ 1, únicos | part_numbers must contain no more than 100 elements |
| parts | Array de 1 a 10000 itens `{ part_number, etag }` | parts must contain at least 1 elements |

---

### Authorization Matrix

| Endpoint | Public | Authenticated (não dono) | Owner | Notes |
|----------|--------|--------------------------|-------|-------|
| POST /videos | | ✓ | — | Vídeo criado no canal do usuário autenticado |
| POST /videos/:publicId/upload/part-urls | | ✗ (404) | ✓ | |
| GET /videos/:publicId/upload/parts | | ✗ (404) | ✓ | |
| POST /videos/:publicId/upload/complete | | ✗ (404) | ✓ | |
| GET /videos/:publicId | | ✗ (404) | ✓ | |
| GET /videos/:publicId/stream | | ✗ (404) | ✓ | Público/anônimo só a partir das Fases 04/05 (AMB-2) |
| GET /videos/:publicId/download | | ✗ (404) | ✓ | Público/anônimo só a partir da Fase 05 (AMB-1) |
| Objeto `thumbnails/*` no storage | ✓ | ✓ | ✓ | Leitura anônima só por chave exata; prefixo não listável *(per phase-03-upload-processing/TD-11)* |

---

### Error Catalog

Formato herdado de phase-02-auth/TD-07: `{ statusCode: number, error: string, message: string }`. Novos códigos são subclasses de `DomainException` em `src/common/exceptions/` ou no módulo `videos`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Qualquer rota `/videos/:publicId` com `public_id` inexistente **ou** pertencente a outro canal |
| VIDEO_TOO_LARGE | 413 | Video exceeds the maximum upload size | `POST /videos` com `size_bytes` > `VIDEO_MAX_UPLOAD_BYTES`, ou complete cujo `HeadObject.ContentLength` excede o limite |
| VIDEO_UPLOAD_NOT_IN_PROGRESS | 409 | Video upload is not in progress | part-urls, list parts ou complete quando `status != 'uploading'` |
| INVALID_UPLOAD_PARTS | 400 | Uploaded parts are invalid or incomplete | `CompleteMultipartUpload` rejeitado pelo storage (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded size does not match the declared size | `HeadObject.ContentLength` ≠ `size_bytes` declarado no início |
| VIDEO_NOT_READY | 409 | Video is not ready | `GET /videos/:publicId/stream` ou `/download` com `status` em `'uploading'`, `'processing'` ou `'failed'` (AMB-2) |

Falhas de processamento **não** geram resposta HTTP: o worker persiste `status = 'failed'` e `failure_reason` com um dos valores `'INVALID_MEDIA'` (ffprobe não reconhece o arquivo ou não há stream de vídeo), `'PROCESSING_ERROR'` (falha do FFmpeg após esgotar as tentativas) ou `'SOURCE_MISSING'` (objeto original ausente no storage).

---

### Events/Messages

#### video-processing → job `process`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` na API, após `CompleteMultipartUpload` + `HeadObject` + transição para `'processing'`, com `jobId = videoId` para idempotência de complete repetido (per `phase-03-upload-processing/TD-03`, `phase-03-upload-processing/TD-06`)
**Consumer:** `VideoProcessingConsumer` (`@Processor('video-processing')`, `WorkerHost`) registrado **somente** no `WorkerModule` do container `video-worker` (per `phase-03-upload-processing/TD-04`)
**Trigger:** upload concluído e validado pelo endpoint de conclusão
**Processing:** baixa o original para diretório temporário → `ffprobe` JSON (duração, dimensões, codecs) → normaliza para MP4 H.264/AAC com `-movflags +faststart` (remux quando os codecs já são compatíveis, transcodificação caso contrário) → extrai um frame como JPEG → envia `playback.mp4` e a thumbnail (`thumbnails/{random}.jpg`, `Cache-Control: public, max-age=31536000, immutable`) → persiste metadados, chaves, `processed_at` e `status = 'ready'` → remove temporários (per `phase-03-upload-processing/TD-05`, `phase-03-upload-processing/TD-08`, `phase-03-upload-processing/TD-11`)
**Delivery semantics:** at-least-once; `attempts: 3` com `backoff: { type: 'exponential', delay: 5000 }`; mídia inválida lança `UnrecoverableError` (sem retry) e persiste `failed`/`INVALID_MEDIA`; esgotar tentativas persiste `failed`/`PROCESSING_ERROR` via `@OnWorkerEvent('failed')`; o consumer é idempotente (sobrescreve as mesmas chaves e ignora vídeos já `ready`) (per `phase-03-upload-processing/TD-03`)

#### video-maintenance → job `expire-drafts`

**Payload:**

```json
{}
```

**Producer:** job scheduler `expire-drafts` criado com `queue.upsertJobScheduler('expire-drafts', { every: <ms> }, { name: 'expire-drafts' })` no bootstrap do worker (per `phase-03-upload-processing/TD-10`)
**Consumer:** `VideoMaintenanceConsumer` (`@Processor('video-maintenance')`) no `WorkerModule` (per `phase-03-upload-processing/TD-04`)
**Trigger:** periódico (padrão a cada 1 hora)
**Processing:** busca vídeos com `status = 'uploading'` e `created_at < now - VIDEO_DRAFT_TTL_HOURS`, chama `AbortMultipartUpload` (ignorando `NoSuchUpload`) e remove o registro; o lifecycle `AbortIncompleteMultipartUpload` do bucket (`VIDEO_MULTIPART_ABORT_DAYS`) cobre partes órfãs sem registro (per `phase-03-upload-processing/TD-10`)
**Delivery semantics:** at-least-once; idempotente (reexecução não encontra os rascunhos já removidos)

---

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — vídeos de teste precisam do FFmpeg e da chave VIDEO_MAX_UPLOAD_BYTES
│   └── SI-03.6 — wrapper do FFmpeg é testado com as fixtures geradas
├── SI-03.3 — StorageModule precisa das dependências AWS SDK, do namespace storage e do MinIO
│   └── SI-03.5 — worker e fila importam o StorageModule
└── SI-03.4 — entidade Video (independente de infra além do Postgres existente)

SI-03.3 + SI-03.4
└── SI-03.7 — início do upload cria rascunho e multipart
    ├── SI-03.8 — URLs de partes e listagem para retomada
    │   └── SI-03.9 — conclusão do upload (+ SI-03.5: enfileira na fila)
    │       └── SI-03.10 — consumer de processamento (+ SI-03.5 worker, + SI-03.6 FFmpeg)
    ├── SI-03.11 — detalhe do vídeo para o dono
    └── SI-03.13 — limpeza de rascunhos expirados (+ SI-03.5 worker e fila)

SI-03.10 + SI-03.11
└── SI-03.12 — streaming e download exigem playback_key e o lookup de dono

SI-03.9 + SI-03.11 + SI-03.12
└── SI-03.14 — artefato OpenAPI regenerado com todos os endpoints
```

Ordem linearizada: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (paralelo) → SI-03.5, SI-03.6, SI-03.7 (paralelo) → SI-03.8, SI-03.11 (paralelo) → SI-03.9, SI-03.13 (paralelo) → SI-03.10 → SI-03.12 → SI-03.14

---

## Deliverables

- [ ] SI-03.1 — Infra: Dependências, Configuração e Serviços de Storage, Fila e Worker
- [ ] SI-03.2 — Vídeos de Teste Gerados sob Demanda e Bytes Sintéticos
- [ ] SI-03.3 — StorageModule com Multipart, URLs Pré-assinadas e Bootstrap do Bucket
- [ ] SI-03.4 — Entidade Video, Migration e Gerador de public_id
- [ ] SI-03.5 — Infra: Fila BullMQ e Entrypoint do Video Worker
- [ ] SI-03.6 — Wrapper de FFmpeg/FFprobe para Metadados, Normalização e Thumbnail
- [ ] SI-03.7 — Endpoint POST /videos (Início do Upload)
- [ ] SI-03.8 — Endpoints de URLs de Partes e Listagem para Retomada
- [ ] SI-03.9 — Endpoint de Conclusão do Upload e Enfileiramento
- [ ] SI-03.10 — Consumer de Processamento do Vídeo
- [ ] SI-03.11 — Endpoint GET /videos/:publicId (Detalhe para o Dono)
- [ ] SI-03.12 — Endpoints de Streaming e Download
- [ ] SI-03.13 — Job Agendado de Limpeza de Rascunhos Expirados
- [ ] SI-03.14 — Regenerar o Artefato OpenAPI com os Endpoints de Vídeo

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
