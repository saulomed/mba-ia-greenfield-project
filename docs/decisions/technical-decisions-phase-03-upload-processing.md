---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-13
scope_description: "Backend da Fase 03 — protocolo de upload retomável de até 10GB, object storage, fila e topologia do worker, integração com FFmpeg, gatilho de processamento, identificador único de URL, formato de reprodução, entrega de streaming/download, entrega de thumbnails, limpeza de uploads abandonados e estratégia de fixtures de vídeo para testes."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos (Backend)

_Subprojects in scope:_

- `nestjs-project/` — subprojeto principal. Recebe o módulo de vídeos (entidade `Video` como rascunho, endpoints de início/conclusão de upload, geração de URLs de streaming/download), a integração com object storage, a publicação de jobs na fila e o processo do Video Worker (FFmpeg) com seu serviço no `compose.yaml`.
- `next-frontend/` — **sem decisão aberta neste documento (pedido explícito: somente backend).** A Fase 03 não tem bullet de UI. O cliente de upload no navegador (ex.: lógica de partes e retomada) fica para uma pesquisa ad-hoc futura com `related_phases: [3]`. As TDs `Cross-layer` abaixo (TD-01, TD-07, TD-08, TD-09) fixam o contrato que o frontend vai consumir; elas são decididas uma única vez aqui, para que o frontend não precise reabrir nada.

> Âncoras entre documentos (já decididas — NÃO reabrir):
> - **BFF estrito:** `next-frontend-config-base/TD-03` (Option A). O navegador só fala com `/api/...` do Next; a URL do backend nunca chega ao cliente. Essa TD já registra que payloads grandes (vídeos, Fase 03+) usarão **URLs pré-assinadas do object storage**, não a URL do backend. Isso restringe TD-01 e TD-09.
> - **Auth:** guards customizados com `@nestjs/jwt` (`phase-02-auth/TD-02`). Endpoints de upload exigem usuário autenticado. Na Fase 03, streaming e download ficam restritos ao dono do canal (clarificações AMB-1 e AMB-2 em `docs/phases/phase-03-upload-processing/validation.md`); o acesso anônimo previsto na visão geral do projeto chega na Fase 05, junto com as regras de visibilidade da Fase 04.
> - **Envelope de erro:** `{ statusCode, error, message }` com códigos de domínio (`phase-02-auth/TD-07`). Novos erros (ex.: `VIDEO_TOO_LARGE`, `UPLOAD_NOT_FOUND`) seguem esse formato.
> - **Config:** um `registerAs` por domínio + Joi (`phase-01-configuracao-base/TD-01..TD-04`). Novos namespaces (`storage`, `queue`) seguem esse padrão, sem TD própria.
> - **OpenAPI:** `@nestjs/swagger` + `openapi.json` exportado (`openapi-docs-nestjs/TD-01..TD-02`). Novos endpoints são documentados com decoradores explícitos.
> - **Testes:** o padrão atual usa serviços reais do Compose (`db`, `mailpit` via `src/test/mailpit.ts`) com `--runInBand`. Os novos serviços (storage, fila) herdam essa convenção, sem TD de estratégia de teste.
> - **Diagrama C4:** `docs/diagrams/software-arch.mermaid` já prevê Video Worker (FFmpeg) como container separado, Object Storage "S3 or MinIO" e Message Queue "TBD".

---

## TD-01: Protocolo de Upload Retomável (10GB)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Os Pontos de Atenção exigem que o upload de até 10GB não trave o sistema e possa ser retomado se a conexão cair. O protocolo define o handshake entre navegador, API e storage, e também o momento em que o rascunho é criado. Afeta os dois lados: o backend expõe endpoints de orquestração e o frontend implementa o cliente. Sob o BFF estrito, 10GB passando pelo Next e depois pelo Nest dobraria o custo de I/O. **Depende de TD-02.**

**Options:**

### Option A: S3 Multipart Upload com URLs pré-assinadas por parte (navegador → storage direto)
- A API cria o rascunho e chama `CreateMultipartUpload` (via `POST /videos/uploads`). Depois devolve URLs pré-assinadas de `UploadPart` (via `getSignedUrl`). O navegador envia as partes direto ao storage e, no fim, a API chama `CompleteMultipartUpload`. Para retomar, o cliente usa `ListParts`.
- **Pros:** Zero bytes de vídeo passam pela API ou pelo BFF, o que atende "sem impacto na performance". É retomável por parte (até 10.000 partes). Alinha com o que `next-frontend-config-base/TD-03` já antecipou. Funciona igual com MinIO e AWS S3. Usa só `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.
- **Cons:** O storage precisa ser alcançável pelo navegador, com CORS no bucket e `ETag` exposto. O frontend implementa a lógica de partes, paralelismo e retomada (ou usa Uppy com `AwsS3`). As URLs pré-assinadas expiram, então sessões longas pedem renovação.

### Option B: Protocolo tus (`@tus/server` + `@tus/s3-store`) montado na API
- O servidor tus é montado no Express do Nest (`/uploads`) e grava no S3 via `S3Store` (partes de ~8MiB). O cliente usa `tus-js-client`/Uppy. O hook `onUploadCreate` cria o rascunho e `onUploadFinish` dispara o processamento.
- **Pros:** Protocolo aberto de retomada, maduro e com clientes prontos. Retomada transparente pelo cliente. O storage não precisa ser exposto ao navegador.
- **Cons:** Todos os 10GB passam pelo processo da API, que ocupa rede e event loop no mesmo processo que atende auth e leitura. Isso contraria "sem impacto na performance" enquanto não houver um serviço de ingestão separado. Também **colide com o BFF estrito**: ou o navegador fala direto com a API (quebra `config-base/TD-03`), ou os 10GB passam também pelo Next. Com múltiplas instâncias, exige um locker distribuído.

### Option C: Streaming multipart/form-data pela API (busboy → S3 `Upload`)
- Um único POST `multipart/form-data`, com a API fazendo stream para o storage via `@aws-sdk/lib-storage`.
- **Pros:** Implementação mais simples nos dois lados.
- **Cons:** Não é retomável: uma queda aos 9GB recomeça do zero, o que viola um Ponto de Atenção explícito. Também tem o mesmo custo de I/O na API e o mesmo conflito com o BFF da Option B.

**Recommendation:** **Option A (S3 Multipart com URLs pré-assinadas)** — é a única opção que tira os bytes de vídeo da API e do BFF e ainda permite retomada. É também o caminho já registrado como premissa em `next-frontend-config-base/TD-03`. O custo extra (CORS no bucket e lógica de partes no cliente) é pontual. Com tus, a API seria o gargalo de ingestão, e contornar isso exigiria outro serviço fora do diagrama C4.

**Decision:** A (S3 Multipart com URLs pré-assinadas por parte)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-02: Object Storage e Cliente de Acesso

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Vídeos e thumbnails precisam de um storage compartilhado entre API (assina URLs, conclui uploads) e Worker (lê o original, grava a thumbnail). A escolha define o serviço no `compose.yaml`, as chaves de env (schema Joi + `.env.example` + compose) e o SDK usado nos dois processos, então é cross-component. O diagrama C4 cita "S3 or MinIO" sem decidir.

**Options:**

### Option A: MinIO no Compose (dev) + `@aws-sdk/client-s3` v3 (`forcePathStyle: true`)
- Serviço `minio` no `compose.yaml` (bucket privado criado no bootstrap). A aplicação usa o AWS SDK v3 contra `STORAGE_ENDPOINT`. Em produção basta trocar o endpoint e as credenciais para AWS S3 ou outro provedor compatível.
- **Pros:** API S3 real em dev, com multipart, presign e Range, o que viabiliza TD-01 A e TD-09 A. Portabilidade para qualquer provedor S3 sem mudar código. SDK oficial e mantido.
- **Cons:** Mais um container em dev e nos testes de integração. É preciso distinguir endpoint interno (`minio:9000`, usado pela API) de endpoint público (usado pelas URLs assinadas que o navegador acessa), porque a assinatura inclui o host.

### Option B: Filesystem local (volume Docker compartilhado entre API e Worker)
- Arquivos em um volume montado nos dois containers, servidos pela API.
- **Pros:** Zero dependências novas. Setup trivial.
- **Cons:** Sem multipart nem URL pré-assinada: inviabiliza TD-01 A e força a API a servir todos os bytes. Não escala além de um host. A migração para object storage em produção vira reescrita, e não troca de config. Contraria o planejamento de crescimento de armazenamento dos Pontos de Atenção.

**Recommendation:** **Option A (MinIO + AWS SDK v3)** — é pré-requisito técnico de TD-01 A e TD-09 A e mantém paridade dev/prod com uma troca só de configuração. O custo real é a separação entre endpoint interno e público, que precisa estar no conjunto canônico de env vars desde o início.

**Decision:** A (MinIO no Compose + @aws-sdk/client-s3 v3 com forcePathStyle)
**Libraries:** @aws-sdk/client-s3

---

## TD-03: Tecnologia da Fila de Processamento

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O processamento (FFmpeg) é pesado e precisa rodar fora do ciclo de requisição, com retry e sem perder jobs se o worker reiniciar. O diagrama C4 marca a fila como "TBD". A escolha adiciona (ou não) infraestrutura ao compose e define o módulo Nest usado por quem publica (API) e por quem consome (Worker).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- `BullModule.forRoot({ connection })` + `registerQueue`. A API publica com `queue.add()` e o Worker consome com `@Processor` + `WorkerHost`. Retry e backoff são configurados por job (`attempts`, `backoff`).
- **Pros:** Integração oficial documentada no NestJS (techniques/queues). Retry com backoff exponencial, progresso (`updateProgress`), concorrência por worker, jobs atrasados e limpeza (`removeOnComplete`). Ecossistema maduro. O Redis também pode servir mais tarde como store distribuído do `@nestjs/throttler`.
- **Cons:** Nova infraestrutura (Redis) no compose, nos testes e na produção. Exige persistência do Redis (AOF) para não perder jobs. Mais uma peça para operar.

### Option B: pg-boss (fila sobre PostgreSQL)
- A fila fica em tabelas do Postgres já existente (`SKIP LOCKED`). A API faz `boss.send()` e o Worker faz `boss.work()`, com `retryLimit`/`retryBackoff`.
- **Pros:** Nenhuma infra nova, porque reusa o `db`. Enfileiramento pode ser transacional com a escrita do vídeo (mesmo banco), o que elimina a janela "vídeo gravado, job perdido". Mesma lógica que evitou Redis em `phase-02-auth/TD-03`.
- **Cons:** Sem módulo oficial NestJS: o provider, o lifecycle e o shutdown são escritos à mão. Documentação mais escassa (não indexada no Context7). Throughput menor que Redis, embora irrelevante no volume esperado. Aumenta a carga de escrita no Postgres principal.

### Option C: Polling de tabela `videos` por status (sem lib de fila)
- O Worker faz `SELECT ... WHERE status = 'uploaded' FOR UPDATE SKIP LOCKED` periodicamente.
- **Pros:** Zero dependências. Estado da fila e estado do vídeo são a mesma coisa.
- **Cons:** Retry, backoff, timeout de job travado e concorrência ficam todos por conta do projeto, o que reinventa pg-boss. Latência igual ao intervalo do polling.

**Recommendation:** **Option A (BullMQ + Redis)**, com ressalva honesta — a integração oficial `@nestjs/bullmq` e os recursos prontos (retry, backoff, progresso, concorrência) reduzem código próprio no ponto mais crítico da fase. A Option B é tecnicamente equivalente em confiabilidade e ganha em infraestrutura (sem Redis) e em atomicidade. Se evitar um novo serviço for prioridade, B é uma escolha defensável; o custo é escrever a integração Nest manualmente.

**Decision:** A (BullMQ + Redis via @nestjs/bullmq)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-04: Topologia de Execução do Video Worker

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Onde os consumidores da fila rodam define se o FFmpeg compete por CPU e memória com a API. Também define se o `compose.yaml` ganha um serviço novo e qual imagem precisa do binário FFmpeg. O diagrama C4 desenha o Worker como container separado, mas o formato de entrega (outro codebase, outro entrypoint, sandbox) está aberto. **Depende de TD-03.**

**Options:**

### Option A: Mesmo codebase (`nestjs-project/`), entrypoint próprio, container separado
- Um `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)`, sem HTTP, importando só módulos necessários (TypeORM, storage, fila). O novo serviço `video-worker` no compose usa uma imagem com FFmpeg. A API não registra processors.
- **Pros:** Isolamento de CPU e memória: FFmpeg nunca degrada a API, e o worker escala à parte. Reusa entidades, configs (`registerAs`), DI e padrões de teste. Um só `package.json`, sem monorepo novo. Bate com o diagrama C4.
- **Cons:** Dois processos para subir em dev e dois alvos de deploy. É preciso disciplina para o `WorkerModule` não importar controllers ou módulos HTTP. A imagem do worker fica maior (FFmpeg).

### Option B: Processors dentro do processo da API
- `@Processor` registrado no `AppModule` da API.
- **Pros:** Setup mínimo, um processo só.
- **Cons:** FFmpeg em arquivos de GB disputa CPU e memória com as requisições e viola "sem impacto na performance". Escalar processamento significa escalar a API inteira. A imagem da API também precisaria de FFmpeg.

### Option C: Sandboxed processors do BullMQ (processo filho forkado pela API)
- `registerQueue({ processors: [join(..., 'processor.js')] })`: o BullMQ forka um processo por job.
- **Pros:** Isola crashes do job. Não precisa de container novo.
- **Cons:** Sem DI nem container IoC dentro do fork (documentação oficial), o que obriga a recriar TypeORM e config manualmente. A CPU continua no mesmo host e cgroup da API. Só existe com TD-03 A.

**Recommendation:** **Option A (container separado, mesmo codebase)** — é o único formato que isola de fato o FFmpeg da API sem abrir mão de DI e das entidades já existentes. Também materializa o container "Video Worker" do C4 sem introduzir um novo subprojeto.

**Decision:** A (Container separado, mesmo codebase, entrypoint próprio)

---

## TD-05: Integração com FFmpeg/FFprobe

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** A extração de duração e metadados (`ffprobe`) e a geração de thumbnail (`ffmpeg`) precisam de um binário e de uma forma de invocá-lo a partir do Node. A biblioteca historicamente padrão, `fluent-ffmpeg`, **foi arquivada em 22/05/2025** e não funciona corretamente com versões recentes do FFmpeg. O `ffmpeg-kit` também foi arquivado (06/2025). A escolha afeta a imagem do worker (TD-04) e a estratégia de teste. **Depende de TD-04.**

**Options:**

### Option A: FFmpeg do sistema (apt na imagem do worker) + wrapper fino sobre `child_process.spawn`
- `apt install ffmpeg` no Dockerfile do worker. Um serviço `MediaProbeService` executa `ffprobe -print_format json -show_format -show_streams` e `ffmpeg -ss <t> -frames:v 1`, com parsing tipado da saída.
- **Pros:** Nenhuma dependência npm não mantida. O JSON do `ffprobe` é estável e fácil de tipar. Controle total sobre argumentos, timeout e kill do processo. A versão do FFmpeg fica fixada pela imagem base.
- **Cons:** O wrapper (spawn, stderr, exit codes, timeout) é código próprio a manter e testar. A versão do FFmpeg depende da distribuição da imagem base.

### Option B: Binários via npm (`ffmpeg-static` / `ffprobe-static`) + `child_process`
- Binários estáticos baixados no `npm install`, invocados pelo caminho exportado pelo pacote.
- **Pros:** Versão do binário fixada no `package-lock.json`. Não depende do apt da imagem.
- **Cons:** Baixa binário no `npm install` (em todos os ambientes, inclusive a API, que não precisa dele). O `ffprobe-static` é pouco atualizado. O wrapper de spawn continua necessário, então o ganho é só sobre a origem do binário.

### Option C: `fluent-ffmpeg`
- API fluente que monta a linha de comando.
- **Pros:** Muitos exemplos antigos disponíveis.
- **Cons:** **Arquivado e sem manutenção** desde 05/2025, com incompatibilidades conhecidas com FFmpeg recente. Seria dívida técnica desde o dia 1.

**Recommendation:** **Option A (FFmpeg do sistema + wrapper sobre `spawn`)** — com as bibliotecas de alto nível arquivadas, a invocação direta é o caminho sustentável. A necessidade é pequena (um `ffprobe` JSON e um frame de thumbnail), o que cabe em um wrapper enxuto e testável. O binário fica restrito à imagem do worker.

**Decision:** A (FFmpeg do sistema na imagem do worker + wrapper sobre child_process.spawn)

---

## TD-06: Gatilho de Conclusão do Upload e Enfileiramento

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Com o upload indo direto ao storage (TD-01 A), a API não observa os bytes chegando. Alguém precisa detectar que o objeto está completo, marcar o vídeo como enviado e publicar o job. A escolha envolve a configuração do storage (notificações) e da API, e define a garantia de que todo upload concluído gera exatamente um job. **Depende de TD-01, TD-02 e TD-03.**

**Options:**

### Option A: Endpoint explícito de conclusão na API
- O cliente chama `POST /videos/:id/upload/complete` com a lista de partes e ETags. A API executa `CompleteMultipartUpload`, confere o tamanho via `HeadObject`, muda o status e publica o job (usando o id do vídeo como `jobId`, para idempotência).
- **Pros:** Fluxo síncrono e auditável, com erros no envelope de `phase-02-auth/TD-07`. Valida posse e tamanho real (≤10GB) antes de processar. Idempotente com `jobId` fixo. Não depende de recurso específico do provedor de storage.
- **Cons:** Se o cliente fechar a aba após a última parte e antes do `complete`, o upload fica incompleto até ser retomado ou expirar (tratado em TD-10). Mais uma chamada no contrato do frontend.

### Option B: Notificações de bucket do storage (evento `s3:ObjectCreated:CompleteMultipartUpload`)
- O cliente conclui o multipart direto no storage. O MinIO ou S3 emite um evento (webhook para a API, ou fila) e a API então enfileira o job.
- **Pros:** Não depende do cliente sinalizar a conclusão.
- **Cons:** A configuração de notificação é específica do provedor (MinIO webhook ≠ S3 → SQS/EventBridge), o que quebra a paridade dev/prod de TD-02. Adiciona um endpoint de webhook que precisa ser autenticado. O `CompleteMultipartUpload` precisaria de URL pré-assinada entregue ao cliente, reduzindo o controle da API sobre a validação de tamanho. A entrega de eventos é at-least-once e exige deduplicação.

**Recommendation:** **Option A (endpoint de conclusão)** — mantém a API como dona do ciclo de vida do vídeo e valida tamanho e posse antes de gastar CPU. Também evita configuração de eventos que diverge entre MinIO e S3. O caso "cliente abandonou antes do complete" é coberto pela política de TD-10.

**Decision:** A (Endpoint explícito de conclusão na API)

---

## TD-07: Identificador Público Único do Vídeo (URL)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Os Pontos de Atenção pedem "URL curta e única que nunca conflite". O identificador aparece nas rotas da API (`/videos/:publicId`), nas rotas do frontend (página de visualização da Fase 05) e em links compartilhados, então é um contrato entre os dois lados. As entidades existentes usam `uuid` como PK (`users`, `channels`). Para vídeos unlisted (Fase 05), o identificador não pode ser enumerável.

**Options:**

### Option A: UUID da PK exposto na URL
- `/watch/3f2a...-...` usando `PrimaryGeneratedColumn('uuid')`, como nas demais entidades.
- **Pros:** Zero código novo e consistente com as entidades atuais. Colisão praticamente impossível. Não enumerável.
- **Cons:** 36 caracteres não atendem a "URL curta". Links ficam ruins de compartilhar.

### Option B: ID curto aleatório base62 em coluna própria (`public_id`, ~11 chars), PK continua UUID
- Gerado com `crypto.randomBytes` (sem dependência), com constraint `UNIQUE` e retry em caso de colisão. 11 chars em base62 dão ~65 bits de entropia.
- **Pros:** URL curta no estilo YouTube. Não enumerável, o que é adequado para unlisted. A PK interna segue o padrão UUID, e o id público pode ser trocado sem mexer em FKs. O `UNIQUE` no banco garante "nunca conflita" mesmo em caso de colisão.
- **Cons:** Uma coluna e um índice extras. Lógica de retry na criação (colisão extremamente rara).

### Option C: Sqids/Hashids sobre sequência inteira
- Codifica um `bigint` sequencial em string curta reversível.
- **Pros:** Muito curto e sem colisão por construção.
- **Cons:** É reversível e ofuscação não é segurança: a sequência é enumerável e expõe o volume de vídeos, o que conflita com unlisted. Exige uma sequência inteira paralela à PK UUID. Adiciona uma dependência.

**Recommendation:** **Option B (base62 aleatório em `public_id`)** — é a única opção que atende ao mesmo tempo "curta", "nunca conflita" (garantido pelo `UNIQUE`) e "não enumerável". Esse último ponto é pré-requisito do fluxo unlisted da Fase 05. A PK UUID permanece, preservando a convenção das entidades existentes.

**Decision:** B (ID curto base62 aleatório em coluna public_id; PK continua UUID)

---

## TD-08: Formato de Reprodução (Original vs Normalizado vs HLS)

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** O escopo da Fase 03 fala em "extração de duração e metadados", não em transcodificação. Mas o arquivo original pode estar em um contêiner ou codec que o navegador não reproduz (MKV, AVI, HEVC). Ou pode ser um MP4 com o `moov atom` no fim, que obriga a baixar o arquivo inteiro antes de tocar e contraria o bullet de streaming. A escolha define o que o worker produz e o que o player da Fase 05 consome. **Depende de TD-04 e TD-05.**

**Options:**

### Option A: Servir o arquivo original, restringindo formatos aceitos (MP4 H.264/AAC, WebM)
- A API valida o tipo na criação do upload e o worker valida codecs via `ffprobe` (vídeo com formato inválido vai para status `failed`). A reprodução é progressiva com HTTP Range sobre o original.
- **Pros:** Sem transcodificação: processamento barato e rápido. Um único arquivo armazenado.
- **Cons:** Rejeita parte dos uploads reais. MP4 sem `faststart` pode não iniciar antes de baixar o índice, e só um remux resolve isso. A qualidade é fixa, sem adaptação a banda.

### Option B: Normalizar para MP4 H.264/AAC com `+faststart` (worker) e servir progressivo
- O worker gera `playback.mp4` (remux quando os codecs já são compatíveis, transcodificação quando não) e mantém o original para download.
- **Pros:** Aceita qualquer formato que o FFmpeg leia. Garante início imediato (`faststart`) com HTTP Range. Player simples (`<video>` nativo) na Fase 05.
- **Cons:** Transcodificar 10GB custa muito CPU e tempo. O armazenamento pode até dobrar (original + playback). Continua sem bitrate adaptativo.

### Option C: HLS com múltiplas resoluções (segmentos `.ts`/fMP4 + playlist `.m3u8`)
- O worker gera uma escada de bitrates segmentada e o player usa `hls.js`.
- **Pros:** Streaming adaptativo "de verdade", resiliente a banda variável. É o padrão de plataformas de vídeo.
- **Cons:** O maior custo de CPU, armazenamento e complexidade. Muitos objetos por vídeo complicam URLs assinadas por segmento (TD-09). Adiciona `hls.js` ao frontend. Vai além do escopo declarado da fase ("extração de duração e metadados").

**Recommendation:** **Option B (MP4 normalizado com `faststart`)** — é o mínimo que garante o bullet de streaming (início sem baixar tudo) para qualquer upload, sem a complexidade de HLS. Na maioria dos casos o custo cai para um remux barato. HLS pode entrar numa fase posterior sem quebrar o contrato: basta trocar o artefato de playback. A Option A é aceitável se o time preferir restringir formatos para manter a fase enxuta.

**Decision:** B (MP4 H.264/AAC normalizado com +faststart, servido progressivo)

---

## TD-09: Entrega de Streaming e Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** O player precisa de requisições HTTP Range sobre o arquivo de playback, e o download precisa de `Content-Disposition: attachment`. O caminho dos bytes define quem arca com a banda (API ou storage), como o acesso anônimo é autorizado e qual URL o frontend recebe. Pelo BFF estrito (`config-base/TD-03`), a URL do backend nunca vai ao navegador, e a mesma TD já antecipa URLs pré-assinadas do storage. **Depende de TD-02 e TD-08.**

**Options:**

### Option A: URLs pré-assinadas de `GetObject` com expiração curta, emitidas pela API
- `GET /videos/:publicId/stream` (ou um campo no DTO do vídeo) retorna uma URL assinada (ex.: 1–4h) do objeto de playback. `GET /videos/:publicId/download` retorna uma URL assinada com `ResponseContentDisposition=attachment; filename=...`. O navegador faz Range direto no storage. O bucket fica privado.
- **Pros:** Range, seek e throughput nativos do storage, com zero banda na API ou no BFF. O download usa o mesmo mecanismo (`ResponseContentDisposition`). O bucket continua privado: a API decide quem recebe URL, o que prepara o controle de rascunho e unlisted das Fases 04/05. Troca direta por CDN com URLs assinadas no futuro.
- **Cons:** A URL expira, então vídeos longos pausados por horas precisam de renovação no player. URLs assinadas não são cacheáveis entre usuários. É preciso expor um endpoint público do storage ao navegador (mesma exigência de TD-01 A).

### Option B: Proxy de stream pela API (API lê do storage e repassa com suporte a `Range`)
- Um controller Nest traduz `Range` para `GetObject` com `Range` e faz pipe da resposta.
- **Pros:** Storage totalmente interno. Autorização por requisição. URL estável.
- **Cons:** Toda a banda de reprodução passa pela API, e pelo BFF sob `config-base/TD-03`, o que é o oposto de "sem impacto na performance". A implementação de Range, 206 e cabeçalhos é própria.

### Option C: Bucket (ou prefixo) público de leitura
- Os objetos de playback ficam acessíveis por URL pública fixa.
- **Pros:** O mais simples. URL estável e cacheável por CDN.
- **Cons:** Qualquer pessoa com a URL acessa rascunhos e vídeos não publicados, sem nenhum controle. Isso inviabiliza a regra de rascunho (Fase 04) e de unlisted (Fase 05) sem migração posterior.

**Recommendation:** **Option A (URLs pré-assinadas de curta duração)** — reaproveita o storage para Range e banda, mantém o bucket privado para as regras de visibilidade das próximas fases e cobre streaming e download com um único mecanismo. Também é coerente com a premissa já registrada no BFF estrito.

**Decision:** A (URLs pré-assinadas de GetObject com expiração curta, emitidas pela API)
**Libraries:** @aws-sdk/s3-request-presigner

---

## TD-10: Limpeza de Uploads Abandonados e Rascunhos Órfãos

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** O rascunho nasce no início do upload (TD-01). Uploads multipart nunca concluídos deixam partes cobradas no storage (até ~10GB cada, invisíveis em listagens normais) e linhas `videos` presas no status inicial. Os Pontos de Atenção pedem planejar custo de armazenamento desde o início. A política envolve configuração do storage, o banco e possivelmente a fila. **Depende de TD-01, TD-02 e TD-03.**

**Options:**

### Option A: Regra de lifecycle do bucket (`AbortIncompleteMultipartUpload` após N dias) + job agendado de rascunhos expirados
- A regra de lifecycle, aplicada no bootstrap do bucket, remove as partes órfãs no próprio storage. Um job repetível na fila (TD-03) marca como `failed` ou remove os rascunhos cujo upload não foi concluído no prazo.
- **Pros:** O storage limpa as próprias partes sem código de listagem, e o recurso é suportado por MinIO e S3. O job de banco reusa a fila escolhida. O prazo vira uma única env var compartilhada.
- **Cons:** Duas peças (regra de bucket + job) com o mesmo prazo, que precisam ficar coerentes. A regra de lifecycle roda em granularidade de dias.

### Option B: Job agendado único que lista multipart uploads pendentes e aborta via API S3
- Um job periódico faz `ListMultipartUploads` + `AbortMultipartUpload` e atualiza o banco na mesma rotina.
- **Pros:** Uma só peça, com a lógica toda no código e testável. Granularidade fina (horas).
- **Cons:** Reimplementa o que o lifecycle nativo já faz. Se o job falhar ou ficar desligado, as partes acumulam custo silenciosamente.

### Option C: Sem limpeza automática nesta fase
- Adiar para a Fase 07 (produção).
- **Pros:** Menos escopo agora.
- **Cons:** Partes órfãs acumulam desde o primeiro teste manual de 10GB. Rascunhos fantasmas poluem o painel da Fase 04. É dívida conhecida contra um Ponto de Atenção explícito.

**Recommendation:** **Option A (lifecycle do bucket + job de rascunhos)** — delega ao storage o que ele já faz de forma confiável (abortar multipart incompleto) e deixa ao código só a parte de domínio (estado do rascunho). O prazo fica numa única variável de configuração.

**Decision:** A (Lifecycle AbortIncompleteMultipartUpload + job agendado de rascunhos expirados)

---

## TD-11: Entrega de Thumbnails ao Navegador

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** A TD-09 decide só a entrega do vídeo (streaming e download). As thumbnails têm outro perfil: são pequenas, aparecem dezenas por tela em listagens (painel do canal na Fase 04, sidebar de sugestões na Fase 05, grid da home na Fase 07) e o valor delas está em cache de navegador ou CDN. O formato da URL que a API devolve no DTO do vídeo é um contrato consumido pelo frontend (ex.: `remotePatterns` do `next/image`). Esse contrato também afeta o BFF estrito (`next-frontend-config-base/TD-03`): a URL da thumbnail não pode ser a do backend, e essa TD já previa um host público de object storage como primeiro `NEXT_PUBLIC_*`. Levantado por `validation.md` MD-1. **Depende de TD-02; deve ser coerente com TD-07 e TD-09.**

**Options:**

### Option A: URL pré-assinada de `GetObject` com expiração curta (mesmo mecanismo da TD-09)
- Cada resposta que inclui vídeos assina a URL da thumbnail na hora (ex.: 1h). O bucket inteiro continua privado.
- **Pros:** Um só mecanismo de acesso para todo o storage. Nada fica exposto sem passar pela API, inclusive thumbnails de rascunhos. Assinar é HMAC local, sem chamada de rede.
- **Cons:** A URL muda a cada resposta (assinatura e data diferentes), então navegador, `next/image` e CDN nunca reaproveitam cache. Cada listagem baixa as thumbnails de novo. Páginas abertas por mais tempo que a expiração quebram as imagens.

### Option B: URL pré-assinada com janela de assinatura fixa (`signingDate` alinhado, ex.: janelas de 24h)
- A API assina com `signingDate` arredondado para o início da janela e `expiresIn` maior que a janela (limite SigV4: 7 dias). Dentro da janela a URL é idêntica e cacheável.
- **Pros:** Mantém o bucket privado e permite cache dentro da janela. Não exige política pública no storage.
- **Cons:** O cache inteiro é invalidado a cada virada de janela. O padrão é pouco convencional (depende de `signingDate` do presigner), o que dificulta manutenção e teste. Durante a janela, qualquer pessoa com a URL acessa a thumbnail, então a proteção de rascunhos é só nominal. O teto de 7 dias do SigV4 limita a janela.

### Option C: Prefixo público de leitura só para thumbnails (`thumbnails/`), com chaves imprevisíveis e imutáveis
- Uma política anônima `download` restrita ao prefixo (`mc anonymous set download alias/bucket/thumbnails`; S3 `s3:GetObject` em `bucket/thumbnails/*`), sem `ListBucket`. A chave é aleatória e muda sempre que a thumbnail muda (ex.: thumbnail customizada na Fase 04), e o objeto é gravado com `Cache-Control: public, max-age=31536000, immutable`. A API devolve URL estável montada com o host público do storage. Vídeos continuam privados (TD-09).
- **Pros:** URL estável e cacheável indefinidamente por navegador, `next/image` e CDN. Custo zero na API e no BFF por imagem, o que importa nos grids das Fases 04, 05 e 07. Implementação simples e suportada tanto no MinIO quanto no S3. Encaixa na previsão de `config-base/TD-03` de um host público de storage.
- **Cons:** A thumbnail de um rascunho fica acessível a quem tiver a URL. A chave aleatória e a ausência de listagem tornam isso inviável por enumeração, mas não há controle por requisição. Remover o acesso exige apagar o objeto. Uma política de bucket passa a ser configuração de infraestrutura versionada (bootstrap do MinIO em dev e política equivalente em prod).

### Option D: Proxy pela API (`GET /videos/:publicId/thumbnail`) com `Cache-Control`/`ETag`
- A API lê o objeto do storage e repassa, com headers de cache e autorização por requisição.
- **Pros:** URL estável. Storage totalmente interno. Regras de visibilidade das Fases 04/05 aplicáveis por requisição.
- **Cons:** Toda thumbnail de toda listagem passa pela API e, sob BFF estrito, também pelo Next. Em grids isso multiplica requisições e banda no processo que atende auth e leitura. Cache e `ETag` são implementação própria. É o oposto do motivo que levou a TD-09 a recomendar URLs pré-assinadas.

**Recommendation:** **Option C (prefixo público só para thumbnails, chaves imprevisíveis e imutáveis)** — thumbnails são ativos pequenos cujo valor está no cache. Só URLs estáveis permitem cache em navegador, `next/image` e CDN nas listagens das Fases 04, 05 e 07 sem gastar a API ou o BFF. A exposição é limitada a quem já tem a chave aleatória, e o prefixo não é listável. O vídeo, que é o conteúdo sensível, continua privado pela TD-09. Se o time exigir que thumbnails de rascunho sejam estritamente privadas, a Option B é o compromisso aceitável; A e D trocam cache ou performance por uma proteção que a thumbnail raramente justifica.

**Decision:** C (Prefixo público thumbnails/ com chaves imprevisíveis e imutáveis)

---

## TD-12: Estratégia de Fixtures de Vídeo para Testes (Simulação de Arquivos Grandes)

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Os testes da Fase 03 precisam de três coisas diferentes que um único vídeo real não entrega. A primeira é **mídia válida** para o worker: `ffprobe`, frame de thumbnail e remux/transcodificação (TD-05, TD-08), incluindo os casos de codec incompatível e arquivo corrompido (estado `failed`). A segunda é **volume de bytes** para exercitar o multipart pré-assinado e a retomada via `ListParts` (TD-01, TD-06); o S3/MinIO exige partes de no mínimo 5 MB, exceto a última. A terceira é a **validação do limite de 10GB** no endpoint de conclusão (TD-06, `HeadObject.ContentLength`). Versionar um vídeo de 10GB está fora de cogitação, e enviar 10GB reais para o MinIO em cada execução tornaria a suíte inviável. A escolha envolve helpers de teste, a disponibilidade do FFmpeg no container que roda os testes (hoje só previsto na imagem do worker, TD-05) e uma chave de configuração do limite (schema Joi + `.env.example` + ambiente de teste), então é cross-component. Nota: `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` ainda descreve "Object Storage — Local Filesystem" para testes, o que diverge de TD-02 A (MinIO real) e precisa ser atualizado. **Depende de TD-01, TD-02, TD-05, TD-06 e TD-08.**

**Options:**

### Option A: Clipes minúsculos versionados + stream sintético de bytes para volume
- Dois ou três clipes curtos (< 1 MB cada, ex.: MP4 H.264/AAC, MKV/HEVC, arquivo truncado) versionados em `test/fixtures/`. O volume para multipart vem de um `Readable` que gera N bytes em memória, sem arquivo. O limite de 10GB é testado reduzindo a chave de limite no ambiente de teste.
- **Pros:** Determinístico: os bytes são idênticos em qualquer máquina e versão de FFmpeg. O runtime de testes da API não precisa de FFmpeg para ter as fixtures. Setup trivial.
- **Cons:** Binários no git (pequenos, mas crescem a cada novo caso de codec). A matriz de formatos fica escondida em arquivos opacos, sem registro de como foram gerados. Regenerar ou adicionar casos exige um passo manual fora do repositório.

### Option B: Geração sob demanda com FFmpeg `lavfi` + stream sintético + limite configurável
- Um `globalSetup` do Jest gera os clipes com fontes sintéticas (`testsrc2` + áudio senoidal, ex.: 2 s, 320x240) em `os.tmpdir()`, com cache entre execuções. A matriz (MP4 H.264 com e sem `faststart`, MKV/HEVC, WebM, arquivo truncado) fica declarada em código. O volume para multipart vem de um stream sintético em múltiplos de 5 MB, e o limite de 10GB é validado com a chave de limite reduzida (ex.: 12 MB) no ambiente de teste. Nada binário é versionado.
- **Pros:** Zero binários no repositório. Adicionar um caso de codec é uma linha de código. Os mesmos parâmetros documentam o que cada fixture representa. Reusa o FFmpeg que a TD-05 já coloca na imagem do worker.
- **Cons:** Exige FFmpeg no container que executa os testes (instalar também na imagem de dev da API, ou rodar as suítes do worker no container do worker). Adiciona alguns segundos na primeira execução. A saída varia entre versões do FFmpeg, então as asserções usam faixas (duração aproximada, dimensões) e não bytes exatos.

### Option C: Arquivos esparsos de 10GB reais (`truncate`/`fallocate`)
- Cria um arquivo esparso de 10GB (não ocupa disco local) com cabeçalho válido e envia pelo fluxo real de multipart.
- **Pros:** Exercita o tamanho real de ponta a ponta, inclusive a contagem de partes perto do limite.
- **Cons:** O arquivo não ocupa disco, mas o upload transfere 10GB reais pela rede até o MinIO, que grava tudo: minutos por execução e 10GB de disco no container. Inviável em CI e na suíte padrão; serve no máximo como smoke test manual.

### Option D: Mock do storage e do tamanho
- `StorageService` falso que devolve `ContentLength` arbitrário e simula partes sem MinIO.
- **Pros:** Suíte rápida e sem dependências.
- **Cons:** Não exercita assinatura, CORS, `ListParts`, `CompleteMultipartUpload` nem o mínimo de 5 MB por parte do MinIO. Contraria o princípio do guia de testes de não mockar bibliotecas configuradas e sistemas externos com serviço real disponível. Não cobre o worker com mídia real.

**Recommendation:** **Option B (geração sob demanda com FFmpeg `lavfi` + stream sintético + limite configurável)** — separa as três necessidades: mídia válida pequena gerada em código para o worker, bytes sintéticos para o multipart e limite reduzido por configuração para a regra de 10GB. Nenhum binário é versionado e nada chega perto de 10GB na suíte. O FFmpeg já é dependência da imagem do worker (TD-05), e manter a matriz de formatos em código evita fixtures opacas. A Option C pode existir como script manual de smoke test (fora da suíte e da CI) para validar o tamanho real antes de produção. Se instalar FFmpeg no runtime de testes da API for inaceitável, a Option A é o fallback razoável.

**Decision:** B (Geração sob demanda com FFmpeg lavfi + stream sintético + limite configurável)

---

## Dependências entre TDs

- TD-01 depende de TD-02 (multipart pré-assinado exige storage S3-compatível).
- TD-04 depende de TD-03 (a Option C só existe com BullMQ).
- TD-05 depende de TD-04 (o binário vai para a imagem do worker).
- TD-06 depende de TD-01, TD-02 e TD-03.
- TD-08 depende de TD-04 e TD-05 (normalização acontece no worker).
- TD-09 depende de TD-02 e TD-08 (qual objeto é assinado).
- TD-10 depende de TD-01, TD-02 e TD-03.
- TD-11 depende de TD-02 (política de acesso por prefixo exige storage S3-compatível) e deve ser coerente com TD-07 (chave/URL pública) e TD-09 (vídeo permanece privado).
- TD-12 depende de TD-01 e TD-06 (fluxo multipart e validação de tamanho a exercitar), TD-02 (MinIO real nos testes), TD-05 (FFmpeg disponível) e TD-08 (matriz de formatos a normalizar).

## Itens deliberadamente fora deste documento (resolvidos na implementação)

- Status do vídeo (`draft`/`uploading`/`processing`/`ready`/`failed`) como enum TypeORM: convenção da skill `typeorm`, sem alternativa estratégica real.
- Namespaces `storage`/`queue` em `registerAs` + Joi: padrão herdado de `phase-01-configuracao-base/TD-03`.
- Instante do frame da thumbnail e formato de saída (ex.: JPEG a 10% da duração): detalhe de um único componente (worker), sem contrato cross-component.
- Estratégia de testes com MinIO e Redis: herda a convenção atual de serviços reais do Compose com `--runInBand`. A geração de vídeos de teste e a simulação de arquivos grandes são decididas na TD-12.
- Autorização dos endpoints de upload: herda `JwtAuthGuard` (`phase-02-auth/TD-02`).

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Cross-layer | Protocolo de Upload Retomável (10GB) | A (S3 Multipart com URLs pré-assinadas) | **A** |
| TD-02 | Backend | Object Storage e Cliente de Acesso | A (MinIO + `@aws-sdk/client-s3` v3) | **A** |
| TD-03 | Backend | Tecnologia da Fila de Processamento | A (BullMQ + Redis via `@nestjs/bullmq`) — B defensável | **A** |
| TD-04 | Backend | Topologia de Execução do Video Worker | A (container separado, mesmo codebase) | **A** |
| TD-05 | Backend | Integração com FFmpeg/FFprobe | A (FFmpeg do sistema + wrapper `spawn`) | **A** |
| TD-06 | Backend | Gatilho de Conclusão do Upload e Enfileiramento | A (endpoint de conclusão na API) | **A** |
| TD-07 | Cross-layer | Identificador Público Único do Vídeo (URL) | B (base62 aleatório em `public_id`) | **B** |
| TD-08 | Cross-layer | Formato de Reprodução | B (MP4 normalizado com `faststart`) | **B** |
| TD-09 | Cross-layer | Entrega de Streaming e Download | A (URLs pré-assinadas de curta duração) | **A** |
| TD-10 | Backend | Limpeza de Uploads Abandonados e Rascunhos Órfãos | A (lifecycle do bucket + job de rascunhos) | **A** |
| TD-11 | Cross-layer | Entrega de Thumbnails ao Navegador | C (prefixo público `thumbnails/`, chaves imprevisíveis e imutáveis) | **C** |
| TD-12 | Backend | Estratégia de Fixtures de Vídeo para Testes | B (FFmpeg `lavfi` sob demanda + stream sintético + limite configurável) | B |
