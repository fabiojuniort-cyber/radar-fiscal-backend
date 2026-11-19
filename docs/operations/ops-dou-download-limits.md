# OPS-DL-01 — Limites operacionais do DOU

Controle na [Issue #103](https://github.com/fabiojuniort-cyber/tribusca-control/issues/103). O candidato compõe o escopo útil do #200 com a main que contém o AUTH-RESET. A migration `087_ops_dou_download_limits.sql` ocupa um número após a 085 e preserva a 086 proposta no #316.

## Contrato para o Web

`GET /api/v1/admin/platform/dou-download-limits` devolve `limits`, `configured`, `editable`, `updatedAt` e `limitsNotice`. Ambos os métodos exigem `PLATFORM_ADMIN`. `PUT` recebe somente os quatro limites globais inteiros em MiB.

| Campo | Default e teto |
| --- | --- |
| `pdfMiB` | 20 |
| `zipMiB` | 64 |
| `expandedZipMiB` | 128 |
| `xmlEntryMiB` | 8 |

Cada campo começa em 1 e o ZIP expandido precisa admitir pelo menos o limite compactado. O backend rejeita entradas fora do contrato. Sem configuração do gateway, o GET retorna `editable=false` e o PUT retorna 503. O PUT bem-sucedido devolve a configuração confirmada com `configured=true`. O worker lê os limites por fonte a cada tentativa e mantém o tratamento de arquivo acima do teto como erro de coleta. PDF permanece reservado à atestação seletiva.

## Banco e evidência

A configuração fica em `sources.connector_config.douDownloadLimits`. A gravação usa o login SQL dedicado `radar_dou_limits_runtime`, as variáveis `DATABASE_DOU_LIMITS_URL`, `DB_DOU_LIMITS_PASSWORD` e `DOU_LIMITS_SIGNING_SECRET`, e a confirmação da role de plataforma no banco. A migration cria o login sem acesso de login. O app e o worker mantêm seus próprios papéis. A atualização, o nonce e o evento `DOU_DOWNLOAD_LIMITS_UPDATED` participam da mesma transação. O evento usa o UUID da fonte e só projeta os quatro campos inteiros.

O workflow dedicado usa PG16 e PG18 descartáveis, com instalação limpa e upgrade da main fixada. Em upgrade, compara ledger e catálogos do AUTH antes e depois da migration. Os testes verificam limites efetivos, atomicidade, permissões e o contrato de leitura pelo worker. A validação de credenciais, a medição operacional de arquivos reais e a liberação do Web dependem dos respectivos gates.
