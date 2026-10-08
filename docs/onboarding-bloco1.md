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
