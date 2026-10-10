# TAX13 — Pacote para revisão independente R9-DESIGN-R4 / XML-FIRST

**Status: MATERIAL DE EXECUTOR; NÃO É APROVAÇÃO INDEPENDENTE.**
**Base imutável:** PR #197, e21c792d599bb9f70cf5f7b268cd9476ce987c8d (stacked sobre PR #196, f2ebd1a134157e3fa0fa549155a5908dad63e37f).
**Parecer anterior:** https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6094470892 — R9-DESIGN-R3 BLOCK.
**Contrato R4 proposto:** [TAX13_R9_DOU_CANONICAL_CONTRACT_R4.md](TAX13_R9_DOU_CANONICAL_CONTRACT_R4.md). R3/R2 continuam auditáveis e não são editados pelo R4.

## Matriz de tratamento proposto (não confundir descrição com teste executado)

| Achado independente | Remediação proposta no R4 | Evidência que permanece exigida |
| --- | --- | --- |
| P1 R3-01: temporal FK exige PDF | temporal_review_events passa a referenciar XML version NOT NULL; correlation PDF é NULLABLE, FK composta quando preenchida | SQL PG16/18 futuro: XML sem PDF permite FACTS_ONLY; correlation de outro XML falha |
| P1 R3-02: ZIP >20MiB não admitido | CHECK purpose-specific: PDF 20MiB, INDEX 2MiB proposto, ZIP 64MiB; limites descompactados 128MiB/5000 entries/8MiB entry | comparação com cliente INLABS e parser reais; testes SQL e ZIP 25MiB sintético no gate 049+ |
| P1 R3-03: identidade canônica e dedupe | âncora global XML com lineage/revision fingerprint + publication_versions FK, ligação parent-child, job seletivo por parent, conflito cross-jobs fail-closed | mapeamento real da versão de ato embedded ao esquema atual, unicidade sob concorrência e desambiguação extra 80-A/B |
| P1 R3-04: índice e manifestos | separa inventário de ZIP inteiro do manifesto das partes de uma matéria; índice e PDF têm templates de URL fechados, revalidação do conteúdo real e INDEX_PENDING se sem prova | **PENDENTE:** evidência empírica do parser de índice oficial/jornal/sufixo; a URL de visualização isolada NÃO prova indexação |
| P1 R3-05: gateways/ACL/revoke/tenant | enumeração fechada das operações, actors, assinaturas sem booleans de prova, checks transacionais, revogação e reader público separado da relevância tenant | **PENDENTE:** implementação SQL completa/compilável, RLS/PG16/18, autenticação real dos dois binários e traço de execução. Não declarar aprovação do código |
| P2 R3-06: 1:N despacho | verification é por despacho parent; act_correlations permite N filhos com FK e UNIQUE(verification,child) | teste 1 despacho → N atos sem N GETs por empresa |
| P2 R3-07: integração XML-first parcial | estados independentes coleta XML, comprovação documental, fatos por dispositivo e relevância tenant | implementação e integração de API/dashboard/seleção de provas são trabalho futuro sob gate próprio; não dizer que já existem |

## Contratos críticos para o revisor atacar

**Cenário 1 — origem falsa:** dois jobs usando mesma URL e hashes enviados por DTO não podem produzir status positivo; trusted collector e verifier devem provar capturas realmente independentes. SQL sozinho não observa TLS; risco residual de ambos os workloads comprometidos foi aceito explicitamente no threat model, NÃO escondido.

**Cenário 2 — SOURCE vs XML:** a publicação XML é processada mesmo se o PDF estiver indisponível. Um evento de coleta XML não pode ser convertido em receipt HTTP positivo da camada de prova; tampouco uma revisão FACTS_ONLY pode produzir CURRENT. O PDF só é necessário à elevação seletiva SOURCE_PUBLICATION_ATTESTED.

**Cenário 3 — versionamento:** dois ZIPs diferentes com a mesma matéria não são evidência da mesma versão de conteúdo. Dois fetch jobs com mesmo ZIP/texto são observações distintas da mesma versão, não duas publicações canônicas. Dois jobs que divergem em índice/edição/texto tornam status conflitante até revisão; jamais escolher último pelo timestamp.

**Cenário 4 — campos XML derivados:** fonte já fornece a matéria id, edição numérica, journal no nome XML, ZIP URL/hash e part hashes; nenhum deles, isoladamente, demonstra que o jornal corresponde a extra 80-A ou 80-B. Exigir indexação/cabeçalho real e negar STRING declarada pelo chamador.

**Cenário 5 — revisão temporal sem PDF:** FK de evidência documental opcional, constraints de mesma versão, as-of e supersession por cláusula; o PostgreSQL precisa permitir gravação de fato sob XML canônico mesmo com documentario NOT_REQUESTED.

**Cenário 6 — autorização de leitura:** metadados de prova canônica são globais e públicos apenas por gateway interno; afinidade/empresa/parecer pertence ao tenant e não pode atravessar fronteira A/B. Não confiar em tenant_id entregue pela UI sem validação de auth e RLS.

**Cenário 7 — tamanho/documento:** ZIP 25MiB, 300 matérias e 1.000 entradas com apenas duas partes XML para a matéria de interesse não pode ser truncado para 48; 48 é por matéria. PDF 25MiB e ZIP 65MiB devem falhar sem atestação.

**Cenário 8 — falso positivo técnico:** testes de PDF sintético/CI verde podem demonstrar comparação textual, mas NÃO assinar prova de publicação. A captura Railway histórica com SHA diferente do PDF enviado pelo proprietário não pode ser retrabalhada sem seus bytes originais.

## Evidências verificadas do baseline

- Coletor principal: src/modules/collection/dou.connector.ts → InlabsClient.downloadXml() + parseDouZip(), quatro seções DO1/DO1E/DO3/DO3E.
- src/modules/collection/inlabs.client.ts: maxArchiveBytes padrão 64×1.048.576.
- src/modules/collection/dou.parser.ts: ZIP máximo 64MiB comprimido, 128MiB descomprimido, máximo 5.000 entries, 8MiB por entry.
- Código R3 passou no CI dedicado do PR #197: https://github.com/fabiojuniort-cyber/radar-fiscal-backend/actions/runs/38028965169, 39/39 testes TypeScript; não valida R4 SQL.
- Migração 048 SHA blob 40f5ae6179d4f0f86a1c8470d1ae977a84f03862: intocada nesta frente.

## Portões obrigatórios

R4 tem somente documentos, nenhuma migration 049+, nenhum código SQL em execução. Revisor deve ler contrato R4 no SHA do PR, cotejar com o R3, reproduzir logicamente ataques de confiança, analisar cardinalidade/FKs/indexação e emitir APPROVED/BLOCK apenas sobre **DESENHO**. Se o índice oficial ou gateways continuarem subespecificados, revisor deve bloquear com achados específicos. SQL compilável, PG16/18, PUT/GET HTTPS reais, custos/novos serviços Railway, integração tenant API, análise jurídica CURRENT, merges e deploy requerem gates e autorizações posteriores. Não há autorização para coleta histórica DOU 1991/1997 nem para fabricar fonte/recibos. 

**Nome sugerido da conversa:** Revisor Independente — TAX13 R9-DESIGN-R4 XML-FIRST.
