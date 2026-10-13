# F2 T03 — runner operacional TEMPORÁRIO (NÃO MERGEAR)

Base da branch: merge backend #221 `1475eb10da081316f632b0ef1af7da252840cea4`. Escopo EXCLUSIVO: ensaio isolado, **carga de produção proibida**.

## Estado inicial seguro

- `F2_PROOF_ENABLED=false` e `SOURCE_PG_DUMP_URL=` (vazia).
- Runner com `restartPolicy=NEVER`, sem cron, `bash ops/f2-t03-proof/run.sh`; desligado por padrão.
- Projeto Railway TEMP com Postgres 18 TEMP separado, base **`radar_fiscal_test`**, bucket privado TEMP.
- Senha/URL admin de produção SOMENTE no `SOURCE_PG_DUMP_URL` fornecido diretamente pelo Fábio via UI privada Railway. **Nunca em commits, logs, issues, chat, scripts ou outro comando que não seja `pg_dump`**.
- Após credencial e **novo OK explícito do Fábio**, ativar flag, redeployar runner UMA vez, verificar logs. Antes disso **NÃO executar**.

## XLSX originais exigidos (base64 puro, UTF-8 sem prefixo)

Os **dois arquivos estão disponíveis na raiz da branch**, enviados pelo Fábio no commit `fbfe54e` e validados contra os hashes originais. O runner aceita os caminhos da **raiz** ou de `ops/f2-t03-proof/`; não substituir por arquivos reserializados:

| Caminho | SHA-256 esperado após base64 -d |
| --- | --- |
| `Radar_Fiscal_Carga_Segmento_Revisada_v5.1.xlsx.b64` (raiz) | `695b0df85339ec60a2b1bc8b88b842ac09a55e71d90c3f7eb2443f1709c6af67` |
| `Radar_Fiscal_Carga_Produto_Revisada_v5.xlsx.b64` (raiz) | `261da490a5a030e698d43030c6a552cf39cc3f025f0249f71ffff1001b57051a` |

Conferência após o upload: Git blob SHA-1 remoto idêntico ao blob local para os dois `.b64`; XLSX decodificados têm SHA-256 `PASS` (2/2). O script repetirá a decodificação e os hashes ao ser autorizado a executar.

O JSON NCM **não** pertence ao runner: conferência independente já concluída 0 NCM ausentes (Produto 8.179 / Segmento 5.198). O CLI oficial recebe somente dois XLSX.

## Variáveis necessárias no runner

| Nome | Inicialização |
| --- | --- |
| `F2_PROOF_ENABLED` | **false** |
| `SOURCE_PG_DUMP_URL` | **vazia** — Fábio cola na UI Railway |
| `DATABASE_ADMIN_URL` | referência privada para o **Postgres TEMP**, database radar_fiscal_test |
| `NODE_ENV` | test |
| `F2_IMPORT_SCOPE` | ISOLATED_POSTGRES18_ONLY |
| `BACKUP_BUCKET_ENDPOINT` | referência Railway para endpoint do bucket TEMP |
| `BACKUP_BUCKET_NAME` | referência Railway para bucket TEMP |
| `AWS_ACCESS_KEY_ID` | referência Railway ao bucket TEMP |
| `AWS_SECRET_ACCESS_KEY` | referência Railway ao bucket TEMP |
| `AWS_DEFAULT_REGION` | referência Railway para região do bucket TEMP |

Nunca reutilizar `DATABASE_ADMIN_URL` produtiva. A função `stageF2Payload` verifica independentemente o nome do banco `radar_fiscal_test`, PostgreSQL >=18 e as flags test/isolado. O script também verifica que host da origem e destino são distintos.

## Evidências/gates somente após novo OK

1. SHA dos XLSX; `pg_dump` admin PROD sempre com `PGOPTIONS="-c default_transaction_read_only=on"`. Contagens de `public.taxonomy_*` antes e depois também mediante `pg_dump`, sem `psql` produtivo.
2. Dump principal `-Fc`, SHA-256, início UTC e tamanho; bucket S3 TEMP (verificação SHA no download). Validade **24 h desde início do dump**.
3. Roles/globals de owners recriadas como `NOLOGIN` sem senha somente no PG TEMP. `pg_restore --exit-on-error --single-transaction`, sem erros.
4. `npm ci` lockfile no Dockerfile (yauzl v3.4.0 nativo), CLI oficial: 0 erros, 448 avisos.
5. Job 1 no **PG TEMP**: 1 batch, 1.332 CNAEs, 4.225 produtos; G/H intactas — 4.545/738 e 5.198/645; 0 divergências de readback linha a linha.
6. Job 2: mesmo lote, 0 inserções e 0 alterações. Confirmação de totais `taxonomy_*` da produção antes/depois **idênticos**.
7. Encerrar: retirar credenciais no Railway, start inerte, `restartPolicy=NEVER`; preservar bucket e PG TEMP para exclusão pelo Fábio.

**Nenhum PASS oficial deve ser declarado até a execução e revisão dos logs; não equivale a carga produtiva.** Para carga PROD, o writer atual **não** possui caminho produtivo (`NODE_ENV=test`, escopo isolado, `radar_fiscal_test`); nunca burlar com alteração de variáveis. Novo executor/contrato de carga PROD exigirá código, revisão, CI, backup restaurado válido e OK explícito do Fábio.
