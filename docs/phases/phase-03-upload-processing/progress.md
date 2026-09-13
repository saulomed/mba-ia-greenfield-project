# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 2/14 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Entidade Video, Migration e Gerador de public_id
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
