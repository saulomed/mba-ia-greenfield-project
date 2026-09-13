# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 4/14 completed

### SI-03.1 — Infra: Dependências, Configuração e Serviços de Storage, Fila e Worker
- **Status:** completed
- **Tests:** 9 passing (`env.validation.integration-spec.ts`); E2E existente `GET /` passando
- **Observations:**
  - **Bloqueio (13/09/2026):** a imagem `minio/minio` exigida pela ação 4 não está mais disponível no Docker Hub (pull negado mesmo autenticado). A MinIO encerrou em 23/10/2025 a distribuição de binários e imagens da edição comunitária, e o repositório `minio/minio` foi arquivado em 25/04/2026; o caminho oficial passou a ser o AIStor Free, que exige arquivo de licença por instalação.
  - **Desvio do plano (TD-02), aprovado pelo usuário:** o serviço `minio` usa `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`, imagem congelada e sem patches, restrita ao ambiente de desenvolvimento. As portas `9000`/`9001` são publicadas apenas em `127.0.0.1`. O AIStor Free foi descartado porque exigiria uma licença por desenvolvedor, fora do repositório. A escolha do storage de produção fica em aberto e deve ser registrada na próxima revisão da TD-02.
  - Dependências instaladas: `@aws-sdk/client-s3@^3.1131.0`, `@aws-sdk/s3-request-presigner@^3.1131.0`, `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`.
  - As chaves novas foram adicionadas também ao `.env` local (fora do git); sem `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` a validação Joi rejeita o bootstrap.
  - Os configs `storage`, `queue` e `video` foram criados, mas ainda não entram no `load` do `ConfigModule` no `AppModule`, porque o plano não pede isso neste SI.
  - Critério de aceite pendente, por inconsistência do plano: o `video-worker` sai com `Missing script: "start:worker:dev"`, script criado só no SI-03.5. Os demais critérios foram verificados: MinIO e Redis saudáveis, console `localhost:9001` responde 200, `redis-cli ping` retorna `PONG`, `ffprobe` 5.1.9 disponível no `nestjs-api` e na imagem do `video-worker`.

### SI-03.2 — Vídeos de Teste Gerados sob Demanda e Bytes Sintéticos
- **Status:** completed
- **Tests:** 14 passing (`synthetic-bytes.spec.ts`: 4; `video-fixtures.integration-spec.ts`: 10)
- **Observations:**
  - `getVideoFixture` cacheia em `os.tmpdir()/streamtube-video-fixtures/{hash sha256 do nome + argumentos do ffmpeg}/fixture.{ext}`; a fixture `truncated` deriva de `mp4-h264-aac-no-faststart` cortando a metade final dos bytes (moov atom fica no fim sem faststart, então o corte garante falha no `ffprobe`).
  - `setup-env.ts` sobrescreve `VIDEO_MAX_UPLOAD_BYTES` incondicionalmente para `12582912` no processo Jest; para `STORAGE_PUBLIC_ENDPOINT = STORAGE_ENDPOINT`, a condição "quando não definidos explicitamente" do plano era ambígua (não dá para distinguir, depois do `dotenv/config`, um valor vindo do `.env` de um valor exportado explicitamente no shell). Após revisão (`/simplify`), removi o `if` condicional em favor de um valor sempre determinístico: `STORAGE_ENDPOINT` ganha fallback `http://minio:9000` e `STORAGE_PUBLIC_ENDPOINT` sempre iguala a ele no processo Jest, independente de haver `.env` no ambiente (CI sem `.env` também funciona).
  - Revisão `/simplify` (reuso, simplificação, eficiência, altitude) aplicada após os testes passarem: `video-fixtures.integration-spec.ts` passou a importar `ALL_VIDEO_FIXTURES` de `video-fixtures.ts` em vez de duplicar a lista de 6 nomes; `generateTruncated` em `video-fixtures.ts` trocou leitura manual (`open`/`read`/`writeFile`) por streaming (`createReadStream` com `end` + `createWriteStream` via `pipeline`). Achados descartados conscientemente: duplicar defaults entre Joi e os `registerAs` (convenção já existente em todo `src/config/*.ts`, fora do escopo deste diff); os três configs novos não estarem no `load` do `AppModule` (intencional, fora do escopo deste SI); o hash sha256 no nome do diretório de cache de fixture (remove-lo perderia a invalidação automática de cache quando os argumentos do `ffmpeg` mudam); duplicar `globalSetup`/`setupFiles` entre `package.json` e `test/jest-e2e.json` (exigido explicitamente pela ação 2 do SI-03.2 do plano); extrair um `FixtureSpec.generate()` genérico para o único caso `truncateFrom` (generalização prematura para um caso só).
  - `globalSetup` foi registrado tanto no jest config do `package.json` (`<rootDir>/test/global-setup.ts`, com `rootDir: src`) quanto em `test/jest-e2e.json` (`../src/test/global-setup.ts`, com `rootDir: .` relativo a `test/`); `setupFiles` de ambos ganhou `.../test/setup-env.ts` após `dotenv/config`.
  - Incidente de ambiente (não é código): `npx tsc --noEmit` falhou uma vez com `EACCES` em `dist/tsconfig.tsbuildinfo` por um `dist/` criado antes com outro uid; corrigido com `docker compose exec -u root nestjs-api chown -R node:node dist`, conforme o `CLAUDE.md` do projeto. Sem impacto em código de produção.

### SI-03.3 — StorageModule com Multipart, URLs Pré-assinadas e Bootstrap do Bucket
- **Status:** completed
- **Tests:** 11 passing (`storage.module.spec.ts`: 1; `storage.service.integration-spec.ts`: 5; `storage-bootstrap.service.integration-spec.ts`: 5); suíte completa 28 suites/174 testes, e2e 3 suites/52 testes, `tsc --noEmit` e `lint` limpos
- **Observations:**
  - `storageConfig` e `videoConfig` foram adicionados ao `load` do `ConfigModule` em `AppModule` (fechando a lacuna deixada intencionalmente pelo SI-03.1) e o novo `StorageModule` foi importado; `queueConfig` continua fora, pois nada o consome ainda.
  - Erros do SDK (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchKey`/`NotFound`, `NoSuchUpload`) são traduzidos em `StorageService` para `StorageInvalidPartsException`/`StorageObjectNotFoundException` — exceções simples (`extends Error`), deliberadamente **não** subclasses de `DomainException`: são erros internos do módulo de storage que um SI futuro (conclusão do upload, `videos` module) deve capturar e re-mapear para os códigos do Error Catalog (ex. `INVALID_UPLOAD_PARTS`); torná-las `DomainException` deixaria erros de storage vazarem como resposta HTTP genérica sem passar pela tradução de domínio.
  - Bug corrigido durante os testes: `storage.service.integration-spec.ts` não chamava `moduleRef.init()` após `compile()`, então o hook `OnApplicationBootstrap` (que cria o bucket) nunca disparava, causando `NoSuchBucket` em 5 testes — corrigido com `await moduleRef.init()` no `beforeAll`.
  - Bug de tipos corrigido: `Buffer`/`Uint8Array<ArrayBufferLike>` do `@types/node` não é estruturalmente compatível com `BodyInit` do `fetch` global (lib DOM), quebrando `tsc --noEmit`. Corrigido com um cast `as BodyInit` na fronteira (helper `toBody`), seguindo o padrão do projeto para conflitos de tipos de biblioteca.
  - Revisão `/simplify` aplicada: extraída `createS3Client(config, endpoint)` em `create-s3-client.ts`, reaproveitada nos dois providers de `storage.module.ts` e no teste de bootstrap (antes 3 construções manuais idênticas de `S3Client`); extraído `rethrowTranslated` em `storage.service.ts` para eliminar 3 blocos `try/catch` repetidos; nomeada a lista inline `['NoSuchUpload']`; `onApplicationBootstrap` agora aplica a lifecycle policy e a política de thumbnails em paralelo (`Promise.all`, ambas só dependem do bucket já existir, não uma da outra); `ensureBucketExists` trocou um `catch` genérico (tratava qualquer erro do `HeadBucketCommand` como "bucket não existe", violando a regra do projeto de nunca engolir erros) por uma checagem específica de `error.name === 'NotFound'` — validado empiricamente contra o MinIO real. Achado descartado conscientemente: `StorageException` não estender `DomainException` (ver acima, é a fronteira de tradução intencional do módulo).

### SI-03.4 — Entidade Video, Migration e Gerador de public_id
- **Status:** completed
- **Tests:** 8 passing (`src/videos/entities/video.entity.integration-spec.ts`: 4; `src/videos/public-id.util.spec.ts`: 4); suíte completa 30 suites/182 testes, e2e 3 suites/52 testes, `tsc --noEmit` e `lint` limpos nos arquivos tocados
- **Observations:**
  - `Video` criada com PK `uuid`, `public_id varchar(16)` unique, FK `channel_id → channels.id` (`ON DELETE NO ACTION`, mesma convenção de todas as FKs pré-existentes no projeto), enum `status` (`uploading`/`processing`/`ready`/`failed`, default `uploading`), e colunas `bigint`/`numeric(10,3)` com transformer para `number` — testado especificamente com `size_bytes = 10737418240` (10 GiB, acima de 2^31) indo e voltando como `number`.
  - Migration `CreateVideos1789324957302` gerada via `npm run migration:generate` (glob de `data-source.ts` detectou a entidade automaticamente); revisada sem edição manual do SQL. `src/database/migrations.integration-spec.ts` passou a rodar 3 migrations e a incluir `videos` em `MANAGED_TABLES`.
  - Bug pré-existente exposto e corrigido: o `beforeAll` de `migrations.integration-spec.ts` derrubava tabelas/tipos em paralelo via `Promise.all`; com o novo enum `videos_status_enum`, os `DROP` concorrentes disputavam locks de catálogo em ordens diferentes e o Postgres retornava `deadlock detected`. Trocado por um loop sequencial (`for...await`); o mesmo risco já existia antes com `verification_tokens_type_enum`, só não havia se manifestado.
  - `Channel` ganhou o lado inverso `@OneToMany(() => Video, (video) => video.channel)`. Como o TypeORM exige a metadata da entidade relacionada presente em qualquer `DataSource` de teste que inclua `Channel` (regra já documentada em `typeorm-migrations.md`, "Test DataSource Entity Arrays"), isso obrigou a adicionar `Video` ao array `ALL_ENTITIES` em 9 arquivos de teste pré-existentes (`channels/*`, `users/*`, `auth/*`) que não usam `Video` diretamente — efeito cascata mecânico, não um bug.
  - `cleanAllTables` (`src/test/create-test-data-source.ts`) ganhou `DELETE FROM "videos"` na ordem correta (antes de `channels`, depois de `refresh_tokens`/`verification_tokens`), seguindo o mesmo padrão hardcoded já usado para as outras 4 tabelas.
  - `generatePublicId` foi implementado com `crypto.randomBytes` e rejection sampling manual sobre o alfabeto base62, como pedia o plano; a revisão `/simplify` trocou a implementação por `crypto.randomInt(62)` (que já faz rejection sampling internamente no Node), preservando a garantia de "sem viés de módulo" com muito menos código — desvio consciente da redação literal do plano ("com `crypto.randomBytes`"), mantendo a mesma propriedade testada (comprimento, alfabeto `[0-9A-Za-z]`, 10.000 gerações sem colisão, distribuição sem viés grosseiro).
  - Revisão `/simplify` (reuso, simplificação, eficiência, altitude) aplicada: unificado o transformer numérico duplicado em `video.entity.ts` (`size_bytes` passou a reaproveitar `numericColumnTransformer`, antes tinha uma cópia inline quase idêntica); `generatePublicId` simplificado com `crypto.randomInt` (achado repetido nos ângulos de simplificação e eficiência — eliminava tanto a duplicação de lógica de baixo nível quanto o custo de múltiplas chamadas pequenas a `randomBytes` em retentativas de rejeição). Achados descartados conscientemente: extrair um helper compartilhado de "string aleatória a partir de alfabeto" reunindo `nickname.util.ts` (hex) e `public-id.util.ts` (base62) — generalização cross-módulo fora do escopo deste SI, e a duplicação encolheu bastante depois da troca para `randomInt`; centralizar `ALL_ENTITIES`/`cleanAllTables` numa fonte única em vez de arrays hardcoded por arquivo — dívida estrutural pré-existente do TypeORM que este SI só perpetua (e o próprio plano mandou tocar os 9 arquivos dessa forma), fica registrada aqui como candidata a uma futura SI de infraestrutura de testes antes que mais entidades/relações cheguem nas próximas fases; FK `channel_id` sem `ON DELETE` explícito — consistente com 100% das FKs pré-existentes do projeto, sem requisito de produto ainda que force a decisão (viraria uma TD dedicada se/quando existir exclusão de canal).

### SI-03.5 — Infra: Fila BullMQ e Entrypoint do Video Worker
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Wrapper de FFmpeg/FFprobe para Metadados, Normalização e Thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoint POST /videos (Início do Upload)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoints de URLs de Partes e Listagem para Retomada
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Endpoint de Conclusão do Upload e Enfileiramento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Consumer de Processamento do Vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Endpoint GET /videos/:publicId (Detalhe para o Dono)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Endpoints de Streaming e Download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Job Agendado de Limpeza de Rascunhos Expirados
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Regenerar o Artefato OpenAPI com os Endpoints de Vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none
