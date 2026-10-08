# ONB-01 — Bloco 1: cadastro simplificado e empresa assistida

Governança: [tribusca-control#96](https://github.com/fabiojuniort-cyber/tribusca-control/issues/96).
PRs coordenados: backend #190, frontend radar-fiscal-web#83. **Não mergear ou publicar sem CI e revisão independente de risco R3**.

## Contratos de cadastro
- `POST /auth/register`: `name`, `email`, `password`, `confirmPassword`, `acceptedTerms=true`. Os campos legados `company` e `cnpj` permanecem aceitos de forma opcional por compatibilidade; não aparecem no novo cadastro.
- `migrations/042_signup_without_company.sql`: permite `tenant_onboarding_profiles.company_name IS NULL` e mantém datas/versão de consentimento, membership OWNER, Argon2id e transação única. `tenants.name` usa rótulo provisório `Conta de <nome do usuário>`; isso não representa uma empresa registrada.
- `GET /api/v1/account` pode retornar `onboarding.companyName = null` e `companies = []` para contas novas. Nunca reescrever registros legados sem empresa.
- `POST /api/v1/companies/from-cnpj` e `POST /api/v1/companies/:companyId/establishments/from-cnpj`: continuam como fontes autoritativas do cadastro automático, importando dados, endereço, CNAEs e IE quando disponíveis.
- Se o provedor falhar ou CNPJ válido não for encontrado, o frontend usa os endpoints manuais existentes, mantendo autenticação, autorização de tenant e validações por CNPJ. O registro manual só é gravado ao concluir seleção de CNAEs.
- `GET /api/v1/cnae-catalog?search=<termo>`: endpoint autenticado e tenant-scoped; consulta **apenas edição CURRENT** do catálogo CNAE oficial previamente importado do IBGE/CONCLA (`official_catalog_entries` com `level=SUBCLASSE` e `assignable=true`), até 40 resultados por consulta. Responde 503 `cnae_catalog_unavailable` se nenhuma edição corrente existir. Não inventar lista fallback.
- CNAEs selecionados são gravados pelos serviços manuais já transacionais: primeiro selecionado é principal; usuário pode trocar o principal. Matriz e filial compartilham os componentes de escolha.

## Gates/isolamento
- Preservar `withTenantContext`, membership OWNER/ADMIN para escritas, RLS e constraints de unicidade (empresa por tenant, estabelecimento por empresa), dados já existentes e vínculos fiscais.
- Executar CI do backend (incluindo PostgreSQL 18, auth/RLS) e frontend (unitários, typecheck, build, Playwright), além de revisão adversarial independente.
- Não gerar dados produtivos de smoke, deploy/merge, alteração do TAX-12/TAX-13, loading, wizard NCM/Produto ou exclusão definitiva nesta frente.
- Próximo bloco de UX implementará animação e wizard; o ponto de integração atual é o Perfil Tributário existente.

## Cenários de regressão
1. Cadastro sem empresa/CNPJ + login/logout + consentimento, criptografia, rate limit e duplicidade e-mail.
2. Cadastro legado com empresa/CNPJ ainda aceito; contas antigas intactas.
3. CNPJ com dígitos inválidos deve falhar antes da consulta e no servidor.
4. Consulta automática de matriz/filial funciona sem sobrescrever vínculos anteriores.
5. Falha de provedor abre fluxo manual; edição CURRENT oficial fornece CNAEs, um principal.
6. Catálogo ausente deve informar falha (não simular lista); validação de tenant/RLS com usuário alheio.
7. PRs são acoplados: disponibilizar backend (incluindo migration 042 + catálogo) antes de ativar novo frontend, somente após gates.

## Correções exigidas pela revisão independente — B1–B6

**Status: BLOCK até novo parecer R3, independentemente da conclusão do CI.**

- **B1 — referência CNAE:** todo CNAE enviado em operação manual passa por validação server-side contra a edição `CNAE` CURRENT do catálogo oficial, `level=SUBCLASSE` e `assignable=true`, na mesma transação que grava empresa/estabelecimento. Código fictício, repetido ou com quantidade de principais incorreta é rejeitado; descrição enviada pelo navegador é ignorada. A tabela global `cnaes` recebe apenas inserções ausentes usando descrição oficial (`ON CONFLICT DO NOTHING`), nunca `UPDATE` a partir do formulário. Novas matrizes e filiais manuais exigem ao menos um CNAE. A edição legítima das rotas antigas pode limpar associações fornecendo `[]`, sem aceitar códigos arbitrários.
- **B2 — vínculo empresarial:** validação de raiz (8 dígitos) em serviço e trigger de banco da migration 043. Entrada de nova empresa requer CNPJ matriz (sufixo /0001 na ausência de evidência explícita do provedor). Uma filial não pode ser ligada a outra raiz nem se registrar como nova matriz. Trigger é aditivo: não reescreve automaticamente cadastros legados.
- **B3 — duplicidade/reativação:** inclusão sobre empresa/filial ativa responde conflito, sem atualizar nome, IE, localização, perfil ou CNAEs. Inativa responde `reactivation_required` até `reactivateInactive: true` explicitamente confirmado pelo usuário; a reativação preserva atributos e vínculos existentes, ajustando apenas `is_active`.
- **B4 — PG18:** job dedicado `onb01-pg18` aplica migrations completas (042 + 043) em PostgreSQL 18 descartável, verifica esquema e trigger e executa teste de signup/consentimento/autenticação/RLS, mais teste adversarial de CNAE, tenants, filiais, duplicidade e reativação. Nenhuma execução corresponde ao banco de produção.
- **B5 — integração:** `test/onboarding-integrity.integration.test.ts` e fixture sintética `test/onboarding-cnae-fixture.ts` exercitam tentativas hostis; `test/onboarding-identity.unit.test.ts` verifica guardas. A tela exige confirmação separada para reativação. As suites históricas de empresa/filial foram ajustadas para mesma raiz e reativação explícita.
- **B6 — fechamento:** verificar integralmente GitHub Actions dos SHAs finais de ambos PRs, testes E2E de browser, revalidar diffs independentes e não mergear sem novo PASS formal.
