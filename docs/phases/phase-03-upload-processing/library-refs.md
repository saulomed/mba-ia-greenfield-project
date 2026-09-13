---
libs:
  "@aws-sdk/client-s3":
    version: "^3.x (não instalado — fixar na implementação)"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-13T16:17:46Z"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x (não instalado — mesma minor de @aws-sdk/client-s3)"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-13T16:17:46Z"
  "@nestjs/bullmq":
    version: "^11.x (não instalado — compatível com @nestjs/core ^11.0.1)"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-09-13T16:17:46Z"
  "bullmq":
    version: "^5.x (não instalado — peer de @nestjs/bullmq)"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-13T16:17:46Z"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-09-13T17:04:25Z"
---

# Library References — Fase 03 (Upload e Processamento)

Cache de documentação (Context7) das bibliotecas decididas em `phase-03-upload-processing`. Excertos focados nos usos definidos pelas TDs. Nenhuma das bibliotecas está instalada em `nestjs-project/package.json` ainda: as versões são faixas compatíveis com o stack atual (NestJS 11) e devem ser fixadas no momento da instalação.

## @aws-sdk/client-s3

_Usado por: phase-03-upload-processing/TD-01 (multipart), TD-02 (cliente de storage), TD-06 (conclusão), TD-10 (lifecycle), TD-11 (política de prefixo)._

### Cliente para MinIO (S3-compatível)

Endpoint customizado exige `forcePathStyle: true`, porque o bucket vai no path e não em subdomínio DNS. `ForcePathStyle` tem default `false` no endpoint rule set do S3.

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  endpoint: 'http://minio:9000',
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
});
```

Import modular: importe `S3Client` e cada `*Command` individualmente e envie com `client.send(new XCommand(input))`.

### Multipart upload (TD-01 / TD-06)

- `CreateMultipartUploadCommand({ Bucket, Key, ContentType? })` → retorna `UploadId`.
- `UploadPartCommand({ Bucket, Key, PartNumber, UploadId, Body })` → `PartNumber` entre 1 e 10000; a resposta traz `ETag`, necessário no complete. Na TD-01 este comando é **pré-assinado** e o navegador faz o PUT direto (ver `@aws-sdk/s3-request-presigner`).
- `ListPartsCommand({ Bucket, Key, UploadId })` → partes já recebidas, para retomada.
- `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })`.
- `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`.
- `HeadObjectCommand({ Bucket, Key })` → `ContentLength` para validar o limite de 10GB após o complete (TD-06).

### Lifecycle de multipart incompleto (TD-10)

`PutBucketLifecycleConfigurationCommand` com uma regra `AbortIncompleteMultipartUpload: { DaysAfterInitiation: N }`: o storage remove as partes de uploads não concluídos após N dias.

### Política de leitura por prefixo (TD-11)

`PutBucketPolicyCommand` com `s3:GetObject` anônimo restrito a `arn:aws:s3:::<bucket>/thumbnails/*`, sem `s3:ListBucket`. No MinIO o equivalente administrativo é `mc anonymous set download ALIAS/<bucket>/thumbnails`.

## @aws-sdk/s3-request-presigner

_Usado por: phase-03-upload-processing/TD-01 (URLs de `UploadPart`), TD-09 (URLs de streaming/download)._

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

const partUrl = await getSignedUrl(
  client,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

const downloadUrl = await getSignedUrl(
  client,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="video.mp4"' }),
  { expiresIn: 3600 },
);
```

- `expiresIn` é opcional; o default é **900 s** e o valor do usuário sobrescreve o default.
- `ResponseContentDisposition` em `GetObjectCommand` controla o nome e o modo `attachment` do download (TD-09, AMB-1).
- A assinatura usa a configuração do client (`...client.config`), inclusive o host do endpoint. Como a URL precisa ser acessível pelo navegador, assine com um `S3Client` configurado com o **endpoint público** do storage, separado do client interno (`minio:9000`) usado pela API (ver Cons da TD-02).

## @nestjs/bullmq

_Usado por: phase-03-upload-processing/TD-03 (fila), TD-04 (worker em processo separado), TD-06 (enfileiramento), TD-10 (job agendado)._

### Conexão via ConfigService

Segue o padrão herdado de `registerAs` + injeção (phase-01-configuracao-base/TD-01..TD-03):

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => ({
    connection: {
      host: configService.get('QUEUE_HOST'),
      port: configService.get('QUEUE_PORT'),
    },
  }),
  inject: [ConfigService],
});
```

### Registro, publicação e consumo

```typescript
BullModule.registerQueue({ name: 'video-processing' });

@Injectable()
export class VideoUploadsService {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
}

await this.queue.add('process', { videoId }, { jobId: videoId });
```

```typescript
@Processor('video-processing')
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job): Promise<void> {
    await job.updateProgress(50);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job) {}
}
```

- O nome em `@InjectQueue()` precisa bater com o nome em `registerQueue()`.
- Os consumers precisam ser registrados como providers do módulo para serem descobertos. Na TD-04 A, o `@Processor` fica **somente** no `WorkerModule` (entrypoint do worker) e não no `AppModule` da API.
- Os sandboxed processors (`registerQueue({ processors: [path] })`) não têm DI e foram rejeitados na TD-04.

## bullmq

_Usado por: phase-03-upload-processing/TD-03, TD-06 (idempotência), TD-10 (agendamento)._

- **Retry com backoff:** `queue.add(name, data, { attempts: 5, backoff: { type: 'exponential', delay: 1000 } })`.
- **Parar retries:** lançar `UnrecoverableError` move o job direto para `failed`, ignorando `attempts`. Use para mídia inválida ou corrompida (estado `failed` com motivo, AMB-4).
- **Idempotência:** um `jobId` customizado evita duplicar o job do mesmo vídeo (TD-06). Existe também `deduplication: { id }`, que deduplica até o job completar ou falhar.
- **Jobs agendados (TD-10):** `queue.upsertJobScheduler(schedulerId, { pattern: '<cron>' } | { every: ms }, { name, data, opts })` cria ou atualiza um job repetível, idempotente pelo `schedulerId`.
- **Limpeza:** as opções `removeOnComplete` / `removeOnFail` por job controlam a retenção no Redis.
