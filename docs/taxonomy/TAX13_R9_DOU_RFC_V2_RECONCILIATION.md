> **SUPERSEDED — HISTÓRICO R9-DESIGN-R2 / NÃO NORMATIVO PARA MIGRAÇÃO 049+.** Este documento preserva a proposta original e suas divergências para auditoria. A decisão arquitetural única proposta para revisão R9-DESIGN-R3 está em [TAX13_R9_DOU_CANONICAL_CONTRACT_R3.md](TAX13_R9_DOU_CANONICAL_CONTRACT_R3.md). Não executar DDL/snippets deste RFC R2; não tratar como segunda opção para produção. R9-DESIGN-R3 ainda NÃO está aprovado.

# TAX13-R9-REMEDIATION — reconciliação de duas RFCs SQL v2 (10/10/2026)

**IMPORTANTE: NÃO EXISTE DECISÃO DE MIGRATION 049+.** PR draft [#195](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/195) tem **duas propostas de esquema**, ambas design-only, produzidas em atividade concorrente. Preservamos ambas para não perder trabalho; **não** são duas migrations que se devam executar ou aplicar em sequência. O desenho unificado depende de R9-DESIGN-R2 independente.

## Propostas comparadas

**Proposta A — contrato de custódia/verificação + credenciais:**
`docs/taxonomy/TAX13_R9_DOU_EVIDENCE_SQL_RFC_V2.md`.

Propõe oito famílias de tabelas: identidades documentais, jobs, credenciais runtime, revogações, eventos HTTP, eventos de verificação independente, correlações do ato e revisão temporal. Pontos fortes: controle de revogação persistente, requisito formal de duas identidades segregadas para prova documental positiva, atributo fonte/candidato não admissível, esquema de temporalidade por dispositivo e política de `NO_RELEVANT_PUBLICATIONS` por cliente. Pontos a revisar: manifestação detalhada de cada parte XML não é tabela própria; DDL de funções verificador permanece **não implementado**; modelo define roles/jobs adicionais; distinguir status de eventos de origem da projeção de fonte admitida.

**Proposta B — manifesto de arquivo e vínculo por índice:**
`docs/taxonomy/TAX13_R9_DOU_SOURCE_EVIDENCE_SQL_RFC_V2.md`.

Propõe seis famílias de tabelas: execuções, eventos HTTP, manifesto ZIP/XML, vínculos de edição/jornal, correlação de atos e revisão temporal. Pontos fortes: FKs especializadas de tipo de captura, identidade explícita da edição impressa junto ao jornal e manifesto do XML/ZIP, estados de match e estrutura de job. Pontos a revisar: contrato de revogação/rotatividade depende de epoch e arquitetura externa, sem tabela explícita de credenciais/revogações equivalente à proposta A; comprovação independente de origem e implementação da admissão não estão demonstradas por SQL; origin and correlator roles precisam contratos de garantia contra receipt forgery e replay verificáveis.

## Recomendação do executor para a revisão independente

Não escolher um arquivo como migration apenas pelo tamanho. **Candidato de síntese para novo contrato, sujeito a R9-DESIGN-R2**: usar da proposta B a captura indexada por propósito (PDF/INDEX/ZIP/XML), tabela de manifesto original e vínculo oficial índice→journal→sufixo→matéria; incorporar da proposta A a identidade forte entre despacho/ato e versão do documento, as revogações explícitas das credenciais e evento de verificação que referencia os fetches e é emitido exclusivamente por verificador runtime independente. Mantém-se **uma única** tabela global de eventos de HTTP e uma única tabela de correlações, com nomes/PK definidos na futura revisão e sem duplicar captura por tenant. Estados `CAPTURED`, `UNAVAILABLE`, `ERROR`, `REJECTED` são de tentativa; `NO_RELEVANT_PUBLICATIONS` é uma projeção derivada por tenant/escopo após sucesso integral de todas as fontes relevantes.

**Condições que nenhum dos dois documentos supera hoje:** DB e metadados não observam TLS; um `session_user`/HMAC/DTO isolado não é evidência da rede sem ambiente confiável; função de verificador real/permissionamento PG16/18 ainda não implementados; captura PDF Railway original `9cbfa79d...` não possui bytes para comparação com upload `e5cc4ad...`; índice `601→80-B` ainda não está vinculado ao XML/ZIP real na mesma execução; vigência jurídica por dispositivo permanece pendente; migration 048 NÃO deve mudar.

## Decisões requisitadas ao R9-DESIGN-R2

1. Aprovar ou bloquear a **proposta de síntese**, indicando o conjunto mínimo de entidades e FKs (archive-manifest + edition binding + authenticated source verification + credenciais/revocations) e o que pode ser reutilizado do banco existente.
2. Exigir uma **única RFC final** e uma única migration 049+ eventual, sem nomes conflitantes. Indicar se o desenho requer código de admissão SQL completo antes de qualquer APPROVED-R9-DESIGN-R2.
3. Testar o cenário de collector sozinho emitindo CAPTURED, correlator sozinho fabricando match, comprometimento de uma credencial, replay e revogação, inclusive em tenant A/B, e fornecer mitigação.
4. Decidir como revalidar XML/ZIP e índice governamental originalmente baixados com controle de fonte sem armazenar bytes no PostgreSQL.
5. Identificar riscos da nova checagem de seção e limites do texto e do montagem espacial do PDF em um corpus governamental futuro.
6. Distinguir aprovação de desenho de admissibilidade documental real e de CURRENT; nenhum PDF de fato capturado foi legitimamente admitido pela nova estrutura nesta fase.

**Status:** alternativas documentadas e preservadas, não reconciliadas em DDL migratório. P1-D04 permanece **PENDENTE DE R9-DESIGN-R2** para definição de esquema único. Não substituir um parecer independente pela síntese sugerida pelo próprio executor. Nenhuma autorização para Railway, migrations, merge/deploy, tags verdes ou DOU histórico.
