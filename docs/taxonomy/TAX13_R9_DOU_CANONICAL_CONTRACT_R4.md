# TAX13 / DOU — R9-DESIGN-R4: contrato XML-first, custódia documental seletiva

**Status: PROPOSTA ARQUITETURAL PARA REVISÃO INDEPENDENTE; NÃO APPROVED; NÃO É MIGRAÇÃO 049+; NÃO EXECUTAR.**
**Origem:** PR #196 SHA f2ebd1a134157e3fa0fa549155a5908dad63e37f + PR #197 SHA e21c792d599bb9f70cf5f7b268cd9476ce987c8d.
**Bloqueio R3:** https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6094470892.
**Diretriz do proprietário:** [TAX13_DOU_XML_FIRST_OWNER_DECISION_20261010.md](TAX13_DOU_XML_FIRST_OWNER_DECISION_20261010.md).
**Precedência:** esta proposta R4 é candidata a substituir somente o contrato R3; os RFCs R2 permanecem históricos. Até parecer R4 APPROVED, R3 e R4 NÃO estão autorizados como DDL de produção. Não reescrever SHAs auditados, migração 048 ou outros gates.

## 1. Limite funcional: ingestão XML ≠ prova documental PDF ≠ análise de vigência

Fluxo normal: INLABS → downloadXml() ZIP → parseDouZip() → publicação/versão textual canônica → taxonomia, classificação, dispositivos, pesquisa, IA e relevância por tenant. Nenhum PDF ou índice complementar é pré-requisito de persistência, classificação ou revisão temporal.

Fluxo seletivo: versão XML canônica escolhida para prova → job documental → GET oficial independente de PDF / índice / ZIP por collector e verifier → conferência do ZIP, partes XML, cabeçalho, edição e texto integral do despacho → correlação append-only → projeção VERIFIED_PUBLICATION ou UNVERIFIED. O texto extraído do PDF é temporário, **somente para comparar com o XML**, nunca substitui o texto canônico e nunca alimenta um segundo motor.

A publicação XML pode estar XML_PARSED e DOCUMENTARY_NOT_REQUESTED, DOCUMENTARY_PENDING, DOCUMENTARY_UNAVAILABLE ou DOCUMENTARY_MISMATCH. Todos continuam elegíveis à análise jurídica em estado não atestado, conforme política existente, mas nenhum deles recebe SOURCE_PUBLICATION_ATTESTED pela ausência de prova. Revisão temporal por dispositivo pode ser registrada sem qualquer PDF; CURRENT requer gate jurídico distinto e não nasce do XML, da correlação PDF ou de ratificação isolada.

**Escopo desta proposta:** arquitetura futura; não criar serviços Railway; não iniciar migration 049+, merge/deploy, download massivo nem histórico DOU; não exigir ICP-Brasil, assinatura digital documental, ITI/OCSP/CRL. Não armazenar PDF/JPG/ZIP binário no PostgreSQL. Capturas sintéticas nunca são prova de origem.

## 2. Correção R3-01 — âncora XML canônica e temporalidade independente

Introduzir *âncora global imutável* tax13_dou_xml_versions, derivada somente do registro XML/ZIP efetivamente processado, vinculada à public.publication_versions(id). Não depender do PDF ou do ledger 048. O registro da âncora não significa atestação governamental: metadata, SHA e texto armazenado podem ser alterados por processos comprometidos; sua confiança é a do coletor XML ordinário, inferior à prova documental seletiva.

**Duas identidades distintas:**
- XML lineage: SHA-256 versionado do domínio TRIFAROS/DOU/XML-LINEAGE/4 + source code dou + data + seção + caminho ZIP INLABS oficial + journal ID declarado no nome das partes + idMateria + papel parent/embedded + tipo/identificador de ato e ordinal embedded. A edição numérica do XML é dado suplementar, NUNCA prova do sufixo A/B. A identidade é PROVISÓRIA quanto à edição impressa até prova oficial.
- XML revision: SHA-256 versionado do domínio TRIFAROS/DOU/XML-REVISION/4 + lineage + ZIP SHA efetivo + digest do conjunto de partes XML por matéria + hash SHA do texto canônico armazenado + versão de parser. Igualdade de revision+lineage deduplica recapturas; conteúdo diferente na mesma lineage é NOVA VERSÃO, não UPDATE. Ambiguidade de duas edições extras na mesma lineage não pode ser resolvida por dedução numérica: bloquear atestação e abrir conflito, preservando XML e classificação.

**Fatos jurídicos por cláusula:** tax13_dou_temporal_review_events.xml_publication_version_id é NOT NULL e FK para a âncora XML. documentary_correlation_id é NULLABLE; quando presente, FK composta (correlation_id,xml_version_id) deve apontar para ato/documento idêntico. PENDING/FACTS_ONLY podem ser registrados antes de qualquer PDF; a atestação futura apenas acrescenta evidência. Não reescrever fatos históricos. REVIEWED_FACTS_ONLY não autoriza CURRENT; decisões de CURRENT continuam fora deste DDL.

O futuro executor deve verificar previamente que cada ato embedded realmente tem public.publication_versions(id) próprio e parent_version_id rastreável. Se não, criar mecanismo de referência canônica equivalente **antes** da 049+ e submeter novamente ao revisor; jamais criar FK imaginária ou uma linha de publicação sintética para passar testes.

## 3. Correção R3-02 — limites por tipo de artefato

A restrição de 20 MiB não pode ser global. Condições objetivas sobre CAPTURED:

| purpose | bytes comprimidos/transportados | validação |
| --- | ---: | --- |
| PDF | 1 até 20 × 1.048.576 | assinatura de bytes %PDF-, HTTPS governamental, uma página no fluxo atual, MIME, nenhum redirect não aprovado |
| OFFICIAL_INDEX | 1 até 2 × 1.048.576 (proposta conservadora) | resposta e MIME realmente compatíveis com parser selecionado; HTML/WAF/login não são índice |
| INLABS_ZIP | 1 até 64 × 1.048.576 | ZIP válido de INLABS; limite idêntico ao InlabsClient atual, não 20 MiB |

ZIP parseado: limite global descomprimido 128 MiB, 5.000 entradas, 8 MiB por entrada, caminhos planos, nomes únicos, CRC conferido, sem encrypted, abort/cancellation e rejeição de ZIP bomb conforme dou.parser.ts. O limite **1–48** aplica-se só às partes de **uma matéria**, nunca ao número de XMLs existentes no ZIP diário. Um ZIP de 25 MiB válido deve poder ser CAPTURED; um PDF de 25 MiB deve ser REJECTED. Se a necessidade real de índices superar 2 MiB, ajustar apenas depois de captura oficial supervisionada e nova aprovação de política, não afrouxar silenciosamente. Independência XML-first impede que falha na prova PDF invalide a ingestão ZIP padrão.

## 4. Correções R3-03 e R3-04 — duas camadas de identidade e de inventário

A futura migração deve separar:

1. **XML da matéria:** vínculo da public.publication_versions(id) à source dou, versão textual, despacho pai, norma filha, archive URL/hash, arquivos do XML, versão de parser e prefixo jornal_id.
2. **Inventário de ZIP inteiro:** evento de captura INLABS_ZIP por duas roles, hash SHA do ZIP, contagem de TODAS as entradas, contagem XML/não-XML, bytes expandidos e digest do inventário completo ordenado por nome de arquivo + tamanho + CRC + SHA das entradas XML efetivamente abertas. Não guardar 5.000 linhas nem bytes binários no PostgreSQL; manter compromisso digest e contagens. Um digest de XMLs acessíveis não significa que mídia não XML foi publicada como texto.
3. **Manifesto das partes de UMA matéria:** array pequeno 1–48, campos filename, part ordinal, size, sha256, source_journal_id e idMateria; ordenar por ordinal e filename, validar primeira parte, ausência de lacunas e attrs compartilhados. Digest da matéria inclui ZIP SHA e manifest digest; exigir as partes exatamente presentes no inventário completo rederivado do MESMO ZIP adquirido. Não aceitar lista selecionada pelo caller.
4. **Índice + edição:** autoridade independente deve resolver jornal numérico ↔ edição impressa com sufixo ↔ data ↔ seção ↔ página. O XML possui editionNumber numérico, NÃO distingue 80-A/80-B. PDF impresso confirma data/seção/edição/identidade textuais, mas o cabeçalho informado por um DTO não é evidência de jornal.
5. **Despacho e vários atos:** uma verificação completa do despacho pai pode produzir várias correlações filhas (1:N). Uma correlation por (verification_id,child_xml_version_id), SEM UNIQUE global no verification_id. Cada ato filho aponta à mesma versão XML parent e ao intervalo exato no mesmo despacho; sem N downloads de PDF por ato/tenant.

**Locadores oficiais candidatos derivados internamente, NÃO atestados como parser de índice no R4:**
- Link de página constante do XML: https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp com data=DD/MM/AAAA, jornal=<identificador_do_XML>, pagina=<número>. A rota é um *locator* e pode servir uma interface/WAF; não assumir que seu HTML prova a edição. Precisará de contrato de extração testado sobre conteúdo real.
- PDF: https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer com captchafield=firstAccess, data=DD/MM/AAAA, jornal=<jornal>, pagina=<página>. Re-derivar e restringir todos os parâmetros; capturar PDF real e conferir masthead, sem aceitar redirects para outra origem.
- ZIP: https://inlabs.in.gov.br/index.php com p=AAAA-MM-DD e dl=AAAA-MM-DD-DO1(E)/DO3(E).zip, conforme parser/cliente existente.

**Falha fechada de índice:** enquanto não houver prova de que uma resposta do domínio governamental realmente contém a identidade do exemplar/jornal, manter INDEX_PENDING. Não converter screenshot, snippet de busca, string de XML ou URL isolada em INDEX_LINKED. **Nenhum endpoint novo de índice foi validado operacionalmente nesta etapa.** A revisão R4 deve julgar se a exigência de índice independente é cumprível com o portal e se o documento de publicação PDF+XML pode fundamentar alternativa explícita sem relaxar a política do proprietário; qualquer alteração do gate precisa de decisão documentada, não implícita.

**Não deduplicar por hash do ZIP apenas**: um ZIP tem N matérias. Também não considerar job um identificador de publicação: re-fetch cria job novo, mesmo conteúdo conserva lineage/revision. Correlation positiva deve referenciar exclusivamente a versão XML fixada; dois positivos contraditórios entre jobs para a mesma XML revision → PROJECTION_UNVERIFIED/CONFLICT até decisão jurídica e técnica registrada em evento imutável.

## 5. DDL R4 de referência — CONCEITUAL, NÃO APLICAR

Os nomes a seguir são candidatos para migration 049+ **após aprovação de desenho**. Foreign keys para public.publication_versions(id) são condicionadas à checagem prévia do schema real da versão embed/parent. Tipos de status são enumerados ou CHECKs, não texto livre. Nenhuma tabela de prova tem tenant_id. Campos omitidos de auditoria (created_at, digest de envelope, versão do normalizador) são sempre NOT NULL na proposta final.

**A) tax13_dou_xml_versions — âncora canônica independente de PDF**
- xml_publication_version_id UUID PRIMARY KEY REFERENCES public.publication_versions(id) ON DELETE RESTRICT.
- parent_xml_version_id UUID REFERENCES tax13_dou_xml_versions(xml_publication_version_id) ON DELETE RESTRICT; NULL somente para despacho/matéria parent; para filho, parent obrigatório e diferente do próprio id.
- source_code='dou'; source_archive_url, archive_sha256 char(64); publication_date, section_code, numeric_edition, journal_id_from_xml, official_matter_id, role PARENT/EMBEDDED, child_ordinal, xml_content_sha256, matter_parts_sha256, parser_version.
- lineage_fingerprint_v4 e revision_fingerprint_v4 char(64) NOT NULL; UNIQUE(lineage_fingerprint_v4,revision_fingerprint_v4); UNIQUE(xml_publication_version_id,parent_xml_version_id) não resolve NULL: validar parent/child no gateway sob lock.
- CHECKs de formatos, HTTPS host allowlisted, valores de edição e consistência com source_metadata + content_hash de publication_versions verificados em leitura SQL. Nenhuma nova fonte PDF necessária.

**B) runtime_credentials / credential_revocations — confiança por sessão**
- credentials: id UUID PK, role_name CHECK scheduler/collector/verifier/temporal, epoch, key_ref unique, valid_from, valid_until, UNIQUE(role_name,epoch), sem segredos persistidos.
- revocations: credential_id UUID PK FK, revoked_at, reason_code, event_identity, approved_by; append-only. Revogação bloqueia novas inserções positivas e torna projeções já registradas UNVERIFIED, sem apagá-las.

**C) collection_jobs — somente prova documental seletiva**
- id UUID PK; parent_xml_version_id UUID NOT NULL FK xml_versions; scheduler_credential_id FK credentials; date/section/journal/edition_numeric/page/matter, pdf_url/index_url/zip_url DERIVADAS de templates fixos; target_fingerprint_v4, scheduled_at e policy_version NOT NULL.
- UNIQUE(id,parent_xml_version_id); INDEX(parent_xml_version_id,scheduled_at DESC). NÃO UNIQUE(target_fingerprint_v4) isolado, pois rechecks são legítimos. Um job aponta a um parent, vários filhos podem usar o mesmo resultado.
- CHECK URLs sintáticas é necessário mas **não suficiente**: create_job deriva URL sem aceitar URL arbitrária, verifica role e origem e registra template version.

**D) http_fetch_events — tentativas por actor e purpose**
- id UUID PK; job_id UUID FK jobs; actor COLLECTOR/VERIFIER; purpose PDF/OFFICIAL_INDEX/INLABS_ZIP; attempt_no; credential_id FK credentials; requested_url/final_url, outcome, http_status, mime_type, byte_count, sha256, fetch_started_at, fetch_finished_at, runtime_version, error_code e fingerprint_v4.
- UNIQUE(job_id,actor,purpose,attempt_no), UNIQUE(id,job_id,actor,purpose), UNIQUE(fingerprint_v4); outcome CAPTURED exige status 200, URL/host/purpose corretos, sha256 e mime/byte_count; failures não têm SHA positivo nem PDF hipotético.
- SQL CHECK por purpose, além dos validadores da função:

        CHECK(byte_count IS NULL OR
          (purpose='PDF' AND byte_count BETWEEN 1 AND 20971520) OR
          (purpose='OFFICIAL_INDEX' AND byte_count BETWEEN 1 AND 2097152) OR
          (purpose='INLABS_ZIP' AND byte_count BETWEEN 1 AND 67108864))

  Observação: retries separados; duas sessões não podem sobrescrever uma tentativa.

**E) archive_inventory — compromisso do ZIP COMPLETO**
- id UUID PK, job_id UUID NOT NULL FK jobs, collector_zip_event_id, verifier_zip_event_id com FK COMPOSTA a (id,job_id,actor,purpose) de fetch_events; roles devem ser COLLECTOR+VERIFIER e purpose INLABS_ZIP.
- zip_sha256, inventory_digest_v4, total_entries SMALLINT/INTEGER CHECK 1..5000, xml_entries, other_entries, expanded_bytes CHECK 1..134217728, parser_version; status COMPLETE/REJECTED, canonicalization_version.
- UNIQUE(id,job_id); UNIQUE(job_id,zip_sha256,inventory_digest_v4). Verificação de completude CRC/zip entries é do parser confiável, não de JSON enviado por API.

**F) matter_part_manifests — apenas UMA matéria XML**
- id UUID PK, archive_inventory_id+job_id FK COMPOSTA archive_inventory, parent_xml_version_id+job_id FK ao job parent, official_matter_id, xml_parts JSONB não nulo array 1..48, digest_v4 char(64), xml_content_sha256, parser_version.
- UNIQUE(archive_inventory_id,parent_xml_version_id,digest_v4), UNIQUE(id,job_id,parent_xml_version_id). Conferir cada XML entry do mesmo ZIP e igualdade com âncora XML em transação; não confundir total_entries com parts.length.

**G) edition_bindings — identidade de edição comprovada**
- id UUID PK, job_id, parent_xml_version_id; manifest_id FK (id,job_id,parent_xml_version_id) ao manifest; collector/verifier PDF e INDEX event IDs cada um FK COMPOSTA a (id,job_id,actor,purpose).
- printed_edition com sufixo exato; publication_date,section,journal,page,matter; sha dos dois PDF pares e dos dois INDEX pares; index_parser_version, pdf_header_parser_version, official_index_evidence_digest e binding_fingerprint_v4 NOT NULL.
- CHECK regular vs extra, prefixo numérico equivale a numeric_edition do job; verificação do sufixo contra fonte OFICIAL rederivada. UNIQUE(id,job_id,parent_xml_version_id).

**H) verification_events — UM despacho verificado, N atos correlacionados**
- id UUID PK; job_id, parent_xml_version_id, binding_id FK COMPOSTA; verifier_credential_id, result CORRESPONDS/REJECTED/UNVERIFIED, normalized_whole_dispatch_digest, normalization_version, report_sha, verified_at, failure_code.
- UNIQUE(id,job_id,parent_xml_version_id), UNIQUE(report_sha) por regra de conteúdo versionado; veredito CORRESPONDS só se as seis observações estiverem verificadas e índice/ZIP/XML/despacho completos. Não confundir um veredito do despacho com validade jurídica de cada filho.

**I) act_correlations — múltiplos filhos por verificação (1:N)**
- id UUID PK, verification_id+job_id+parent_xml_version_id FK COMPOSTA verification_events, child_xml_version_id FK xml_versions, parent_start/end, child_start/end, act_type/number, child_text_digest, comparison_digest, matcher_version.
- UNIQUE(verification_id,child_xml_version_id), UNIQUE(id,child_xml_version_id); CHECK spans dentro do despacho e sem gaps/truncamento, validade do vínculo parent do filho obrigatoriamente revalidada na função. A mesma matéria/ato em outro job pode obter nova verificação, sem multiplicar a publicação canônica.

**J) temporal_review_events — SEM dependência obrigatória de PDF**
- id UUID PK; xml_publication_version_id UUID NOT NULL FK xml_versions; documentary_correlation_id UUID NULL; FK COMPOSTA (documentary_correlation_id, xml_publication_version_id) REFERENCES act_correlations(id,child_xml_version_id).
- device_ref NOT NULL, fact_kind PUBLICATION/RATIFICATION/EFFECTS_FROM/DEADLINE/CORRECTION/AMENDMENT/REVOCATION/SUPERSESSION/REVIEW_PENDING, legal_as_of DATE, event_date/effect_from/effect_until, evidence_official_url/evidence_sha256, reviewer_credential_id, reviewer_policy_version, review_state PENDING/INSUFFICIENT/FACTS_ONLY, supersedes_event_id FK da mesma tabela, event_fingerprint_v4 UNIQUE, append-only.
- CHECK effect_until>=effect_from quando ambos presentes. Nenhum FK para verification_events é obrigatório. Revogação/ausência do PDF não apaga fatos; marca a confiança documental como separada.

**Esquema SQL representativo para fechar as duas FKs centrais (NÃO aplicar):**

    ALTER TABLE public.tax13_dou_act_correlations
      ADD CONSTRAINT uq_dou_corr_id_xml_version
      UNIQUE(id,child_xml_version_id);
    ALTER TABLE public.tax13_dou_temporal_review_events
      ADD CONSTRAINT fk_dou_temporal_optional_pdf
      FOREIGN KEY(documentary_correlation_id,xml_publication_version_id)
      REFERENCES public.tax13_dou_act_correlations(id,child_xml_version_id)
      ON DELETE RESTRICT;
    -- Com MATCH SIMPLE padrão, NULL documentary_correlation_id
    -- permite fatos jurídicos de XML sem correlação PDF; valor não NULL
    -- exige que a prova pertença exatamente à mesma versão XML.

**Não criar tabela separada por tenant para cada captura.** A distribuição usa as publicações canônicas e o sistema já existente de afinidade tenant com RLS; novo status documental global não incorpora decisões/segredos específicos de clientes.

## 6. Correção R3-05 — contratos de gateways, credenciais, ownership e revogação

Papéis distintos, sem membership cruzado, sem BYPASSRLS, sem herança do owner:
- radar_dou_ledger_owner NOLOGIN (proprietário exclusivo das tabelas/funções);
- radar_dou_xml_linker_runtime LOGIN (registra âncoras XML após persistência por rotina autorizada, jamais prova PDF);
- radar_dou_scheduler_runtime LOGIN (planeja seleção de prova, não registra CAPTURED);
- radar_dou_collector_runtime LOGIN (somente seu evento HTTP);
- radar_dou_verifier_runtime LOGIN (seu GET independente e verificação documental);
- radar_dou_credential_admin_runtime LOGIN (credenciais/revogações);
- radar_dou_temporal_runtime LOGIN (fatos por dispositivo);
- radar_dou_read_runtime LOGIN (somente fonte global, sem dados de tenant).
A migration futura deve auditar roles reais e privilégios anteriores antes de provisionar novas identidades. Nenhum app/worker comum, curador, issuer, sealer ou usuário de tenant pode SET ROLE para owner/collector/verifier.

**Para TODAS as dez famílias de tabelas descritas:** owner NOLOGIN, REVOKE ALL FROM PUBLIC e demais logins fora do propósito, ENABLE + FORCE RLS, políticas explícitas owner-only para SELECT e INSERT, triggers BEFORE UPDATE/DELETE que rejeitam inclusive owner e ausência de GRANT TRUNCATE. REVOKE EXECUTE FROM PUBLIC em TODAS as funções após criação, GRANT apenas à role nominada. Schemas de funções e search_path fixos (pg_catalog, schema dedicado não gravável, pg_temp por último), objetos referenciados qualificados, CREATE schema revogado de roles comuns, sem dynamic SQL com input livre, sem confiar em GUC de sessão tenant/prova. Teste PG16 e PG18 em sessões separadas antes de qualquer merge futuro.

**Interfaces fechadas (sem implementação autorizada nesta rodada):**

| gateway SQL proposto | EXECUTE role | entrada permitida → resultado / pré-condições |
| --- | --- | --- |
| record_xml_version(xml_publication_version_id) | xml_linker | Lê versão e source_metadata no DB, recomputa lineage/revision/text hash, verifica origem dou, parent/child real; INSERT imutável; jamais CAPTURED |
| register_credential(role,epoch,key_ref,valid_from,valid_until) | credential_admin | Autorização administrativa auditada, sem segredos no DB; monotonia de epoch |
| revoke_credential(credential_id,reason) | credential_admin | INSERT append-only sob lock da credencial; proíbe reintegração da epoch |
| create_documentary_job(parent_xml_version_id) | scheduler | Reconstroi URL de templates oficiais + fonte XML ancorada; NÃO aceita URL/status/hash externo; gera UUID, ordinal e target_fingerprint |
| append_fetch_event(job_id,purpose,attempt_no,network_observation) | collector OU verifier em gateways separados | session_user exato, policy de role/credential, network_observation obtida do workload autorizado, não de API/UI; valida host/MIME/bytes/tempo/replay; INSERT com actor derivado da role, NUNCA flag verified passada pelo cliente |
| admit_documentary_chain(job_id,selected_event_ids) | verifier | Rede já observada nos dois processos; transação curta adquire locks, busca events internos, reexige seis CAPTURED compatíveis, rederiva inventory/manifest/index/PDF/XML e correlação integral do despacho de bytes do verifier; grava inventory+manifest+binding+verification+N correlações atomicamente, ou nenhuma positiva |
| append_temporal_fact(xml_version_id,device_ref,fact,evidence) | temporal | Aceita XML_PARSED, não exige PDF; source e assinante revisional validados; jamais escreve CURRENT |
| read_documentary_status(xml_version_id) | read_runtime interno | Recalcula sob snapshot estado NOT_REQUESTED/PENDING/VERIFIED/MISMATCH/UNAVAILABLE/REVOKED/CONFLICT, sem credencial privada; só metadados públicos de fonte global e ZERO atributos tenant |
| read_tenant_relevance(tenant_bound_publication_id) | runtime de afinidade existente | RLS e auth de tenant existentes **antes** de anexar estado documental global; nega visibilidade tenant A→B; sem role read_runtime diretamente exposta a usuário final |

**Detalhes obrigatórios dos gateways (implementador não pode adivinhar política):**
- Entrada de coleta NÃO pode ser API pública de submit receipt. O objeto network_observation existe somente em uma interface privada dos dois binários isolados, com identidades de execução e egress controlados; SQL reconhece session_user, versão/epoch registrada e credencial ativa, mas NÃO afirma que SHA ou HMAC fornecido prova sozinho GET governamental.
- O verificador não reutiliza bytes do coletor como substituto do GET: faz GET HTTPS próprio dos três alvos e revalida os bytes efetivamente recebidos; índices sem identidade suficientemente explícita ficam INDEX_PENDING.
- Uma função SQL não pode verificar TLS a partir do SHA; estabelecer no futuro a cadeia entre identidade do binário executado, atestação da rede e credential provisionada; um verifier comprometido pode forjar relato, risco residual conhecido. Não reduzir dupla captura sem novo parecer.
- Lock de job/parent XML e das credentials, SEMPRE em ordem determinística (credential IDs ordenados, depois job/lineage lock). Registros são append-only; recheck usa novo job; retry do mesmo job usa ordinal maior; replay de event_id/fingerprint idêntico é no-op auditável, replay contraditório ERRO. Não sobrescrever falhas nem sucesso anterior.
- Revogação usa os mesmos locks e é considerada por admit_documentary_chain e read_documentary_status; resultado eficaz não é coluna VERIFIED persistida que sobreviva a revogação. Para uma leitura concorrente à revogação, declarar semântica de snapshot e exigir refresh a cada leitura posterior, sem cache positivo indefinido.
- Chave real entre jobs é lineage+revision+XML version. Mesmo documento com hashes diferentes exige nova versão/conflict, não promova sucesso de um ZIP/documento a outro. Dois matches positivos incompatíveis para mesma XML version devem devolver CONFLICT/UNVERIFIED; não ordenar por timestamp e escolher arbitrariamente o último.
- Tenant: read_documentary_status é função **interna de dados públicos globais**, nunca uma API que expõe resultados de filtro, parecer ou relevância de empresas; antes de anexá-la à rota da empresa, exigir auth e RLS de tenant sobre a publicação visível. Testes A/B impedem que usuário de uma empresa consulte relevância de outra.
- A temporalidade é feita per-device por XML version; source_verification_revoked muda a confiança de publicação, não apaga um evento fático, e nenhuma flag CURRENT pode ser emitida por esses gateways.

## 7. Testes adversariais e critérios para R9-DESIGN-R4

**Projeto de testes a serem implementados na fase SQL 049+ APÓS aprovação independente do desenho**:
1. XML coletado e texto legal taxonomizado sem PDF, temporal fact FACTS_ONLY gravado com documentary_correlation_id NULL (R3-01).
2. PDF 503/404/WAF: XML permanece e atestação NOT_REQUESTED/PENDING/UNAVAILABLE; sem CURRENT; falha não vira zero publicações.
3. ZIP 25 MiB válido CAPTURED; ZIP >64 MiB REJECTED; ZIP bomb/5.001 entries/>128 MiB expanded REJECTED; PDF 25 MiB REJECTED; índice grande fail-closed.
4. Inventário ZIP de 300 matérias/1.000 entradas e manifesto da matéria de 2 partes; não truncar o total em 48; parts com falta, nome duplicado/CRC falso, spoof de SHA são REJECTED.
5. 80 regular, 80-A, 80-B: mesmo numeric 80+DO1E não admite edição sufixada sem índice/impresso; index URL WAF ou sem evidência legível = INDEX_PENDING.
6. Dois GETs independentes por purpose; actor/session/credential não trocáveis; status+SHA fabricado por app/curator/worker/issuer/sealer negado em PG16/18; verifier sozinho não inventa evento COLLECTOR.
7. Dois jobs legítimos repetindo bytes geram tentativas separadas e **uma publicação/versão XML canônica**; XML alterado gera revisão/conflito; shadow identity de matter em outra edição não colide sem diagnóstico.
8. Despacho com N atos tem 1 verification e N correlations; child perturbado, sibling anterior/posterior, cláusula, cabeçalho, seção e texto extra causam UNVERIFIED.
9. Per-device temporal fact de XML sem PDF persiste; quando prova PDF aparece, FK opcional aceita somente correlation do mesmo XML version; correlação de outro ato/versão falha.
10. Revogação concorrente com admissão, credentials expiradas, epoch trocada, retry, replay, due locks: projeção fail-closed, trilha append-only preservada.
11. App/tenant A/B não pode ver registros de relevância alheia, nem ler/alterar ledger bruto. FORCE RLS, owner NOLOGIN, EXECUTE e search_path atacados; UPDATE/DELETE/TRUNCATE negados.
12. Migração 048 intacta e CONFAZ fail-closed; XML/PDF não promovem taxa jurídica CURRENT sem outra validação. Nenhuma fixture ou PDF upload é capture HTTP oficial.

**Pré-condições específicas não concluídas por documento:** (a) validação empírica do endpoint/parser de índice 80-B e associação a jornal 601; (b) captura real PDF+ZIP/XML autorizada; (c) verificação da relação exata das tabelas publication_versions para atos embedded; (d) SQL compilável/migration 049+ + PG16/18; (e) layout PDF real, revogação, concorrência; (f) política final de retenção/expurgo. Esses itens NÃO podem ser declarados testados com CI de TypeScript.

**Decisão solicitada ao revisor:** avaliar se a proposta elimina as incompatibilidades demonstradas pelo R3 como desenho. O revisor deve marcar individualmente PASS/BLOCK/NOT_VERIFIED; não aprovar meras promessas de implementação quando faltarem contratos de segurança verificáveis. Se o índice oficial não permitir atestação independente real, manter INDEX_PENDING e solicitar alternativa explícita, não fabricar endpoint/índice.

## 8. Situação imutável da prova anterior, segurança e operação

- GET antigo Railway SHA 9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44 ≠ upload SHA e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201. Bytes do GET descartados; TEXT_EQUIVALENCE_UNVERIFIED. Não afirmar igualdade nem fraude.
- Migração 048 é exclusivamente evidência CONFAZ, não aceita DOU positivo fictício. R7/TAX11 anteriores continuam BLOCK. Sem 049+, serviços Railway, merge/deploy, cron histórico, retomada DOU 1991/1997, rescan ou alteração de CURRENT.
- Retenção SQL: somente metadados, SHA, URL oficial, tempos, parser/normalizer/reviewer versions, valores de referência e inventário resumido; **sem PDF, ZIP, JPG nem outro binário no PostgreSQL**. Re-fetch novo jamais valida retroativamente bytes perdidos. Armazenamento externo imutável único (opcional) requer autorização e orçamento.
- Segregação de múltiplos tenants continua fora do ledger global; aplicação não reexecuta coleta por cliente.

**Próximo gate:** R9-DESIGN-R4 independente no novo SHA congelado desta proposta. Mesmo APPROVED de desenho NÃO é autorização de 049+ em produção; depois da aprovação deve-se projetar SQL executável em PR separado, testar PG16/18 adversarial e capturar PDF oficial real sob autorização específica.
