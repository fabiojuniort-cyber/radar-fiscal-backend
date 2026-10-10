# TAX13 / DOU — Decisão do proprietário: XML-FIRST, PDF como evidência complementar

**Data da decisão:** 2026-10-10  
**Status:** decisão arquitetural do proprietário, vinculante para futuras propostas e revisões; **NÃO** aprova a implementação SQL, migration 049+, SOURCE_ADMITTED/CURRENT, merge ou produção.  
**Contexto:** TriBusca / Trifaros / Radar Fiscal; TAX13 R9-DESIGN-R3, PR #196, Issue de governança #101.  
**Origem:** orientação direta do proprietário: *todo o trabalho jurídico/tributário deve acontecer sobre o XML; o PDF continua como evidência de publicação*.  
**Compatibilidade:** não alterar migration 048, não exigir assinatura digital de PDF/ICP-Brasil/ITI/OCSP/CRL; manter bloqueios R7/TAX11/R9 e coleta histórica DOU suspensa.

## 1. Regras obrigatórias

1. **Fonte primária para processamento: XML INLABS.** O coletor rotineiro DOU obtém os ZIPs oficiais de XML (`DO1`, `DO1E`, `DO3`, `DO3E`), valida formatos e limites, extrai as matérias e mantém um único registro canônico de cada publicação. Hashes do ZIP/partes XML, referências e identidade da matéria integram a rastreabilidade.
2. **Um único texto jurídico canônico para o motor.** O conteúdo derivado do XML é a entrada para classificação tributária, taxonomia por dispositivo, filtros NCM/CNAE/temas, consolidação, pesquisa, análise IA e futuras aplicações por cliente. **Não** introduzir um segundo pipeline jurídico a partir do PDF nem duplicar publicações porque o PDF foi examinado.
3. **PDF é exclusivamente evidência documental complementar.** Quando a prova oficial da edição/publicação for necessária, baixar da fonte governamental confiável por HTTPS, observar o índice oficial e confrontar no mesmo fluxo a edição/data/seção/página/despacho/ato e o conteúdo completo em relação ao XML canônico. A extração temporária de texto do PDF é **apenas para comparar**; o texto extraído nunca substitui automaticamente o XML como conteúdo canônico ou alimenta a taxonomia/IA.
4. **PDF não é requisito para coletar, salvar, classificar ou analisar XMLs.** Falha ou ausência do PDF não invalida a captura bem-sucedida do XML, mas impede elevar o status de comprovação documental quando a política de atestação o exige.
5. **XML não se autodeclara prova conclusiva da edição publicada.** XML/ZIP oficial com URL, metadados e SHA assegura uma trilha de origem operacional e um conteúdo candidato para processamento; não confundir isso com a versão certificada do DOU. A atestação reforçada requer conferência documental quando solicitada; nenhum `xml_collected=true`, checksum ou URL isolado gera `SOURCE_PUBLICATION_ATTESTED`.
6. **Vigência separada.** Atestação de publicação, inclusive PDF confirmado, não gera `CURRENT`. Ratificação, retroatividade, emendas, revogações, efeitos por dispositivo e `as-of` são revisões jurídicas independentes, com prova separada. Não colorir como vigente uma cláusula somente porque foi coletada ou cotejada.
7. **Sem armazenamento de PDF no PostgreSQL.** O processamento PDF pode ser efêmero, registrando-se metadados mínimos, URL governamental, SHA dos bytes efetivamente obtidos, identidade documental, versões de comparador/extrator e eventos de erro. Retenção opcional de arquivo original único fora do PostgreSQL precisa de decisão separada. Não armazenar JPG; não replicar evidências por tenant.

## 2. Dois fluxos distintos, sem duplicidade

### A. Coleta e inteligência — fluxo padrão, XML-only

`INLABS ZIP/XML → validação de transporte/ZIP/XML → matéria canônica → parser de dispositivos → taxonomia/classificação/consolidação/busca/filtros/IA → relevância por tenant`.

- **Não chamar PDF em lote** para cada matéria XML; não condicionar a fila de taxonomia ao PDF.
- A mesma publicação canônica é processada uma vez e referenciada por N empresas; não fazer N downloads de PDF nem N cópias do XML.
- Salvar estados independentes: `XML_COLLECTED`, `XML_PARSED`, `XML_VALIDATED` ou erro/indisponibilidade conforme contrato existente. Estes estados **não** são sinônimos de `OFFICIAL_PUBLICATION_ATTESTED` ou `LEGAL_CURRENT`.
- `NO_RELEVANT_PUBLICATIONS` só é possível para um tenant/filtro depois da consulta completa de todas as fontes/partições previstas, não após falha de download.
- Se o XML contiver inconsistência, matéria truncada ou identidade ambígua, manter candidata `UNVERIFIED/REQUIRES_REVIEW` conforme severidade: não permitir admissão jurídica positiva por simples continuidade de pipeline.

### B. Atestação documental — fluxo seletivo, com PDF

Gatilhos possíveis: norma selecionada para prova jurídica positiva, divergência de edição, publicação de alto impacto, validação humana ou auditoria amostral. *Política de gatilhos e custos deve ser aprovada antes de execução real*.

`Referência canônica do XML → job de atestação → índice DOU + PDF governamental + ZIP/XML INLABS autenticados → correlação completa com o texto XML → evidência append-only → status documental projetado`.

- A arquitetura R3 de *três tipos de alvo* e de *capturas independentes collector/verifier* aplica-se **somente ao job de atestação**, não ao coletor DOU periódico.
- O XML já armazenado pode identificar o alvo e servir de candidato, mas não constitui por si só o evento HTTP de prova. Se o contrato exigir captura independente do ZIP/partes durante a atestação, realizar nova captura real e vinculá-la ao conteúdo original; nunca preencher `CAPTURED` retroativamente a partir de SHA, string, upload ou mock.
- PDF e XML devem coincidir materialmente nos limites exatos da publicação e do ato. Se houver diferença ou não for possível recuperar o PDF, registrar `TEXT_UNVERIFIED`, `MISMATCH` ou `EVIDENCE_PENDING` sem falsificar prova, preservando o XML para análise **não atestada** e encaminhando discrepâncias à revisão.
- A classificação e os dispositivos permanecem derivados do XML, mesmo quando PDF for usado para cotejo. Caso a fonte documental discorde do XML, **não** substituir conteúdo automaticamente: marcar conflito, suspender atestação positiva e exigir decisão auditável.
- Um cotejo bem-sucedido pode ser reutilizado entre clientes mediante o mesmo identificador canônico e política de expiração/revisão de fonte, sem novo download por tenant.

## 3. Contrato funcional mínimo para a próxima revisão R9

Separar na API, ledger e dashboard, sem estados ambíguos:

| Dimensão | Exemplos | O que autoriza |
| --- | --- | --- |
| Integridade da coleta XML | `COLLECTED / PARSED / ERROR / UNAVAILABLE` | Persistência, processamento tributário e diagnóstico; NÃO prova da edição certificada |
| Correspondência documental | `NOT_REQUESTED / PENDING / VERIFIED / MISMATCH / UNAVAILABLE / REVOKED` | Evidência específica de publicação, somente após cadeia oficial e controle de acesso; NÃO vigência |
| Revisão jurídica por dispositivo | `PENDING / INSUFFICIENT / REVIEWED` + eventos e datas | Fundamentação temporal; promoção a `CURRENT` exige cadeia legal separada e aprovada |
| Relevância por cliente | matches/filtros por tenant, com RLS | Exibição personalizada; sem duplicação da publicação |

Notas de implementação:
- O nome exato dos enums/tabelas acima é **semântico**, não DDL autorizado. Reutilizar a infraestrutura existente e evitar tabelas redundantes. O contrato normativo R3 deve distinguir claramente `collection_run` comum de `documentary_evidence_job`.
- O projeto de 049+ deve explicitar que **não** existe obrigação de seis GETs oficiais por publicação coletada no fluxo rotineiro. As seis observações propostas em R3 só pertencem ao job de atestação selecionado, caso essa arquitetura seja aprovada independentemente.
- O XML permanece fonte canônica para a apresentação e interpretação; o PDF capturado deve servir exclusivamente à verificação de texto/edição (não requer assinatura do documento).
- Preservar URLs e hashes da fonte e os outcomes `UNAVAILABLE/ERROR` separados de ausência de publicações.

## 4. Estado da evidência histórica e dos gates

A captura Railway de 2026-10-10 retornou PDF SHA-256 `9cbfa79d35db5a63320c78620543a69f99e05c49f69e7c5f05de6bd32b814e44`; o PDF fornecido pelo proprietário tem SHA-256 `e5cc4ad9512e748bd9c720dc78579e2e66ea1979d6fc1cca3061ecd1dd8ce201`. Os bytes do GET não foram retidos. **Não há comparação textual comprovada** entre eles nem autorização para reutilizar o recibo como prova positiva. Não fabricar coleta e não retomar a carga histórica.

**Gates mantidos:** desenho R9 independente; implementação SQL 049+ somente depois de desenho aprovado; PG16/PG18 adversarial; captura oficial real autorizada posteriormente; R7/TAX11/CI e aprovação específica antes de merge/deploy. A migration 048 continua intacta e restrita ao CONFAZ.

## 5. Critérios de aceite da decisão XML-first

- Demonstração do pipeline INLABS XML → taxonomia/busca sem GET PDF;
- confirmação de que a extração PDF só é acionada na rota de evidência, não como entrada do motor jurídico;
- teste de falha PDF preservando publicação XML classificada, mas com comprovação documental pendente;
- teste de divergência entre XML/PDF impedindo atestação positiva sem apagar/substituir o XML;
- teste 80 vs 80-A vs 80-B/índice/jornal/ZIP/XML sem inferência a partir de edição numérica;
- nenhuma elevação a `CURRENT` por XML ou por PDF isoladamente;
- canonicalidade global e isolamento das relevâncias de tenants;
- migração 048 sem alteração e ausência de deploy, merges, cron histórico ou recibos positivos sintéticos.

**Esta decisão ajusta a arquitetura, não elimina os requisitos de confiabilidade documental nem os achados P1/P2 dos pareceres R9 anteriores.**