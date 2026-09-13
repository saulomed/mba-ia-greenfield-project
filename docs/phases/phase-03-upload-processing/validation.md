---
kind: phase
name: phase-03-upload-processing
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-upload-processing/context.md: "2026-09-13T17:04:35Z"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-09-13T17:04:25Z"
issues:
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Estratégia de Fixtures de Vídeo para Testes (Arquivos Grandes)"
    resolved_by: phase-03-upload-processing/TD-12
  - id: AMB-1
    status: resolved
    summary: "Download: quem pode baixar (dono vs qualquer visitante) e qual arquivo"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Streaming na Fase 03: quem acessa vídeos rascunho/não processados"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Pré-cadastro: campos mínimos do rascunho e dono (canal vs usuário)"
    resolved_by: clarification
  - id: AMB-4
    status: resolved
    summary: "Processamento: conjunto de metadados e estados de falha indefinidos"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Protocolo de Upload Retomável (10GB)"
    resolved_by: phase-03-upload-processing/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Object Storage e Cliente de Acesso"
    resolved_by: phase-03-upload-processing/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Tecnologia da Fila de Processamento"
    resolved_by: phase-03-upload-processing/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Topologia de Execução do Video Worker"
    resolved_by: phase-03-upload-processing/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Integração com FFmpeg/FFprobe"
    resolved_by: phase-03-upload-processing/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Gatilho de Conclusão do Upload e Enfileiramento"
    resolved_by: phase-03-upload-processing/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Identificador Público Único do Vídeo (URL)"
    resolved_by: phase-03-upload-processing/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Formato de Reprodução"
    resolved_by: phase-03-upload-processing/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Entrega de Streaming e Download"
    resolved_by: phase-03-upload-processing/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Limpeza de Uploads Abandonados e Rascunhos Órfãos"
    resolved_by: phase-03-upload-processing/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Entrega de Thumbnails ao Navegador"
    resolved_by: phase-03-upload-processing/TD-11
advisories: []
---

# phase-03-upload-processing — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI fora do escopo deste slice — `## UI Inventory` ausente.)_

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — Download: quem pode baixar e qual arquivo. Clarificação: na Fase 03 o download é **somente do dono do canal** e entrega o **arquivo original** enviado (URL pré-assinada com `ResponseContentDisposition=attachment`, per TD-09). A Fase 05 amplia o público (visitantes/anônimos) junto com as regras de visibilidade e o botão na UI.
- **AMB-2** _(resolved_by clarification)_ — Streaming na Fase 03. Clarificação: somente o **dono do canal** obtém URL de streaming de rascunhos; qualquer outro solicitante recebe **404** até a Fase 04 introduzir visibilidade. Vídeo em `uploading`, `processing` ou `failed` responde **409** com código de domínio (ex.: `VIDEO_NOT_READY`) no envelope de `phase-02-auth/TD-07`.
- **AMB-3** _(resolved_by clarification)_ — Pré-cadastro do rascunho. Clarificação: título inicial **derivado do nome do arquivo** (sem extensão, truncado ao limite da coluna); descrição e categoria nulas até a Fase 04. O vídeo pertence ao **canal** (`channel_id` FK), alinhado ao painel e à página pública do canal.
- **AMB-4** _(resolved_by clarification)_ — Metadados e estados. Clarificação: persistir **duração, largura/altura, codec de vídeo, codec de áudio, tamanho em bytes e mime**. Ciclo de estados: `uploading` → `processing` → `ready` | `failed` (com motivo da falha persistido). A **normalização para MP4 com `faststart` (TD-08 B) faz parte do processamento da Fase 03**.
- **OQ-1** _(resolved_by phase-03-upload-processing/TD-01)_ — TD-01 decidida: A (S3 Multipart com URLs pré-assinadas por parte).
- **OQ-2** _(resolved_by phase-03-upload-processing/TD-02)_ — TD-02 decidida: A (MinIO no Compose + `@aws-sdk/client-s3` v3).
- **OQ-3** _(resolved_by phase-03-upload-processing/TD-03)_ — TD-03 decidida: A (BullMQ + Redis via `@nestjs/bullmq`).
- **OQ-4** _(resolved_by phase-03-upload-processing/TD-04)_ — TD-04 decidida: A (container separado, mesmo codebase).
- **OQ-5** _(resolved_by phase-03-upload-processing/TD-05)_ — TD-05 decidida: A (FFmpeg do sistema + wrapper sobre `spawn`).
- **OQ-6** _(resolved_by phase-03-upload-processing/TD-06)_ — TD-06 decidida: A (endpoint explícito de conclusão na API).
- **OQ-7** _(resolved_by phase-03-upload-processing/TD-07)_ — TD-07 decidida: B (base62 aleatório em `public_id`).
- **OQ-8** _(resolved_by phase-03-upload-processing/TD-08)_ — TD-08 decidida: B (MP4 H.264/AAC normalizado com `+faststart`).
- **OQ-9** _(resolved_by phase-03-upload-processing/TD-09)_ — TD-09 decidida: A (URLs pré-assinadas de curta duração).
- **OQ-10** _(resolved_by phase-03-upload-processing/TD-10)_ — TD-10 decidida: A (lifecycle do bucket + job de rascunhos).
- **OQ-11** _(resolved_by phase-03-upload-processing/TD-11)_ — TD-11 decidida: C (prefixo público `thumbnails/`, chaves imprevisíveis e imutáveis).
- **OQ-12** _(resolved_by phase-03-upload-processing/TD-12)_ — TD-12 decidida: B (fixtures geradas sob demanda com FFmpeg `lavfi` no `globalSetup` do Jest, stream sintético em múltiplos de 5 MB para o multipart e limite de upload reduzido por configuração no ambiente de teste).
