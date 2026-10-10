# Trifaros — TAX13 / R9-DESIGN-R4: contrato canônico XML-first e atestação DOU seletiva

**STATUS: PROPOSTA DE DESENHO PARA REVISÃO INDEPENDENTE. BLOCK ATÉ PARECER R4. NÃO É MIGRATION 049+ E NENHUM SQL ABAIXO DEVE SER APLICADO EM PRODUÇÃO.**

Data: 2026-10-10. Base acumulada: PR #197 SHA e21c792d599bb9f70cf5f7b268cd9476ce987c8d, sobre #196 SHA f2ebd1a134157e3fa0fa549155a5908dad63e37f. Parecer independente R3 BLOCK: https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6094470892. Este contrato R4 é a **única proposta normativa futura** nesta branch; R3 e anteriores permanecem históricos e não aprovados. Política vinculante: docs/taxonomy/TAX13_DOU_XML_FIRST_OWNER_DECISION_20261010.md.

A fronteira aqui é intencional: (A) XML INLABS é fonte canônica global para persistir e processar norma, taxonomia, relevância e IA **independentemente de PDF**; (B) PDF e índice oficiais são cotejo documental **seletivo**, sem motor jurídico paralelo, sem DOWNLOAD de PDF para cada XML; (C) análise temporal por dispositivo nasce do XML, mesmo quando nenhum job PDF foi agendado; (D) comprovação da PUBLICAÇÃO nunca confere CURRENT. Nenhuma exigência de ICP-Brasil, ITI, assinatura de PDF, OCSP/CRL.

## 1. Correções mandatórias R3 → R4

| Achado | Correção R4 | Evidência posterior necessária |
|---|---|---|
| P1 R3-01 — fatos jurídicos dependiam de PDF | Evento temporal referencia âncora de versão XML **obrigatoriamente**; referência a correlação PDF **opcional** e tipada pela mesma âncora | Teste sem job PDF, evento jurídico por dispositivo persistido sem CURRENT |
| P1 R3-02 — ZIP barrado por limite de PDF | CHECK por finalidade: PDF <= 20 MiB; índice <= 2 MiB; ZIP <= 64 MiB; expansão ZIP <= 128 MiB, arquivo individual <= 8 MiB, até 5000 entradas | PG16/18 aceita evento ZIP 25 MiB e rejeita PDF 25 MiB; parser e streaming respeitam teto |
| P1 R3-03 — identidade XML e dedupe | Âncora global tipada em publication_versions + publication_origins + hashes do texto e das partes; versionamento/correção e conflitos entre jobs definidos | Negativos origem diferente, XML adulterado, content_hash divergente, conflito dois jobs |
| P1 R3-04 — índice/manifests | Fonte de índice com adaptador allowlisted versionado e autoridade verificada, sem supor URL não confirmada; inventário completo do ZIP por digest e partes selecionadas **por matéria** | 80/80-A/80-B; jornal, seção, página, matéria, ZIP e parte incompatíveis falham; índice ausente PENDING |
| P1 R3-05 — gateways, RLS e revogação | Assinaturas, papéis e invariantes por função, FORCE RLS/trigger e ACL de cada tabela; projeção global independente de dados de tenant | PG16/18 duas sessões, replay, revogação concorrente, DML negado, tenant A/B |
| P2 R3-06 — cardinalidade | 1 verification_event por despacho/matéria; 1:N act_correlations por ato XML derivado, mesma verificação compartilhada | 2 atos, 1 PDF, 2 correlations para 1 verification, zero novas capturas |
| P2 R3-07 — estados operacionais | XML_PARSED e revisão temporal não dependem de PDF; documental NOT_REQUESTED/PENDING/VERIFIED/MISMATCH/UNAVAILABLE/REVOKED; sem status de CURRENT implícito | PDF down e mismatch não descartam XML; status de origem permanece pendente |

### 1.1. Limites do que se pode afirmar agora

O coletor atual src/modules/collection/dou.connector.ts chama downloadXml() e parseDouZip(), sem downloadPdf(); teste dedicado provou 39/39 PASS no CI #38028965169 (mocks/sintéticos). Existe função downloadPdf no cliente INLABS, mas não é chamada pela coleta regular. Código atual src/modules/collection/inlabs.client.ts permite ZIP até 64 MiB por padrão; o parser src/modules/collection/dou.parser.ts limita ZIP comprimido 64 MiB, soma descomprimida 128 MiB, entrada individual 8 MiB e 5000 nomes. Não substituir esses fatos por configuração documental inventada.

O banco existente possui public.publications(id, identity_hash,...), public.publication_origins(id, publication_id, source_id, external_id, official_url, metadata), public.publication_versions(id, publication_id, version_no, content_hash, content_text, source_metadata, is_current,...). **publication_versions.is_current é marcador editorial da versão, NÃO LEGAL_CURRENT.** Não assumir que version.content_hash é o SHA dos XML originais; ele representa o hash do conteúdo armazenado, com algoritmo a confirmar na implantação. Para provar bytes XML, usar os digests de partes originais separadamente.

A captura Railway PDF anterior SHA 9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44 diverge do PDF upload SHA e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201, e os bytes Railway foram descartados: equivalência **UNVERIFIED**; não retrocriar CAPTURED.

## 2. Duas cadeias com ciclo de vida separado

**Ingestão regular e análise (SEM PDF):**
ZIP INLABS autenticado → XMLs por matéria → publicação canônica global e publication_versions → validação de identidade/metadados → taxonomia/IA/filtros/busca → fatos jurídicos por dispositivo ligados a versão XML → relevância por tenant sob RLS. Falha em PDF não é falha desta cadeia.

**Atestação documental (SELEÇÃO EXPLÍCITA):**
âncora XML → scheduler restrito → GETs oficiais independentes COLLECTOR/VERIFIER para PDF, índice reconhecido e ZIP INLABS (3 alvos, 6 eventos **somente por job selecionado**) → manifesto arquivo + partes desta matéria → identidade seção/jornal/edição sufixada/página → cotejo integral do despacho com texto XML → verification_event de matéria → 0..N act_correlations → projeção documental sob rechecagem de revogação.

Não exigir agendar atestação para toda publicação XML. Seleção e orçamento devem ser auditáveis. Um XML pode ser PARSED/CLASSIFIED/TEMPORAL_FACTS_REVIEWED enquanto documental=NOT_REQUESTED/PENDING/UNAVAILABLE/REJECTED, sem criar SOURCE_ATTESTED nem CURRENT.

## 3. Identidade canônica: versão XML, parte e ato

### 3.1. Duas identidades XML: matéria e ato — nenhuma depende de PDF

**XML matter (uma por versão da matéria original)**: tax13_dou_xml_matters liga source_origin_id ao publication_versions do DESPACHO/ato pai, com parent_publication_id, parent_version_no, parent_content_hash do banco, date, section, numeric_edition, journal_id do nome da parte XML, page, matter_id, parent_external_id, original_archive_url/sha256, XML matter parts digest e matter_content_key_v4. Guarda uma identidade candidata XML **sem inventar sufixo A/B**. O gateway de ancoragem confere publication_origins.publication_id/source_id/external_id, publication_versions.publication_id/version_no/content_hash e source_metadata.dou.parts/archive a partir do parser; nenhuma FK simples entre tabelas garante essa consistência sozinha.

**XML act anchor (um por versão de cada ato filho, 1:N por matéria)**: tax13_dou_xml_act_anchors liga xml_matter_id à child_publication_version_id, child_publication_id, child_version_no, child_content_hash, child_external_id, embedded_index e act_version_key_v4. Na ausência de ato filho, uma âncora pode representar o próprio ato pai. O gateway exige derivação do mesmo despacho/INLABS, e verifica com banco e XML; não aceita identificação fornecida por outra matéria.

**Dedupe/versionamento:** UNIQUE(matter_content_key_v4) para versão da matéria, UNIQUE(xml_matter_id, child_publication_version_id) para ato; novos rechecks PDF produzem novos jobs, não novas versões XML. Se mesma chave lógica produzir dois payloads distintos, manter versões e marcar CONFLICT_PENDING em vez de último-write-wins. Nenhuma âncora depende de correlation_id de PDF. O documento final atestado tem document_identity_key_v4 (inclui seção, jornal, sufixo impresso, página, matéria, digest XML e PDF); numérico 80+DO1E nunca prova 80-A ou 80-B.

**Textos e hashes diferentes:** publication_versions.content_hash representa texto de banco, NÃO o SHA raw de ZIP/partes XML. Ambas as evidências ficam registradas e comparadas pelo gateway em transação com vínculos tipados. publication_versions.is_current indica a versão editorial corrente no catálogo e não prova vigência legal.

**Cardinalidade e independência:** 1 XML matter → N act anchors → N revisões temporais independentes de PDF. 1 job seletivo por matéria pode comprovar N atos usando o MESMO PDF/índice/ZIP, com N correlações apontando para N âncoras. Cada cliente vê a relevância apenas por seus próprios critérios, com RLS de tenant fora das tabelas canônicas.

### 3.2 CSV/JSON/ZIP não são XMLs externos admitidos

O ZIP do INLABS é o pacote de origem autenticado; cada parte XML selecionada tem filename /^\\d+_YYYYMMDD_matter(-n)?.xml$/, digest SHA256 dos bytes originais, sizeBytes, número de parte e campos validados pelo parser. Ordenar (filename UTF-8 e índice n) canonicamente, exigir part=1..N sem gaps/duplicatas, todos attrs da matéria coerentes, e digests rederivados do ZIP que o VERIFIER efetivamente capturou. Os campos source_metadata e urls não substituem isso.

**Inventário integral do ZIP** e **manifesto das partes da matéria** são coisas diferentes:
- ZIP inventory: digest de todos os até 5000 nomes/CRC32/tamanho/hash bruto relevantes, inclusive entradas não-XML. Contagem e digest guardados; inventário completo fica efêmero. Limites: zip compressed <=64MiB, cumulative uncompressed <=128MiB, entry <=8MiB. Proibir path traversal/zip slip, duplicatas e criptografia; não guardar binários no PG.
- XML matter parts: JSONB limitado de 1..48 partes (48 é teto **por matéria**, nunca do ZIP completo), com filename, rawSha256, sizeBytes, partIndex. SHA do manifesto calculado sobre ordem canônica; os arquivos selecionados devem ser subconjunto fechado do inventário original, sem partes extras da mesma matéria omitidas.
- Se não for possível enumerar todas as entradas ou houve falha parcial de parsing, falhar com MANIFEST_UNVERIFIED; não atestar usando só dois ou três arquivos escolhidos pelo caller.
- O manifesto vincula zip_capture_pair e matter_id, não armazena o ZIP ou XML raw.

### 3.3 Edição 80, 80-A e 80-B

Os metadados do XML incluem editionNumber numérico; DO1E é extra mas **não determina sufixo**. O binding documental exige referência oficial independente ao jornal ID, **impressão real** da edição e sufixo no PDF e vínculo à página. Um valor printedEdition fornecido por parâmetro só produz candidato; nunca prova positiva. O resultado final pode separar 80 de 80-A de 80-B somente após fonte editorial independente e cotejo.

**Fonte do índice (exigência fail-closed, SEM inventar endpoint):** não existe no material R3 evidência suficiente de um endpoint estável e máquina-legível que associe oficialmente journal=601 a 80-B + data/seção/página/matter. O contrato de integração deve registrar um **adapter_id + parser_version + allowlist de scheme/host/path/query + captura da resposta da Imprensa Nacional**, proveniência da listagem e regras determinísticas de extração de data, seção, journal, número+sufixo, página e matter. O scheduler não aceitará index_url arbitrária. Se o portal real não expuser listagem independente, o produto não fabricará INDEX_CAPTURED: status INDEX_PENDING, mesmo com PDF impresso e XML íntegro. Selecionar e demonstrar o endpoint/adaptador com artefatos oficiais reais é *gate de aprovação de implementação* e pode demandar ajuste do desenho, sujeito a revisão adicional. Página visualiza/index.jsp do XML e PDF INPDFViewer **não devem ser chamados de índice independente sem evidência**. Nenhum website privado nem snippet de buscador torna-se prova SQL.

## 4. Contrato DDL v4 — especificação para futura migration (não aplicar)

A camada de evidência é global, sem tenant_id. As FKs para publication_versions/publication_origins são parte da integração existente e devem usar exatamente os nomes e tipos reais após inspeção DBA. **Toda role escrita é NOINHERIT/NOBYPASSRLS; owner NOLOGIN, sem acesso indireto por app.**

### 4.1. DDL de referência completo das tabelas, ainda não executado

O arquivo [TAX13_R9_DOU_R4_FULL_DDL_REVIEW.sql](TAX13_R9_DOU_R4_FULL_DDL_REVIEW.sql) contém **as 11 definições de tabelas e índices** de referência, na ordem das dependências: xml_matters, xml_act_anchors, runtime_credentials, credential_revocations, collection_jobs, http_fetch_events, archive_manifest, edition_bindings, verification_events, act_correlations e xml_temporal_review_events.

Alterações objetivas verificáveis nele:
- **Purpose limits**: PDF<=20 MiB, OFFICIAL_INDEX<=2 MiB e INLABS_ZIP<=64 MiB, condicionados a CAPTURED; parse ZIP cumulativo<=128 MiB, uma entry<=8 MiB e no máximo 5000 entradas são invariantes do parser.
- **ZIP inventory versus XML matter:** zip_inventory_sha256 e zip_total_entries representam TODO arquivo ZIP; matter_parts representa apenas 1..48 partes da matéria alvo. Um ZIP diário com 100 arquivos e uma matéria de 2 partes **não** viola o limite 48.
- **Cross-table:** FKs compostas em manifest/binding/verification/act correlation ligam job, matter, actors e purpose, mas os hashes/conteúdos são rederivados e comparados pelo gateway protegido; FKs formais isoladas não provam a captura.
- **Temporal:** xml_temporal_review_events.xml_act_anchor_id NOT NULL, optional_documentary_correlation_id NULL permitido e FK composta ao mesmo ato somente quando a prova for associada. Registrar fatos do XML sem PDF é funcionalmente necessário.
- **Despacho 1:N:** verification_event_id **não é UNIQUE** em act_correlations; UNIQUE(verification_event_id,xml_act_anchor_id) permite N atos comprovados por uma verificação do despacho.

**Status explícito do arquivo:** apenas DDL de referência para revisão; não foi compilado nem executado em PG16/18, não inclui ainda a implementação das funções SECURITY DEFINER, provisionamento/grants/RLS final ou o parser de índice oficial aprovado. Não é a migration 049+ nem autoriza construí-la. A especificação comportamental e a matriz de controle das funções está na seção 5; a revisão independente deve recusar qualquer lacuna ainda considerada P1.

### 4.2 DDL complementar fixado por contrato, para evitar decisões implícitas na 049+

Tabela / vínculo / constraint obrigatórios (conforme DDL de referência):
- xml_matters e xml_act_anchors formam a identidade canônica de matéria e ato, separada da atestação; campos e FKs no arquivo SQL da seção 4.1.
- runtime_credentials (id PK, role_name exact scheduler/collector/verifier/temporal, epoch monotonic UNIQUE(role,epoch), valid_from/until, secret_ref no plaintext) e credential_revocations (credential_id PK FK, timestamp/reason; apenas INSERT).
- collection_jobs (id PK, xml_matter_id FK, credential scheduler FK, data/seção/journal/página/matéria herdadas por seleção autenticada da âncora, pdf_url/index_url/zip_url fixadas por adapters internos; unique(job_id,xml_anchor_id), selected_reason/selected_at; target_fingerprint_v4 **NOT unique** por permitir recaptura) com FK (xml_anchor_id, archive_sha256 se materializado) referencial quando aplicável. **Não** aceitar URL do cliente/curador.
- http_fetch_events com FK tripla/quadrupla typada (id,job_id,actor,purpose); registrar cada tentativa imutável, inclusive erros e retries. Collector/Verifier não compartilham LOGIN/secret nem processo/egress. Atestação exige pares de SHA iguais, job e URLs coincidentes; evento ERROR/UNAVAILABLE não equivale a zero publicações.
- archive_manifest **por matéria**, referenciando par de eventos COLLECTOR/VERIFIER INLABS_ZIP com FKs compostas; comparar ambos SHA da resposta ao zip_sha256 e zip original da âncora. Se o archive original já arquivado tiver bytes divergentes, bloquear atestação em vez de mudar hash silently.
- edition_bindings (id PK, job_id FK, archive_manifest_id/job_id FK, quatro FKs tipadas PDF/INDEX dos dois atores, printed_edition incluindo A/B, publication_date, section, journal, page, matter, pdf_sha256, index_sha256, document_identity_key_v4 UNIQUE versionada; identidade = função dos bytes verificados + âncora).
- verification_events (id PK, job_id FK, binding_id/job_id FK, credential verifier FK, parsed index/whole-dispatch report SHA/versions e outcome REJECTED/UNVERIFIED/CORRESPONDS); um verificador para um despacho pode produzir múltiplos child correlations.
- act_correlations (id PK, verification_event_id FK **SEM UNIQUE na verification_event_id**, xml_anchor_id FK, parent/child version ids comparados à âncora, spans do despacho/ato, full_match_sha256, algorithm_version, unique(verification_event_id,xml_anchor_id) e unique(id,xml_anchor_id)). Não permitir dois positivos conflitantes para o mesmo anchor/document_identity em diferentes jobs sem projetor fail-closed.
- xml_temporal_review_events: FK obrigatória apenas para xml_anchor; optional_documentary_correlation_id tipada para o mesmo anchor e NULL permitido. O gateway temporal NÃO executa nem invoca criação de job PDF. Fatos registrados não provam vigência automaticamente.
- todas as FKs referem-se a objetos globalmente canônicos; NEVER tenant_id nas tabelas de origem. Sem duplicação de PDF por child/empresa.
- recomendação de único cadastro de estados de coleta existente: usar collection_runs/collection_attempts para diagnósticos XML sem criar mais uma tabela de "nenhum documento", e derivar NO_RELEVANT_PUBLICATIONS por tenant somente com consultas completas.

Cardinalidade: 1 job por XML matter → 3 alvos x 2 actors → 1 manifesto por matéria → 1 binding por edição/página/matéria/versão → 1 verification_event por despacho → N act_correlations de atos do despacho; N âncoras XML compartilham o mesmo manifesto e verification_event, e um evento temporal refere-se a 1 anchor independente de PDF.

## 5. Contrato definitivo de gateways e controles SQL

### 5.1 Papéis e isolamento

| Login | EXECUTE permitido | Tabelas diretas |
|---|---|---|
| radar_dou_scheduler_runtime | schedule_evidence_job | NONE |
| radar_dou_collector_runtime | record_collector_fetch | NONE |
| radar_dou_verifier_runtime | record_verifier_fetch; admit_documentary_chain | NONE |
| radar_dou_credential_admin_runtime | add_credential; revoke_credential | NONE |
| radar_dou_temporal_runtime | append_xml_temporal_fact | NONE |
| radar_dou_read_runtime | read_global_documentary_status_by_version | NONE |
| radar_app_runtime, worker, curator, issuer, scan-sealer, tenant | NONE em origem/ledger | NONE |
| radar_dou_ledger_owner NOLOGIN | OWNER de dados e funções SECURITY DEFINER | OWNER com FORCE RLS |

Runtimes LOGIN sem BYPASSRLS, sem SUPERUSER, sem CREATEROLE/CREATEDB, NOINHERIT. Sem grant membership em owner, collector ou verifier para app/worker. Todas as tabelas REVOKE ALL FROM PUBLIC, APP, WORKER e login runtime; ENABLE ROW LEVEL SECURITY + FORCE ROW LEVEL SECURITY, policies exatas SELECT/INSERT apenas para owner NOLOGIN, ausência explícita de UPDATE/DELETE/TRUNCATE, trigger que RAISE BEFORE UPDATE OR DELETE mesmo quando alguma role com permissão obtida por erro. REVOKE CREATE ON SCHEMA public FROM PUBLIC e runtimes; funções e views fora de schema gravável, search_path seguro = pg_catalog,pg_temp e nomes public totalmente qualificados, owner NOLOGIN, REVOKE EXECUTE FROM PUBLIC após criação e default ACL idem.

**Papel separado credencial e scheduler:** dono de credencial não pode ser collector/verifier. Tabela de credenciais guarda apenas referência, nunca password, cookie, HMAC key ou token. Revogação é novo evento, não UPDATE em event histórico.

### 5.2 Interfaces congeladas propostas (assinatura, pré e pós)

Abaixo são **interfaces de design** para gerar futura SQL e testes PG após aprovação; não são funções criadas neste PR. Qualquer implementação que exponha boolean verified, raw body, SQL user URL arbitrária, ou contorne papéis invalida o contrato.

1. schedule_evidence_job(p_xml_matter_id uuid, p_reason_code text, p_request_fingerprint char(64)) RETURNS uuid, EXECUTE exclusivamente scheduler; compara âncora ao banco, motivo em allowlist e política de custo; rederiva URL ZIP de arquivo origin e URL PDF de certifiedPageUrl; escolhe index adapter somente se fonte oficial aprovada; congela job por identidade de versão XML, sem confundir job com publicação; LOCK anchor; idempotência por request_fingerprint para pedidos iguais, permitindo rechecks explícitos distintos.
2. record_collector_fetch(p_job_id uuid,p_purpose dou_r4_target,p_attempt_no int,p_observation struct_capture_v4) RETURNS uuid, EXECUTE exclusivamente collector, com session_user exatamente collector e credencial vigente; observation nasce do client HTTPS interno, sem endpoint externo com acesso ao login; valida job/purpose/URL planejada, host, TLS, no redirect, response MIME e byte_count propósito, SHA real dos bytes, timestamps, locked credential epoch, fingerprint v4; grava CAPTURED ou ERROR/UNAVAILABLE/REJECTED, nunca "ausência publicada".
3. record_verifier_fetch(p_job_id uuid,p_purpose dou_r4_target,p_attempt_no int,p_observation struct_capture_v4) RETURNS uuid, EXECUTE exclusivamente verifier, exige GET HTTPS **novo e independente** com chave e rede separadas; as mesmas validações; não reutiliza hashes declarados pelo collector; emit em ledger imutável.
4. admit_documentary_chain(p_job_id uuid,p_pdf_collector uuid,p_pdf_verifier uuid,p_index_collector uuid,p_index_verifier uuid,p_zip_collector uuid,p_zip_verifier uuid,p_manifest_report_v4 jsonb,p_edition_report_v4 jsonb,p_dispatch_report_v4 jsonb) RETURNS uuid, EXECUTE verifier; não aceita verified=true nem status client. Valida, sob locks no job e credenciais, os seis eventos por FK typada e mesmo job/target/URL/hash, fonte índice oficial independently parsed, ZIP inventory+partes rederivados dos mesmos bytes do verifier, SHA contra âncora original e parent/child DB versions, PDF whole-dispatch completo e sufixo da edição; verifica assinatura de artefato de parser/version dentro da mesma sessão confiável e commit manifest+binding+verification+N act correlations atomicamente. **Relatórios JSON são dados a validar, não declarações de autenticidade**. Sem memória/processo confiável com bytes correspondentes, retornar UNVERIFIED/erro e não gravar positivo.
5. append_xml_temporal_fact(p_xml_act_anchor_id uuid,p_device_ref text,p_event_kind text,p_as_of date,p_fact_payload_v4 jsonb,p_optional_correlation_id uuid DEFAULT NULL) RETURNS uuid, EXECUTE temporal; nunca agenda PDF, exige âncora XML válida e fatos com fonte oficial (URL/hash se disponível), data e fragmento, nunca aceita set_CURRENT, checa se correlação opcional aponta à mesma âncora, grava append-only PENDING/FACTS_ONLY/UNVERIFIED.
6. read_global_documentary_status_by_version(p_child_version_id uuid) RETURNS (status dou_r4_documentary_status,evidence_id uuid,observed_at timestamptz) com somente **status público global** da norma, sem tenant/relevância/IDs privados. Antes de VERIFIED exige FK/roles/URLs/hashes pares/reports/fingerprint/document_key, ausência de conflitos entre jobs, credenciais não revogadas em transação com mesmo conjunto de locks do revoker. Leitura de relevância para cliente ocorre **fora desta função**, em associação com RLS e tenant auth efetiva. Não confiar em p_tenant_id do cliente ou GUC arbitrária. Se nenhum job: NOT_REQUESTED; se incompleto: PENDING; divergência: MISMATCH; interrupção: UNAVAILABLE; revogado: REVOKED; claims positivos contraditórios: CONFLICT.
7. add_credential(p_role,p_epoch,p_key_ref,p_valid_from,p_valid_until) e revoke_credential(p_credential_id,p_reason) somente credential_admin; lock na credencial e registro de revogação irreversível, processar ordem de locks consistente com escrita/projeção. Credencial revogada retroativamente invalida positividade de projeção, preserva histórico.
8. read_xml_temporal_facts(p_child_version_id uuid) é projeção **independente da função documentary** e somente disponibiliza fatos para avaliação tributária; nunca retorna CURRENT derivado. Proteção tenant no consumidor de relevância, revisão de fragmentos/corpus legal específica.

**NOTA sobre struct_capture_v4:** não criar tipo SQL facilmente invocável por API comum. O contrato de implantação precisa especificar como runtime autorizado usa a própria conexão/observação interna e como garantir que app/worker não obtêm credencial exclusiva; o banco não observa TLS e não pode autenticar rede só por SHA/HMAC/JSON. Na etapa 049+ o gateway deve usar colunas tipadas e entrada controlada; validar os dois workloads sob ameaça de forja de um deles. Se verificador comprometido e collector comprometido simultaneamente, isso é risco residual reconhecido, não "prova criptográfica".

### 5.3 Transação, autorização, reprodução de ataques

- Runtime chamadas SQL ficam sob session_user do LOGIN dedicado. Nenhuma role pode fazer SET ROLE para obter bypass, usar conexão de outra role, executar CREATEROLE ou escrever schema. Funções SECURITY DEFINER qualificam todos os objetos e recusam sessão do actor errado mesmo em caso de GRANT acidental.
- Uma capture event por (job,actor,purpose,attempt_no). Hash versionado: SHA256 JSON canônico/domínio, incluindo SHA dos bytes, URL final, epoch, horários, versão. Replay idêntico retorna id conhecido; replay divergente lança DOU_REPLAY_CONFLICT, nunca sobrescreve eventos. Retry novo aumenta attempt_no e preserva erro anterior.
- Não travar banco durante download; só transações curtas para eventos, validação de staging de digest e atestação. Locks advisory por job → credencial IDs ordenadas → xml_anchor, mesma ordem em revoker e projector; snapshot READ COMMITTED consistente ao concluir status; documentar linearização e invalidar cache positivo após revoke.
- Conflito cross-jobs: a projeção agrega resultados por child_publication_version_id + document_identity_key_v4; dedupe por SHA/versão, não por job. Dois positivos com digests diferentes para mesma versão/edição → CONFLICT, sem "winner takes last"; novo conteúdo normativo cria nova versão XML e revisão. Conflito entre status ao mesmo tempo → fail closed.
- CHECK/FK de forma sozinhos não provam dados rederivados de bytes: verificar ZIP, XML e PDF em função confiável interna; se qualquer parte do manifesto não fechar com ZIP original ou um dos atores divergir, não publicar positivo.
- Separação de parser PDF e motor jurídico: PDF parse só coteja; normalização não apaga números/negações, valida despacho inteiro e siblings anteriores/posteriores; char offsets e layout ambíguo permanecem UNVERIFIED.
- Superuser desonesto, dois workloads comprometidos, edição oficial retroativamente modificada e PDF descartado são riscos explícitos; retenção de metadados não confere audit replay dos bytes. Objeto original imutável fora de PG exige autorização futura.

### 5.4 Testes de segurança obrigatórios na futura 049+ (somente após R4 APPROVED)

1. PG16/18: FORCE RLS em TODAS as tabelas, owner NOLOGIN; app/worker/curator/issuer/sealer não SELECT nem INSERT nem EXECUTE; owner sem UPDATE/DELETE/TRUNCATE; search_path injection e SET ROLE negados.
2. Duas sessões collector/verifier: um actor isolado não obtém status VERIFIED mesmo fabricando SHA/DTO; dois eventos de papel igual falham; credencial expirada/revogada falha.
3. ZIP 25 MiB aceito como CAPTURED (se stream/parser válido); PDF 25 MiB rejeitado; ZIP 65 MiB rejeitado; decompressed >128 MiB rejeitado; 5001 entradas e entry >8 MiB rejeitados.
4. ZIP de 100 XML, 2 partes de uma matéria: zip_inventory_count=100, matter_parts_count=2, sem limitação indevida a 48 arquivos ZIP. Falha se parte faltante/duplicada ou filename pertencente a outro matter.
5. XML sem PDF agenda zero GET; permite facts-only temporal por dispositivo e taxonomia; SOURCE status NOT_REQUESTED e CURRENT permanece PENDING.
6. Uma única edição/verificação/GET PDF para 2 children do despacho; 2 correlações distintas ligadas a 2 âncoras corretas; nenhum acesso de outro tenant a relevância.
7. 80 vs 80-A vs 80-B: não admitir numérico 80 com DO1E sem índice oficial e cabeçalho PDF compatíveis. Alterar jornal/página/matter no índice ou XML impede positivo.
8. Conflito entre job recheck do mesmo XML com hash PDF diferente → CONFLICT e auditoria, não última escrita ganha; re-fetch nunca vira recibo retroativo.
9. Padrões de falha HTTP/PDF indisponível, 429, 503, XML ausente, índice rejeitado retornam UNAVAILABLE/ERROR/PENDING sem NO_RELEVANT_PUBLICATIONS global e sem deixar de classificar XML válido.
10. Credencial revogada concorrentemente ao commit de correlação e à leitura documental: projeção após revogação nunca VERIFIED; eventos permanecem append-only.
11. Teste relatório JSON e sourceCapture maliciosos com role app/verifier isolado; nenhum deles cria publicação oficial admitida sem cadeia de origens separadas.
12. SOURCE publicação, ratificação, retroatividade, alterações e prazo vencido não autorizam automaticamente LEGAL_CURRENT; migration 048 continua intocada, com R7/TAX11 bloqueados.

## 6. Critérios para encerrar DESENHO R4 e seguir à migração 049+

A revisão independente deve avaliar **a suficiência das interfaces e invariantes**, não presumir código ou SQL positivo já implementado. Há limites que precisam ser resolvidos ANTES de escrever migration 049+: (i) escolher e provar endpoint/editorial INDEX realmente independente com regra de parsing fail-closed; (ii) validar as reais keys/indexes/fontee metadata de publication_versions/publication_origins no head cumulativo; (iii) definir detalhes exatos do handoff de provas do parser confiável e dos grupos de funções transacionais para não deixar qualquer status positivo dependente de JSON arbitrário; (iv) final DDL de tabelas remanescentes e autorização tenant SQL testáveis sem confiar em prompt; (v) tratamento de race com revogação.

**NÃO declarar este documento SQL compilável nem o desenho APPROVED.** A aprovação independente pode concluir BLOCK caso alguma das questões acima ainda seja fundamental para a segurança arquitetural; informar risco P1/P2 concretamente. O objetivo da R4 é corrigir as contradições demonstradas na R3, preservando o desenho XML-first e deixando as interfaces abertas visíveis, e não mascará-las com testes sintéticos positivos.

**Nenhuma migração 049+, CI positivo de origem real, Railway, deploy, merge, reprodução histórica ou marcação jurídica CURRENT foi autorizada.**