# DOU / INLABS — implementação e evidências

Atualizado em 2026-09-21. Base: `main` em `23c79a4c205399358572cc5833cd10e7bb164dab`.
PR #16 permanece draft. **Não concluído nem habilitado em produção.** Parser e conector usam XMLs reais enviados pelo titular para DO1/DO1E e já foram validados ao vivo no Railway contra as seis variantes DO1/DO1E, DO2/DO2E e DO3/DO3E. O runtime foi ampliado para coletar as três seções normais e extras; gate CONFAZ, suplementos, armazenamento dos originais e políticas finais de precedência/reconciliação continuam pendentes.

## Diretrizes preservadas

ADR-042 recebida: DOU certificado é primário; INLABS é ingestão; portais dos órgãos são enriquecimento/validação.
Publicação global, sem duplicação por tenant, sem IA e sem Motor de Relevância. Migrations 001–009, algoritmo de identidade (incluindo `publishedOn`) e parser CONFAZ permanecem intactos. Nenhuma evidência justifica modificar a identidade normativa.
PRs 14/15, relay, Fly.io, Lightsail e proxies adicionais permanecem congelados. Nenhum outro conector foi iniciado.

## Fontes e acesso

- [Portal INLABS](https://inlabs.in.gov.br/acessar.php).
- [Código oficial](https://github.com/Imprensa-Nacional/inlabs), revisão consultada `b73795a16ecdf53d2f9f66de86a0e3c7aa087042`.
- [XML Python](https://github.com/Imprensa-Nacional/inlabs/blob/b73795a16ecdf53d2f9f66de86a0e3c7aa087042/public/python/inlabs-auto-download-xml.py) e [PDF Bash](https://github.com/Imprensa-Nacional/inlabs/blob/b73795a16ecdf53d2f9f66de86a0e3c7aa087042/public/bash/inlabs-auto-download-pdf.sh).
- Ajuda oficial copiada pelo usuário da sessão autenticada, recebida em 2026-09-21, com dicionário XML.
- ZIPs oficiais de 2026-09-18, normal e extra, baixados e enviados pelo usuário. Manifesto das fixtures registra hashes dos originais.

A captura anterior mostrou manutenção em `/registrar.php`. Depois o titular conseguiu entrar com conta existente e visualizar as pastas. Isso comprova acesso no navegador do titular, não acesso autenticado do Worker. A captura não comprova status HTTP, SLA ou indisponibilidade de todas as rotas.

| Tema | Evidência e implementação |
| --- | --- |
| Login | POST HTTPS `/logar.php`, email/password, cookie `inlabs_session_cookie`, header `origem`. Cookie privado em memória por tentativa; sem logs/código contendo credenciais. |
| XML | `index.php?p=AAAA-MM-DD&dl=AAAA-MM-DD-DOx.zip`. Em validação live no Railway, 2026-09-18 retornou com sucesso as seis variantes `DO1`, `DO1E`, `DO2`, `DO2E`, `DO3`, `DO3E`, todas sem falha de parsing. |
| Extra | DO1E contém várias edições: 177-A, B, C e D no mesmo ZIP. Não se assume ZIP = edição. |
| PDF | Convenção oficial normal `AAAA_MM_DD_ASSINADO_do1.pdf`; extras `..._do1_extra_A.pdf` e letras seguintes. Transporte implementado, sem captura/armazenamento de PDF nesta validação. |
| Suplementos | Convenção ainda não comprovada. Não inventamos DO1S; metadata informa `supplementsVerified=false`. |
| Disponibilidade | Ajuda permite disponibilizar XML até o quinto dia útil do mês seguinte. O aviso de publicação diária tem ressalva para XML. Não prometer ingestão XML em tempo real. |
| Quotas | Nenhuma quota formal identificada. Downloads sequenciais, lote limitado, timeout/cancelamento herdados do executor e retries centralizados no Motor. |
| Histórico | README menciona desde 2020; cobertura/retenção completa não verificada. Não foi executado backfill histórico. |

## Dicionário e parser

`article@id` é ID editorial GN4; não serve para inventar links no Portal. `idMateria` é o ID da matéria no Portal. `idOficio` identifica lote e não é identidade da matéria. `pdfPage` é referência certificada de página, compartilhada por várias matérias.

O parser valida UTF-8, estrutura XML, ausência de DTD, data, nome de arquivo, identificadores, seção e referência certificada. Bibliotecas fixadas em package-lock: sax, yauzl e htmlparser2. ZIP: CRC32/tamanho, 64 MiB comprimido, 128 MiB descomprimido, 8 MiB por entrada e até 5.000 entradas; leitura sequencial sem extrair caminhos no disco. Esses limites são operacionais provisórios, não limites publicados da fonte.

Continuações `idMateria-1.xml`, `-2.xml` etc. são reunidas em ordem numérica por jornal/idMateria, com metadados consistentes. Parte inválida ou lacuna observável rejeita a matéria inteira e conserva as outras. O formato observado não declara quantidade total de partes; não é possível detectar uma última parte ausente quando a sequência restante é contínua. Título pode estar vazio nas continuações. Texto HTML é convertido em texto; tabelas mantêm conteúdo textual, mas não diagramação. Imagens são contadas, não preservadas; conteúdo exclusivamente visual requer tratamento posterior.

Título, texto, órgão completo, unidade, tipo, número/ano, data de publicação, data do ato quando explícita, ementa, seção, edição, páginas, IDs e atributos originais são preservados, exceto bytes de highlightImage (somente indicador de presença, sem base64 no banco). Data de publicação vem de `pubDate`, não da data do ato. O dicionário menciona DOU1; a amostra usa DO1, respeitado pelo parser. Sem HTML oficial observado, `officialHtmlUrl=null`; nenhuma URL com slug é fabricada.

Identidade externa composta pelos campos observados `data:seção:edição:idMateria`, com ID original preservado em metadata. Classificação CONFAZ exige órgão explícito e cabeçalho apropriado; menção a ato no corpo não vira identidade daquele ato. Despachos e retificações sem número usam identidade source-scoped existente. A agência CONFAZ e famílias são normalizadas para compatibilidade com o conector existente, sem reimplementar seu parser.

## Evidência dos arquivos completos

| Arquivo | Bytes ZIP | XML | Mídias | Matérias reunidas | Falhas de parsing | Matérias CONFAZ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-09-18-DO1.zip | 2.409.302 | 358 | 6 | 351 | 0 | 0 |
| 2026-09-18-DO1E.zip | 52.506 | 14 | 0 | 12 | 0 | 0 |

As 363 matérias produziram 363 hashes de identidade distintos. Medição local de leitura/parsing/normalização: aproximadamente 342 ms normal e 13 ms extra; não inclui rede nem PostgreSQL e não dimensiona produção.
Normal: cerca de 4 MB descomprimidos; extra: 184.195 bytes. O volume PostgreSQL observado no Railway era 500 MB configurados, não espaço livre medido. Não extrapolar uma única data para backfill.

Fixtures versionadas: 12 XMLs originais, bytes e hashes preservados, representando dez matérias (incluindo três despachos da Fazenda na mesma página e uma portaria em três partes). Testes também têm alterações sintéticas identificadas para versionamento e cabeçalhos sintéticos CONFAZ.

### Gate CONFAZ live — evidência parcial

A captura autenticada real no Railway em 2026-09-10, 2026-09-14 e 2026-09-15 comprovou matérias CONFAZ no XML oficial do DOU, com zero falhas de parsing nas edições consultadas. Exemplos capturados:
- `DESPACHO Nº 41, DE 9 DE SETEMBRO DE 2026` → CONFAZ, número `41/2026`;
- `ATO COTEPE/ICMS Nº 86, DE 9 DE SETEMBRO DE 2026` → CONFAZ, número `86/2026`;
- `ATO COTEPE ICMS Nº 87, DE 9 DE SETEMBRO DE 2026` → CONFAZ, número `87/2026`;
- `ATO COTEPE ICMS Nº 88, DE 9 DE SETEMBRO DE 2026` → CONFAZ, número `88/2026`;
- `ATO COTEPE/ICMS Nº 94, DE 11 DE SETEMBRO DE 2026` e `95/2026`;
- `ATO COTEPE/ICMS Nº 96, 97 e 98, DE 14 DE SETEMBRO DE 2026`;
- despachos, atos declaratórios e retificações vinculadas ao CONFAZ.

As referências certificadas `pesquisa.in.gov.br`, data, página, external_id e data de publicação foram preservadas. Tentativas posteriores, destinadas a localizar exemplos reais de Convênio ICMS, Ajuste SINIEF e Protocolo ICMS, receberam HTTP 502 no login do INLABS e foram classificadas como `INLABS_UNAVAILABLE`, `SOURCE_UNAVAILABLE`, `retryable=true`. Esse erro não foi convertido em autenticação inválida nem em ausência de publicação. O gate das três famílias restantes continua pendente exclusivamente por indisponibilidade temporária da fonte.

### Validação live Railway — DOU completo em 2026-09-18

Serviço temporário isolado `inlabs-validation`, branch `feat/dou-inlabs`, sem Scheduler e sem persistência PostgreSQL. Credenciais referenciadas a partir do Worker, sem exposição em logs. Login autenticado e índice diário foram aceitos; o índice retornou 12.418 bytes.

| Seção | ZIP bytes | XML | Mídias | Matérias | Falhas | Matérias com candidato textual a CNPJ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| DO1 | 2.409.302 | 358 | 6 | 351 | 0 | 125 |
| DO1E | 52.506 | 14 | 0 | 12 | 0 | 0 |
| DO2 | 975.740 | 760 | 0 | 760 | 0 | 5 |
| DO2E | 3.137 | 3 | 0 | 3 | 0 | 0 |
| DO3 | 2.819.018 | 2.143 | 2 | 2.139 | 0 | 999 |
| DO3E | 1.292 | 1 | 0 | 1 | 0 | 0 |

Total live: **3.266 matérias**, **0 falhas de parsing** e **1.129 matérias com candidato textual a CNPJ**. O contador de CNPJ nesta validação é apenas evidência exploratória do valor das Seções 2/3; ainda não é o Motor de Relevância nem um vínculo confirmado com tenant. A DO3 sozinha concentrou 999 candidatos, comprovando que limitar a ingestão à Seção 1 perderia grande parte das citações empresariais oficiais.

## Necessidade comprovada da migration 010

Os três XMLs `600_20260918_24382325`, `24382380` e `24382412` têm `idMateria` diferentes e apontam à mesma página 1 da edição 177-A. A unicidade antiga `(source_id, official_url)` rejeitaria matérias distintas. A edição normal também tem múltiplas matérias por página.

A 010 mantém unicidade de URL para origens de documento; referências explicitamente marcadas `officialUrlGranularity=PAGE` exigem external_id não vazio e usam a unicidade existente de `(source_id, external_id)`. Há índice não único para consulta por página. A persistência acompanha essa distinção e continua rejeitando um external_id ligado a outra identidade. Não há mudança nos hashes nem nas migrations antigas.

**Não aplicada em produção.** Implantação deve aplicar 010 antes de habilitar DOU. O runner usa transação, mas o rebuild de índice exige janela compatível com o volume real. Rollback após gravar várias origens na mesma página não pode simplesmente restaurar o índice único antigo: exige análise dos dados, sem apagar matérias para satisfazer o índice. Desativar o conector primeiro é a contenção reversível.

## Integração, incremental e recuperação

Registry registra `dou` somente com `DOU_CONNECTOR_ENABLED=true`; permanece desligado por padrão. `INLABS_EMAIL` e `INLABS_PASSWORD` vêm de secrets do Worker. Nenhuma fonte produtiva foi provisionada ou configuração Railway alterada nesta etapa.

Política provisória para execução horária em America/Sao_Paulo: dia corrente e dois anteriores, mais uma data rotativa do mês corrente/anterior. Com cobertura integral do DOU, o teto passa a quatro datas e até 24 ZIPs por tentativa (seis seções/edições por data). A reconciliação é limitada e precisa de medição de cobertura; não é garantia de completude mensal. Intervalo desde último sucesso acima de 60 dias exige recuperação explícita (`DOU_BACKFILL_REQUIRED`). Nenhuma indisponibilidade dispara coleta de todo histórico.

SHA-256 do pacote permite evitar parsing de ZIP inalterado, mas o download ainda ocorre; validators HTTP não foram comprovados. Hash do ZIP fica só em metadata, não no content_hash de todas as matérias. Os hashes individuais XML também ficam preservados. Alteração de uma matéria não deve criar versões das outras.

Recibos ficam em `collection_attempts.metadata.douArchives`, retidos por 65 dias e aceitos somente de runs terminais SUCCESS/SUCCESS_NO_RESULTS com attempt SUCCESS. Attempt SUCCESS sozinho ocorre antes da persistência e não é checkpoint. Falha parcial não avança recibos; próxima execução repete idempotentemente. Falha HTTP após outro pacote válido descarta o lote da tentativa e deixa retry com o Motor. A mudança no heartbeat mantém o timer durante persistência e fechamento do run; o comportamento preexistente de perda de ownership não foi redesenhado.

Nenhum pacote disponível gera erro explícito, retryable, `INLABS_EDITIONS_NOT_AVAILABLE`. Não é prova de dia vazio. Download 404 exige consulta do índice; validação estrutural positiva do índice autenticado ainda precisa ser conferida com HTML real. Parser inválido gera erro por matéria, com código e filename em metadata. Manutenção é distinguida de autenticação, WAF, rede, rate-limit, timeout e edição ausente. Um lote sem CONFAZ continua sendo sucesso de ingestão genérica, com contador CONFAZ zero.

BACKFILL produtivo é rejeitado sem lote explícito. A classe aceita até quatro datas injetadas para testes/validação controlada; o registry produtivo não expõe essa opção. Falta fechar interface de execução administrativa por run, sem alterar a configuração compartilhada da fonte. Antes de ampliá-la, medir duração, memória, crescimento do banco/storage e impacto Railway.

## Cobertura integral do DOU e citações empresariais

Decisão de escopo em 2026-09-21: a ingestão não ficará limitada à Seção 1. O Radar Fiscal deve poder detectar menções oficiais relacionadas a empresas/clientes, incluindo ocorrências por CNPJ, razão social e filiais. Por isso o conector passa a ingerir também Seções 2 e 3, normais e extras, preservando o conteúdo global uma única vez.

A classificação de uso fica separada da coleta: DO1/DO1E permanecem prioritários para legislação e atos normativos; DO3/DO3E são particularmente relevantes para contratos, editais, avisos, sanções e outras citações individualizadas; DO2/DO2E também são preservados para cobertura oficial completa. Nenhuma seção é descartada por parecer pouco tributária durante a ingestão.

O cruzamento por cliente será uma camada posterior, sem duplicar publicações: CNPJ completo, CNPJ normalizado, raiz quando aplicável, razão social e demais identificadores empresariais poderão gerar vínculos tenant-publication com o trecho comprobatório e uma classificação como benefício, credenciamento, multa/penalidade, sanção, contrato, licitação, decisão ou outra menção. A classificação não deve inventar vínculo quando o texto não o sustentar.

## Monitoramento

O snapshot existente expõe estado, última coleta, contagens de publicações/versões/falhas/retries e agora campos opcionais DOU: XMLs, matérias reunidas, edições, matérias CONFAZ e falhas de parsing. Estado de cada pacote (PARSED/UNCHANGED/NOT_AVAILABLE/PARTIAL), hashes, páginas e detalhes por falha ficam na tentativa. `UNCHANGED` indica que nenhuma matéria foi novamente processada; contador zero não significa edição vazia. Não há nova Central visual nesta frente.

## Validação e limite de aceitação

CI da branch está verde após a ampliação para DOU completo; a execução #94 passou no commit `31f8af633ce4f5d4f4498fc32323a1bc7d1291d4`, incluindo typecheck, build, testes unitários, migrations, regressões de coleta, integração PostgreSQL/collection engine e autenticação/RLS. As validações live do Railway são adicionais ao CI: usam a sessão real do INLABS e não persistem no banco.

Railway: `INLABS_EMAIL` e `INLABS_PASSWORD` estão ativos no `radar-fiscal-worker`. O Worker produtivo continua em `main` e o conector DOU segue desabilitado por padrão. A branch foi executada apenas em serviço temporário isolado `inlabs-validation`, sem Scheduler e sem persistência, comprovando autenticação, índice e download/parser das seis variantes do DOU.

## Decisões fechadas, pendência externa e follow-ups

1. **Originais — decisão MVP fechada:** o conector não criará storage DOU específico nem gravará binários no PostgreSQL. O conteúdo normalizado, URL oficial, identificadores e SHA-256 do pacote/XML ficam preservados. A tabela `publication_files` permanece como contrato para uma futura camada **compartilhada** de object storage aplicável a todas as fontes. Isso é follow-up de infraestrutura, não bloqueio do conector DOU.
2. **PRIMARY/ENRICHMENT/VALIDATION — fechado:** DOU/INLABS é `PRIMARY`; portal CONFAZ é `ENRICHMENT`. A persistência agora protege a versão corrente primária: conteúdo diferente vindo de enriquecimento pode ser armazenado como versão não corrente, mas não substitui a versão corrente nem `primary_official_url`. Se a fonte primária chegar depois, ela assume a referência primária. Há regressão PostgreSQL cobrindo a regra.
3. **Disponibilidade e recuperação — decisão MVP fechada:** manter execução horária com dia corrente + dois anteriores + uma data antiga rotativa do mês corrente/anterior, no máximo quatro datas por run e seis variantes por data. Recibos ficam por 65 dias; gaps acima de 60 dias exigem backfill administrativo explícito. Um backfill histórico completo é capacidade operacional posterior e não bloqueia a coleta prospectiva do MVP.
4. **Suplementos — não bloqueante:** os scripts e README oficiais do INLABS documentam apenas `DO1/DO1E`, `DO2/DO2E` e `DO3/DO3E`. Não há convenção oficial separada comprovada para suplemento XML. O sistema não inventará `DO1S` ou equivalente; nova variante só será adicionada quando houver evidência oficial.
5. **Acesso — fechado:** `INLABS_EMAIL` e `INLABS_PASSWORD` estão ativos no Worker e a sessão autenticada real já foi validada no Railway, incluindo índice e download/parser das seis variantes.
6. **Gate CONFAZ — única pendência externa:** Ato COTEPE/ICMS, despachos, atos declaratórios e retificações foram capturados em XML real do DOU. O validador live versionado aponta para datas oficiais com Protocolo ICMS (06/07/2026), Convênios ICMS (08/07/2026) e Ajustes SINIEF (09/07/2026). O código e CI estão verdes, porém as tentativas atuais recebem HTTP 502 no login do INLABS, corretamente classificado como `INLABS_UNAVAILABLE / SOURCE_UNAVAILABLE / retryable=true`. Não converter essa indisponibilidade em falha de autenticação nem em ausência de publicação.

Manter o PR em draft somente enquanto o gate live das três famílias restantes estiver impedido pelo HTTP 502 do INLABS. Todos os demais itens técnicos desta frente estão fechados para o MVP. Não iniciar fontes seguintes antes de registrar o resultado final desse gate ou declarar formalmente o bloqueio externo.
