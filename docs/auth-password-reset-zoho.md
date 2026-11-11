# AUTH-RESET-03 R3 — recuperação de senha segura via Zoho CPaaS (#9)

Status: **PR #311 em desenvolvimento/revisão, sem autorização para merge ou produção**.
O cadastro inicial existente, a política Argon2id e a decisão D-058 não mudam.
A regra de trial permanece: **7 dias sem cartão, iniciados apenas após verificação
do e-mail E primeiro cadastro de empresa**. Recuperar senha não verifica e-mail.

## AS IS → TO BE — explicação para o COORD

**AS IS R2 (bloqueado):** a API parou de aguardar a rede Zoho, mas ainda procurava
a conta dentro do pedido HTTP. Se a linha do usuário fosse bloqueada no banco
por mais de 1,2 segundo, uma conta existente podia demorar mais que uma
inexistente. Se a inserção da outbox falhasse somente para conta existente,
poderia diferenciar HTTP 500 de HTTP 202. Claims antigos podiam aceitar ACK
fora do prazo e uma conta desativada ainda podia receber e-mail.

**TO BE R3:** toda solicitação de e-mail bem formado é gravada de forma
**idêntica**, com destinatário criptografado por AES-256-GCM em uma fila neutra
no PostgreSQL. **Nenhuma consulta a usuários, token ou envio Zoho acontece
durante o HTTP 202.** O worker já existente lê a solicitação cifrada, verifica
a conta, e numa única transação prepara token + intenção de entrega. Se o
e-mail não existir/estiver inativo, descarta apenas a solicitação neutra.
Depois envia o link pelo Zoho separadamente, com controles de concorrência
e número de tentativas. O token fica guardado em SHA-256, com uma cópia
cifrada autenticadamente apenas enquanto precisa ser entregue.

São duas filas internas do **mesmo PostgreSQL** — intenção neutra de pedido
e envio criptografado — não há nova fila externa nem novo serviço Railway.

## Rotas e retorno público

### POST /auth/password/forgot

JSON: `{"email":"pessoa@empresa.com.br"}`.
- HTTP 202 com `{"status":"if_account_exists"}` para e-mail existente, desconhecido,
  inativo, e-mail cuja cota própria de 5/15min esteja excedida.
- HTTP 429 + Retry-After somente para cota do IP (60/15min).
- HTTP 400 para payload malformado, 503 quando desligado/sem worker pronto,
  e 5xx uniforme em indisponibilidade da fila neutra — **nunca consultar
  existência do usuário no erro**.
- O piso temporal de 1,2s fica ativo fora de `NODE_ENV=test` como defesa adicional,
  mas a segurança NÃO depende do piso: o trabalho HTTP é uniforme.
- O frontend jamais afirma que determinada conta existe, foi identificada ou recebeu e-mail.
- Depois do commit do pedido neutro, processo/redeploy não o apaga.

### POST /auth/password/reset

JSON: `{"token":"<fragmento>","password":"Senha-Nova!123","confirmPassword":"Senha-Nova!123"}`.
- 204 senha alterada, 400 token inválido/expirado/usado e 429 quota por IP.
- Token aleatório 256 bits, validade de 30 minutos após preparação no worker,
  único uso, emissão/substituição transacional, hash Argon2id e revogação de
  **todas** sessões/refresh. JWT antigo falha na checagem do SID.
- Um novo pedido neutro também invalida imediatamente um token anterior via
  consulta na confirmação do reset; o HTTP não consulta contas para isso.

## Implementação de criptografia, privilégio e concorrência

- `AUTH_PASSWORD_RESET_TOKEN_KEY`: **segredo AES-256 (64 hex), mesmo valor
  somente nos runtimes Backend API e Worker**. Não enviar pelo chat, web,
  logs, PR ou variáveis públicas. AES-GCM, nonce aleatório de 96 bits,
  autenticação via tag, AAD vinculada ao UUID da solicitação ou digest do token.
- A fila neutra contém apenas destinatário **cifrado**, HMAC-SHA256 da
  normalização do e-mail, estados e UUID. O texto puro só existe em memória
  temporariamente no worker. HMAC não usa SHA sem chave como identificador de
  correspondência da fila.
- Tabelas de tokens e filas sem SELECT/UPDATE/DELETE diretos para
  `radar_app` ou `radar_worker`. SECURITY DEFINER com
  `pg_catalog,public,pg_temp`, tabelas `public.` qualificadas, EXECUTE
  mínimo por role. Função de emissão direta não é autorizada ao runtime API.
- PostgreSQL mantém os estados `PENDING` / `CLAIMED` e terminais. O worker
  usa `SKIP LOCKED` e lease de 20 segundos. **Claim não conta como envio**;
  `begin_send` eleva o contador imediatamente antes de chamar a API Zoho.
  O ACK só vale para lease vigente, claim correspondente e envio iniciado.
  Após crash antes de `begin_send`, job fica recuperável com o mesmo número
  de tentativas. Envio iniciado pode consumir tentativa se houver crash
  imediatamente antes da rede: janela residual inerente, monitorada, não
  garantia de exatamente uma entrega.
- Falha transitória: retry limitado; falha terminal: invalida somente o token
  associado. Usuário desativado, token usado, substituído ou expirado:
  não enviar, limpar ciphertext, encerrar o trabalho. ACK antigo nunca
  revoga um token novo.
- `ACCEPTED` = submissão **aceita pelo Zoho**, não entrega na caixa postal.
  Falha depois do aceite Zoho e antes do ACK pode produzir e-mail duplicado
  (semântica `at-least-once`), documentado como risco operacional.
- Jobs criptografados são limpos em estados terminais; worker chama
  `auth_password_reset_reap` em cada ciclo. Para cobrir paralisações do
  worker, habilitar `AUTH_PASSWORD_RESET_JANITOR_ENABLED=true` no Backend
  com a migration vigente — o janitor da própria API limpa a cada minuto,
  mesmo com o envio desabilitado. Se **todos** os processos estiverem
  indisponíveis, cleanup espera retomada; exigir alerta operacional do ambiente.

## Prontidão, rotação de segredo e observabilidade

- Worker envia heartbeat no PostgreSQL, com fingerprint derivado da chave
  (nunca a chave) e atualizado a cada iteração. A API só aceita solicitação
  quando há ao menos um heartbeat **compatível nos últimos 30s**; caso
  contrário retorna 503 neutro, não aceita silenciosamente filas sem worker.
- Banco mantém fingerprint de configuração única; worker com chave diferente
  não pode reivindicar nova entrega. Heartbeats expirados são descartados.
- Rotação autorizada **somente com ambas as filas drenadas**. Interromper
  novas solicitações, acompanhar PENDING/CLAIMED até 0, alterar fingerprint
  via função restrita `auth_password_reset_rotate_key`, provisionar nova
  chave API+Worker no secret manager, reiniciar workers, verificar
  heartbeat e somente depois reabilitar solicitações. Nunca sobrescrever a
  chave enquanto houver ciphertext pendente. A rotação não muda hashes de
  senha nem tokens já aceitos (cópia cifrada destruída).
- Logar apenas componentes, estados, contagem pendente/falha e idade máxima.
  Nunca e-mail, token, fragmento, texto de erro Zoho, ciphertext ou segredo.
  Alertar se `failed>0` ou `oldestPendingSeconds>120`.
- Limitação: os testes isolados NÃO verificam alarmes externos de observabilidade,
  envio real, cadeia do Railway ou prova operacional de rotação em produção.

## Variáveis — somente infraestrutura backend

| Nome | API | Worker | Observação |
|---|---|---|---|
| `AUTH_PASSWORD_RESET_ENABLED` | Sim | Sim | `false` por padrão; ativar só após gates COORD |
| `AUTH_PASSWORD_RESET_PUBLIC_URL` | Sim | Sim | URL HTTPS da rota Web `/nova-senha` |
| `AUTH_PASSWORD_RESET_TOKEN_KEY` | Segredo | Mesmo segredo | 64 hex; secret manager Railway, nunca chat |
| `AUTH_PASSWORD_RESET_TRUSTED_PROXY_CIDRS` | Sim | Sim | CIDRs exatos **após prova**; sem configuração = BLOCK |
| `AUTH_PASSWORD_RESET_JANITOR_ENABLED` | Sim | Não | `false` por padrão, exigir `true` antes de ativação |
| `ZOHO_CPAAS_API_KEY` | Não | Segredo | Chave de envio agent `mail_agent_1` |
| `ZOHO_CPAAS_FROM_ADDRESS` | Não | Sim | Remetente verificado em `trifaros.com.br` |
| `DATABASE_URL` | Sim | Sim | Roles existentes distintos; sem acesso direto às filas |
| `DATABASE_ADMIN_URL` | Não | Não | Apenas migrations/testes em banco descartável |

### B-3 — proxy Railway: **NOT_PROVEN**

O inventário somente leitura mostrou API e réplicas do worker, mas **não**
CIDRs/saltos completos da cadeia ingress. Não presumir número de proxies.
`trustProxy:true` indiscriminado é proibido. Fastify confia apenas nos
CIDRs explicitamente configurados e aceitos após comprovação. Até lá
`AUTH_PASSWORD_RESET_ENABLED=false` e rotas retornam 503.

## Zoho CPaaS

Envio do worker: `POST https://cpaas.zoho.com/v1.1/email`,
cabeçalho `Authorization: Zoho-enczapikey <segredo>`, conteúdo HTML
escapado; `track_clicks=false`, `track_opens=false`, timeout 5s e
redirecionamentos recusados. A API exige resposta de aceite
`message=OK` / código `EM_104`. **Host/data center e entrega real
ainda dependem de homologação isolada com o TriFaros.**
Documentação: https://www.zoho.com/cpaas/help/api/email-sending.html

## Contrato para o Web — F-1 / F-2 / F-3

**F-1:** carregar `/nova-senha` nunca consome o token. Só o envio
voluntário do formulário chama `POST /auth/password/reset`.
Scanners de link podem abrir páginas automaticamente.

**F-2:** `/nova-senha` requer `Referrer-Policy: no-referrer`,
CSP restritiva compatível com SPA, sem analytics/pixels/scripts de terceiros
ou telemetria na rota. Ler `location.hash`, guardar token só em memória e
remover imediatamente o fragmento por `history.replaceState` antes de
qualquer telemetria. Nunca ecoar token em logs, URL de erro, analytics,
Sentry ou console.

**F-3:** workflow backend correto `.github/workflows/auth-reset-pg18.yml`
(nome histórico, matriz PG16 e PG18). Integrar Web por PR separado,
com testes de 202 neutro, 429/503, token vencido/usado, política de senha,
204→login e JWT/refresh inválidos.

O Web não altera a regra de trial D-058; reset de senha não verifica e-mail.

## Provas e gates

- `test/password-reset.unit.test.ts`: Zoho `fetch` mock, AEAD,
  HTML escapado, chave incorreta, sem rede nem credenciais reais.
- `test/password-reset.integration.test.ts`: PG descartável, neutral
  ingress, heartbeat, reinício, retry, dois workers, leases,
  revogação e privilégios mínimos.
- `test/password-reset.latency.integration.test.ts`: 0/800/2500/4900ms,
  erro de envio, piso ativo sem esperar Zoho.
- `test/password-reset.r3.adversarial.integration.test.ts`: **row lock real
  no PostgreSQL** e falha injetada no insert neutro, comparando respostas
  de usuário existente e ausente com piso de 1,2s ativo.
- **CI:** `.github/workflows/auth-reset-pg18.yml`, matriz PG16/PG18.
  Resultados devem ser apresentados por SHA, sem considerar testes
  verdes como aprovação independente R3.
- **Não autorizado:** merge, deploy, migration produtiva, envio Zoho real,
  ativação de flag, secrets via chat, Web nesta tarefa, #310 ou coletores.
- **Antes de produção:** nova R3 adversarial, CI integral, B-3 PROVEN,
  worker pronto e janitor ativado, E-1 Zoho real em homologação autorizada,
  Web integrado, aceite COORD e reconciliação #9/#124.

**Frente 2: 28% (14/50), delta +0,0 p.p. Até aceite formal da #9.**
