# DOU / INLABS — implementação e evidências

Atualizado em 2026-09-21. Base: `main` em `23c79a4c205399358572cc5833cd10e7bb164dab`.
PR #16 permanece draft. **Não concluído nem habilitado em produção.** Parser e conector usam XMLs reais enviados pelo titular para DO1/DO1E. O runtime foi ampliado para coletar DO1/DO1E, DO2/DO2E e DO3/DO3E; autenticação automatizada real, validação das Seções 2/3, gate CONFAZ, armazenamento dos originais e validação Railway continuam pendentes.

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
| XML | `index.php?p=AAAA-MM-DD&dl=AAAA-MM-DD-DOx.zip`; DO1/DO1E verificados nas amostras. O runtime coleta as seis variantes `DO1`, `DO1E`, `DO2`, `DO2E`, `DO3`, `DO3E`; Seções 2/3 ainda exigem evidência live antes de conclusão. |
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

Fixtures versionadas: 12 XMLs originais, bytes e hashes preservados, representando dez matérias (incluindo três despachos da Fazenda na mesma página e uma portaria em três partes). Testes também têm alterações sintéticas identificadas para versionamento e cabeçalhos sintéticos CONFAZ; estes **não atendem ao gate de captura CONFAZ real**.

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

80 testes unitários passaram localmente; typecheck passou. Leitura dos dois ZIPs completos passou conforme tabela. Transporte HTTP dos testes é simulado, enquanto os XMLs são reais. CI deve validar instalação limpa, build, migrations, regressões existentes e novo teste PostgreSQL: dez matérias, reprocessamento, uma nova versão, página compartilhada, restrições, Scheduler idempotente, recibos e heartbeat durante bloqueio real de persistência. Resultado final deve ser conferido no PR, não presumido a partir dos testes locais.

Railway: API, Worker, Scheduler e Postgres existentes reportaram deployments SUCCESS na inspeção; isso não valida DOU. Serviços continuam em main, sem credenciais INLABS identificadas. Não houve execução autenticada produtiva ou deploy desta branch.

## Decisões para o Gerente Geral e bloqueios

1. **Originais:** existe tabela publication_files e descritores, mas não adaptador de storage implementado nesta base. Propor adaptador comum aprovado ou aceitar fase provisória de referência/hash/texto. Não criar storage paralelo nem gravar binários no PostgreSQL. `archivalStorage=NOT_CONFIGURED` é explícito.
2. **PRIMARY/ENRICHMENT/VALIDATION:** metadata registra PRIMARY/INLABS sem nova coluna; isso não impõe precedência. Persistência atual pode substituir URL/conteúdo corrente por nova versão de enriquecimento. Definir política mínima de preservação da referência DOU e versão vigente antes de habilitar coexistência produtiva. Não alterar a arquitetura silenciosamente.
3. **Disponibilidade e recuperação:** confirmar que XML com o prazo publicado atende à necessidade de negócio; definir reconciliação completa e interface de backfill controlado após medir volume. Suplementos continuam sem evidência suficiente.
4. **Acesso:** titular já acessou sua conta. Falta disponibilizar secrets INLABS no Worker para validação automatizada, sem transmitir senha por conversa/GitHub/log. A listagem autenticada real precisa ser inspecionada nesse ambiente antes de ativar o Scheduler.
5. **Gate CONFAZ:** localizar e persistir Convênio ICMS, Ajuste SINIEF, Protocolo ICMS e Ato COTEPE/ICMS reais, mais despachos/ratificações relacionados; conferir número/data/ementa/texto/órgão/referência e deduplicação entre fontes. As duas edições enviadas não contêm essas amostras. Não declarar eliminada a dependência crítica do portal CONFAZ.

Manter PR em draft e retornar a estes bloqueios após CI. A frente só termina após gate real e Railway funcional; não iniciar fontes seguintes.
