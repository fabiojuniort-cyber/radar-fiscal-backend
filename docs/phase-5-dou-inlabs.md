# DOU / INLABS — investigação e preparação de acesso

Data: 2026-09-21. Base inspecionada: `main` em `23c79a4c205399358572cc5833cd10e7bb164dab`.

**Status: frente em andamento, bloqueada para validação real por falta de acesso autenticado ao INLABS.**
Este documento não certifica captura, persistência, classificação ou operação produtiva do DOU.
O código entregue nesta etapa é um cliente de transporte; ainda não está registrado como conector no Worker.

## Decisões recebidas

O encaminhamento do Gerente Geral determina a ADR-042: DOU certificado como fonte primária,
INLABS como canal de ingestão e portais dos órgãos como enriquecimento/validação.
O conector deverá ser genérico, inicialmente para Seção 1, e comprovar os quatro tipos de atos CONFAZ.
As migrations 001–009 e o algoritmo global de identidade, inclusive `publishedOn`, permanecem intactos.
PRs 14/15, relay, Fly.io, Lightsail e proxies adicionais continuam fora desta frente.

## Evidências oficiais consultadas

- [Portal de acesso INLABS](https://inlabs.in.gov.br/acessar.php): formulário de cadastro/login; aviso sobre XML, PDF e versão certificada.
- [Repositório oficial](https://github.com/Imprensa-Nacional/inlabs): revisão observada `b73795a16ecdf53d2f9f66de86a0e3c7aa087042`.
- [Download XML em Python](https://github.com/Imprensa-Nacional/inlabs/blob/b73795a16ecdf53d2f9f66de86a0e3c7aa087042/public/python/inlabs-auto-download-xml.py).
- [Download PDF em Bash](https://github.com/Imprensa-Nacional/inlabs/blob/b73795a16ecdf53d2f9f66de86a0e3c7aa087042/public/bash/inlabs-auto-download-pdf.sh).
- [Orientações oficiais Python](https://github.com/Imprensa-Nacional/inlabs/blob/b73795a16ecdf53d2f9f66de86a0e3c7aa087042/public/python/README.md).

São fontes oficiais disponíveis na revisão consultada; não constituem garantia de que todos os formatos
continuam idênticos no serviço autenticado. Essa comparação depende da primeira consulta real.

| Tema | Evidência / limite |
| --- | --- |
| Autenticação | POST HTTPS `/logar.php`, campos `email` e `password`; scripts verificam `inlabs_session_cookie`. Cadastro exige dados do titular. |
| XML | ZIP por data e seção: `/index.php?p=AAAA-MM-DD&dl=AAAA-MM-DD-DO1.zip`. O ZIP contém XML segundo a documentação; schema e conteúdo ainda não inspecionados. |
| Seções | Scripts XML enumeram DO1, DO2, DO3 e DO1E, DO2E, DO3E. A prioridade inicial será DO1/DO1E. |
| PDF normal | `AAAA_MM_DD_ASSINADO_do1.pdf`, análogos do2/do3. |
| PDF extra | Script Bash enumera `AAAA_MM_DD_ASSINADO_do1_extra_A.pdf` até letras posteriores; o script Python não faz essa enumeração explícita. Não presumir que o PDF normal contenha todas as extras. |
| Suplementos | Os scripts consultados não demonstram convenção própria. Não inventar DO1S ou equivalentes. Inspecionar listagem autenticada e uma edição oficial real. |
| Disponibilidade | Portal informa disponibilização diária após publicação no portal da Imprensa Nacional. Não há SLA/horário fixo comprovado; cron às 10:01 do exemplo Bash é uma sugestão de execução, não horário garantido da fonte. |
| Histórico | README menciona acesso gratuito desde 2020-01-01; cobertura histórica completa e retenção não foram verificadas. |
| Limites | Não foi encontrada quota formal nas fontes consultadas. Isso não equivale a acesso ilimitado. Não reproduzir retries recursivos sem limite dos exemplos. |
| Referência legal | O próprio portal alerta que XML não substitui a versão certificada. URL de download INLABS e URL certificada da matéria devem ser preservadas separadamente. |

O acesso à raiz do INLABS retornou rejeição de requisição, enquanto `/acessar.php` respondeu.
Isso não prova indisponibilidade geral nem erro de credencial. Não houve tentativa de login com credencial inventada.

## Cliente de transporte entregue

`inlabs.client.ts` utiliza os endpoints e convenções acima, sem nova dependência:

- credenciais injetadas pelo chamador; futuras variáveis propostas: `INLABS_EMAIL` e `INLABS_PASSWORD`;
- cookie em campo privado, apenas em memória por tentativa, descartado por `close()`;
- redirecionamentos manuais, sem encaminhar cookie/senha a outro host;
- requisições canceláveis pelo sinal do executor existente; nenhum retry interno;
- erros distintos para credenciais ausentes, autenticação, bloqueio de acesso, falha de rede, 429, 5xx e conteúdo inesperado;
- limite de bytes antes e durante leitura, assinatura inicial ZIP/PDF e SHA-256 dos bytes recebidos;
- 404 significa somente arquivo não disponível naquele instante, após verificar a sessão na listagem;
- resposta HTML de login ou bloqueio não é aceita como arquivo;
- ausência de logs de credenciais, cookies, corpo HTTP ou causas de erro externas.

A checagem de assinatura inicial não valida integridade do ZIP nem assinatura digital do PDF.
A leitura da listagem ainda precisa de validação estrutural positiva com a página real; não usar este cliente
isoladamente para concluir `SUCCESS_NO_RESULTS` ou avançar checkpoint.
O cliente não registra fonte, não chama IA, não persiste publicações e não baixa histórico automaticamente.

## Inspeção do Motor de Coleta

| Componente existente | Reuso / cuidado necessário |
| --- | --- |
| `CollectionConnector` / registry / executor | Preservar `collect(context)` e registrar `dou` somente após parser e validação de amostras. |
| `ConnectorPublication` | Campos comuns disponíveis; seção, edição, página, unidade, ementa, data do ato, referência certificada e metadados originais cabem em `metadata`. |
| Normalizador | Identidade forte exige esfera, órgão, tipo, número e publicação. Número/ano e órgão canônico precisam coincidir com CONFAZ, preservando o órgão original completo nos metadados. Sem prova de equivalência, usar identidade source-scoped existente. |
| Persistência global | Publicações/origins/versões são globais, sem cópia por tenant. Não introduzir acesso a tabelas por empresa nesta etapa. |
| Versions / URL primária | `getOrCreateVersion` atualiza `primary_official_url` para a URL da última versão inserida. Uma versão CONFAZ posterior poderia substituir a referência DOU. Essa precedência ainda não implementa a ADR-042. |
| Arquivos | Normalizador preserva descriptors em metadata. Há tabela `publication_files`, mas nenhum adaptador de object storage/download/persistência de binários implementado na base inspecionada. Não declarar arquivos preservados em storage. |
| Attempts / monitoramento | `ConnectorResult.metadata` já chega a `collection_attempts.metadata`. Edições e matérias podem ter contadores sem migration, mas o snapshot de monitoramento ainda não expõe esses campos específicos. |
| Heartbeat | O timer do engine é encerrado após `executeConnector`, antes do loop de persistência. Uma edição grande pode exceder a janela de stale durante persistência. Antes de habilitar DOU, cobrir esse cenário e ajustar o ciclo de vida. |
| Backfill | `trigger_type=BACKFILL` existe, porém o contexto do conector não traz trigger nem intervalo. Separar parâmetros por run exige adaptação explícita e teste; não alterar configuração da fonte compartilhada enquanto Scheduler roda. |

## Estratégia incremental proposta, ainda não ativada

1. Uma única fonte global `dou`, com timezone America/Sao_Paulo, usando Worker e Scheduler existentes.
2. Consulta de hora em hora, incluindo fim de semana para extras. Descobrir os arquivos do dia na listagem oficial;
   repetir a descoberta durante o dia para detectar extras novas e ZIPs republicados.
3. Janela inicial de revisita proposta: dia corrente mais dois dias anteriores. É uma política operacional provisória,
   não uma garantia sobre atraso da fonte. Ajustar com medições e prever reconciliação de atrasos maiores.
4. Separar data civil, seção e edição de filename. Não assumir relação 1 ZIP = 1 edição nem usar só a data como checkpoint.
5. Identificar pacote por origem/data/seção/filename e hash dos bytes; identificar matéria pelo identificador oficial.
   O hash do ZIP inteiro não deve participar de `content_hash` de todas as matérias: uma matéria extra no ZIP causaria
   versões artificiais das demais. Guardar proveniência do pacote separada do hash dos arquivos individuais.
6. Reaproveitar validators HTTP somente se verificados no serviço; não tratar `Last-Modified`/ETag como disponíveis por suposição.
7. Checkpoint somente após persistência bem-sucedida, nunca ao concluir download. Para a primeira implementação,
   avaliar metadata de runs/attempts com status terminal SUCCESS como recibo, sem assumir que attempt SUCCESS prova persistência.
   Falha parcial deve manter pacote/itens elegíveis para replay idempotente.
8. Lacunas após indisponibilidade maior que a janela devem ser visíveis e recuperadas em lotes limitados; não avançar data
   silenciosamente nem disparar backfill integral. Limites de lote/volume serão medidos com edição real.
9. Não chamar IA nem filtrar por relevância tributária. A contagem de atos CONFAZ é classificação estrutural de uma ingestão genérica.

## Backfill proposto

Separar do fluxo horário e iniciar por uma única data escolhida para validação. Medir bytes comprimidos/descomprimidos,
número de matérias, duração de download/parsing/persistência, memória, crescimento de publicações/versões/origins e espaço em disco.
No estado observado, o Postgres tem volume de 500 MB; isso é capacidade configurada, não espaço livre medido.
Não executar backfill massivo sem essas medições. Qualquer armazenamento de originais depende da decisão de infraestrutura abaixo.

## Papéis e decisões para o Gerente Geral

Não foi criada migration. `PRIMARY`, `ENRICHMENT` e `VALIDATION` podem inicialmente ser convenções explícitas
em `sources.connector_config` e `publication_origins.metadata`, mas isso sozinho não controla a versão vigente.

Decisões a fechar antes de declarar conformidade integral:

1. **Storage de originais:** não existe infraestrutura implementada a reutilizar nesta base. Definir/prover adaptador comum
   aprovado ou aceitar provisoriamente somente referência + hash + texto, com retenção de bytes explicitamente pendente.
2. **Precedência DOU × enriquecimento:** implementar preservação da URL certificada e definir como conteúdo complementar
   convive com `is_current`. Metadados de origem dispensam migration inicialmente; a política de versão precisa ser explícita.
3. **Checkpoints e backfill por run:** avaliar adaptação mínima usando metadata existente, incluindo permissão do worker,
   atomicidade e recuperação; propor alteração estrutural somente se demonstrada necessária. Nenhuma foi aplicada.

`identity_hash`, `content_hash`, `publishedOn`, parser CONFAZ e migrations permaneceram sem alterações.
Não há evidência nova nesta frente que justifique mudar a identidade normativa.

## Validação e bloqueios

- Base: typecheck e 51 testes unitários existentes aprovados.
- Transporte: 13 testes novos aprovados, com HTTP simulado; não são fixtures de atos oficiais.
- Nesta estação, o launcher `tsx --test` tentou criar IPC não permitido. Executado `node --import tsx --test` com sucesso,
  preservando o runner `node:test` e o carregador tsx. O comando existente do CI não foi alterado.
- CI do PR: verificar o resultado no GitHub; não confundir aprovação de testes sintéticos com captura real.
- Railway: API, Worker, Scheduler e Postgres reportaram deployment SUCCESS; Worker e Scheduler seguem `main`.
  Não havia variáveis INLABS no Worker na inspeção. Nenhuma configuração/deployment foi alterada nesta etapa.
- Login real, download de edição, schema XML, suplementos, referências certificadas por matéria, amostras CONFAZ,
  persistência DOU, dedup entre fontes, checkpoint, execução real Worker/Scheduler e métricas específicas seguem pendentes.

Para destravar a inspeção, o titular deve criar/ativar conta no portal INLABS e disponibilizar uma amostra oficial
(ZIP XML da Seção 1, idealmente com atos CONFAZ, e depois uma extra/suplemento disponível).
Não enviar senha em conversa, arquivo, commit ou log. Credenciais produtivas deverão ser cadastradas como secrets do Railway.

## Gate de aceitação obrigatório

Ainda **não atendido**: localizar e persistir Convênio ICMS, Ajuste SINIEF, Protocolo ICMS e Ato COTEPE/ICMS reais,
conferindo tipo/número/data/ementa/texto/órgão/referência oficial, além de despachos e ratificações relacionados.
Somente depois desses testes e da execução Railway será possível declarar eliminada a dependência crítica do CONFAZ.

Esta é uma pausa por acesso externo, não encerramento da frente nem retorno final ao Gerente Geral.
Retomar aqui com a amostra/autenticação; ao satisfazer os gates, consolidar o handoff e recomendar a próxima frente ao Gerente Geral.
Não iniciar outros conectores neste trabalho.

## Evidência adicional: manutenção no cadastro

O usuário apresentou captura da página `/registrar.php` com o aviso “Sistema em Manutenção Programada”.
Isso comprova a resposta exibida naquela tentativa de cadastro, não indisponibilidade de todas as rotas nem
o status HTTP da resposta. A consulta pública de leitura ainda retornou o formulário em `/acessar.php`;
ela não executou cadastro nem comprovou sua recuperação. O aviso não informa prazo de retorno.

O cliente agora reconhece o texto de manutenção em login, índice e respostas não binárias de download,
inclusive quando servido com HTTP 200. Classifica como `INLABS_MAINTENANCE` / `SOURCE_UNAVAILABLE`,
com retry permitido pelo Motor e preservação de `Retry-After` quando recebido. Uma edição 404 seguida de
índice em manutenção não vira `NOT_AVAILABLE`. PDFs/ZIPs válidos não são classificados pelo texto de manutenção.

Cinco testes de regressão usam HTML sintético baseado no texto visível da captura, sem apresentar esse HTML
como fixture baixada da fonte. A inspeção do schema XML e os gates reais continuam pendentes.
