# TAX13 R9-DESIGN-R3 — remediação independente do parecer R9-DESIGN-R2

**ESTADO: PACOTE DE SUBMISSÃO AO REVISOR, NÃO APPROVED.**

**R2 independente:** [BLOCK no HEAD congelado 29dbae16](https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6094176735). O SHA auditado permanece imutável. PR #195 continuou com dois commits após aquele SHA, não auditados na R2. **R3 incremental isolado:** [PR draft #196](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/196), base branch fix/tax13-r9-design-remediation-r2. Consulte o checkpoint de governança para o SHA final.

## Quatro bloqueios reais R9-R2

| Finding R2 | Remediação proposta R3 | Ainda não comprovado |
| --- | --- | --- |
| P1 R9-R2-01 — dois RFCs incompatíveis | **Um contrato normativo único:** `docs/taxonomy/TAX13_R9_DOU_CANONICAL_CONTRACT_R3.md`. Ambos RFCs v2 estão marcados SUPERSEDED, permanecendo como histórico. Uma única decisão de entidades e papéis | Aprovação independente do contrato único |
| P1 R9-R2-02 — admissão HTTP/verifier incompleta | Duas aquisições governamentais por papéis segregados, COLLECTOR e VERIFIER, cada uma PDF/INDEX/ZIP. Capturas de atores distintos, credenciais/egress isolados, hashes comparados; somente verificador insere correlação via gateway restrito, projetor dinâmico revalida credenciais | Workloads segregados e código executável 049+ ainda não implementados. PostgreSQL não comprova TLS sozinho |
| P1 R9-R2-03 — despacho não delimitado por inteiro | Novo match do envelope do despacho normalizando Identifica + corpo inteiro, incluindo texto introdutório e siblings anteriores/posteriores, além de offset do ato. Testes negativos em preâmbulo/sibling anterior | Corpus PDF oficial e extração em páginas de diagramação variada permanecem NOT VERIFIED |
| P1 R9-R2-04 — invariantes entre tabelas | Um desenho de nove tabelas; FKs tipadas por job/ator/purpose, manifesto XML do ZIP, bindings de edição, IDs e hashes, transação curta com lock/revocation/idempotência, projeção fail-closed, FORCE RLS, append-only, ACL | Compilação da futura migration e testes PG16/18 só após R3 APPROVED |

## Matriz original D01–D08

| Finding original | Status atual |
| --- | --- |
| D01 trust boundary | **DESIGN CANDIDATE** — duas sessões independentes; código de runtime ainda não existe |
| D02 80 / 80-A / 80-B | **DESIGN CANDIDATE**, sem captura real do índice/INLABS para 601→80-B |
| D03 texto completo | **UNIT CANDIDATE**, exige corpus oficial para validar diagramação/extrator |
| D04 SQL/ACL | **DESIGN CANDIDATE** com um contrato único, sem migração ou SQL real |
| D05 real HTTP/upload | **PENDING EXTERNAL**: Railway hash 9cbfa79d... não é igual ao PDF upload e5cc4ad..., bytes Railway descartados, nenhuma equivalência afirmada |
| D06 retenção | PASS conceitual, limitação de replay explicitada; não gravar PDF/ZIP no PG |
| D07 PDF/extraction | PASS parcial em testes sintéticos, PDF real NOT VERIFIED |
| D08 cronologia | PASS conceitual na separação por dispositivo, sem CURRENT |

## Evidências e cuidados

- CI DOU dedicado no commit de estabilização de testes: https://github.com/fabiojuniort-cyber/radar-fiscal-backend/actions/runs/38027953535 — **PASS TypeScript + 28/28 testes sintéticos**. Runs posteriores de commit documental necessitam verificação independente antes de declarar PASS no novo HEAD.
- Teste inicial no PR #196 falhou 3 casos quando a fixture passou a usar o texto completo; identificou problema de reconstrução de `Identifica` separado do `Texto` XML, corrigido no código e na fixture. Uma segunda falha ocorreu porque o ato irmão sintético era curto demais para o mínimo de completude; fixture ajustada sem relaxar o gate. Registrar as falhas como progresso, não apagar histórico.
- O comparador de memória continua exportado, testável e **NON_OFFICIAL**, `sqlSourceAdmissionAllowed=false`, nunca pode receber permissão SQL de gravar `SOURCE_ADMITTED`.
- Ainda **não existe** migração 049+, captura governamental real do documento com XML original, serviço Railway novo, deploy, merge, rescan, DOU histórico ou CURRENT. `048` permanece intocada. Nunca fabricar provas positivas em CI para desbloquear R7/TAX11.
- Não confundir decisão **de desenho** com implementação, comprovação real, aceite jurídico, ou prontidão de produção.

## Matriz de 18 testes exigida antes da liberação do caminho SQL

1. DTO manual e objeto `sourceCapture` não admitem SQL — design; unit sintético não equivale a gate PostgreSQL.
2. Seção de PDF divergente rejeitada — unit PASS; origem oficial não verificada.
3. Edições 80/80-A/80-B diferenciadas — design exige índice governamental.
4. Journal ID incompatível — preflight unit; índice real pendente.
5. INLABS matter/arquivo/partes divergentes — preflight unit e typed FK propostos; PG pendiente.
6. Despacho certo com ato incompleto — unit falha.
7. Cláusula alterada — unit falha.
8. Conteúdo normativo extra no preâmbulo ou antes do ato alvo — unit R3; conferir run.
9. PDF inválido/maior que limite — unit negativo.
10. HTTPS indisponível não é ausência de publicação — unit negativo e contrato.
11. Dois coletores concorrentes — PG16/18 pendente da migration 049+.
12. Retry com histórico imutável — PG16/18 pendente da migration 049+.
13. Role não autorizada não insere provas — PG16/18 pendente.
14. UPDATE/DELETE/TRUNCATE bloqueados — PG16/18 pendente.
15. Tenant A não acessa B — integração pendente.
16. Publicação não concede CURRENT — unit e contrato fail-closed.
17. Revogação de credenciais muda projeção — contrato, PG16/18 pendente.
18. Migração 048 continua rejeitando positivos sintéticos — previamente observado; não alterar.

## Prompt completo do próximo gate

Nome recomendado: **Revisor Independente R9-DESIGN-R3 — Trifaros**.

Você é o revisor adversarial independente de TAX13 R9-DESIGN-R3. Audite o PR #196 do backend Trifaros no SHA congelado informado no checkpoint da Issue #101. Leia o parecer R9-DESIGN-R2 BLOCK https://github.com/fabiojuniort-cyber/tribusca-control/issues/101#issuecomment-6094176735, o contrato único docs/taxonomy/TAX13_R9_DOU_CANONICAL_CONTRACT_R3.md, este handoff, os dois RFCs R2 marcados superseded, migrations/048, os módulos DOU PDF/INLABS, o comparador e os testes. Não herde conclusões do executor. Confronte em especial os quatro P1 R9-R2, autorização de duas sessões HTTP independentes, integridade egrésso/TLS, DDL de nove tabelas e tipos/FKs, consistência de job + role + purpose + hashes em cada uma das seis observações, origem do índice/sufixo, manifesto do ZIP, gateway de admissão e projeção read-only revogável, RLS/FORCE, SQL SECURITY DEFINER, tentativas concorrentes/replay/rotation, delimitação completa do DESPACHO incluindo sibling anterior e normas excedentes. Não dê PASS ao código só por 28 tests sintéticos. Distingua APPROVED/BLOCK estritamente de desenho vs migration 049+ vs produção e preserve 048, sem ICP/PDF digital-signature gate. Não criar Railway, migration, merge, deploy, rescan ou CURRENT. Registre o parecer independente na Issue #101 com SHA, matriz D01–D08, P0/P1/P2, riscos e requisitos para 049+. Informe % de avanço continuamente.
