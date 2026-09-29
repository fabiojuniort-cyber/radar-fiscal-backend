# AUTH-02 — cadastro público real

Issue de governança: `fabiojuniort-cyber/tribusca-control#37`.

## Contrato

`POST /auth/register`

Body:

```json
{
  "name": "Nome completo",
  "email": "pessoa@empresa.com.br",
  "company": "Empresa",
  "cnpj": "12345678000199",
  "password": "<definida pelo usuário>",
  "confirmPassword": "<mesma senha>",
  "acceptedTerms": true
}
```

`cnpj` é opcional e, quando informado, é normalizado para 14 dígitos, validado pelos dígitos verificadores e não pode já estar associado a outro tenant criado pelo autosserviço.

Sucesso: HTTP 201. A resposta contém somente identificadores públicos da conta criada, role `OWNER` e `next: "LOGIN"`. O cadastro **não cria sessão e não retorna JWT/refresh token**. O usuário entra pelo contrato existente `POST /auth/login`.

Erros de aplicação:
- `400 invalid_signup_data`;
- `400 invalid_password`;
- `409 email_already_registered`;
- `409 company_already_registered`;
- `429 too_many_requests`;
- `500 signup_failed`.

## Persistência e segurança

A migration 019 cria duas superfícies:

- `tenant_onboarding_profiles`: guarda nome da empresa, CNPJ opcional e timestamp do aceite de Termos/Política. O perfil é tenant-scoped, com RLS FORCE e apenas SELECT pelo runtime dentro do tenant.
- `public_signup_rate_limits`: contador técnico por hash SHA-256 do e-mail normalizado. O runtime não possui acesso direto à tabela.

A criação usa a função estreita `auth_public_signup_create_account`, `SECURITY DEFINER`, com `search_path` fixado e EXECUTE concedido apenas a `radar_app`. Ela cria, em uma única transação:
1. `app_users`;
2. `tenants`;
3. `user_credentials`;
4. `tenant_memberships` com role `OWNER`;
5. `tenant_onboarding_profiles`.

A função nunca reutiliza usuário existente. A unique index `uq_app_users_email_lower` continua sendo a proteção final contra corrida/duplicidade. A senha é hash Argon2id antes de chegar à função e o hash é validado pela própria função.

O endpoint não registra body, senha, hash ou CNPJ em log. Falhas inesperadas registram apenas classe do erro e código PostgreSQL, quando disponível.

## Antiabuso

O backend aplica limite persistente no PostgreSQL de **5 tentativas por e-mail normalizado a cada 15 minutos**, usando somente hash SHA-256 como chave. Isso funciona entre réplicas.

Antes de exposição pública de alto volume ainda é recomendado adicionar uma camada de borda/IP com origem de IP confiável. AUTH-02 não habilita `trustProxy` de forma ampla sem prova da cadeia de proxy.

## Tenant versus empresa

O modelo preserva a decisão arquitetural de que tenant não é a entidade `companies`. O signup cria o tenant e registra os dados iniciais em `tenant_onboarding_profiles`. Não cria uma `company` artificial porque o schema atual exige `head_office_cnpj NOT NULL`, enquanto AUTH-02 permite cadastro sem CNPJ.

## E-mail e documentos legais

Não existe infraestrutura de confirmação de e-mail nesta fase. Nenhum fluxo fictício foi criado; confirmação de e-mail permanece evolução futura.

O código registra o aceite com `consent_version = 2026-09-29-v1`. **Antes do deploy público definitivo**, Termos de Uso e Política de Privacidade devem existir em URLs/documentos publicáveis e a versão de consentimento deve ser substituída por uma versão jurídica real. Isso é gate de exposição, não motivo para inventar documentos nesta implementação.

## Não escopo

- recuperação/reset de senha;
- confirmação de e-mail;
- billing/trial;
- criação automática de `companies`/establishments;
- alteração de login/refresh/logout;
- merge ou deploy produtivo.
