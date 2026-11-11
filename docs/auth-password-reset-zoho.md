# AUTH-RESET-04 R4 — recuperação de senha segura via Zoho CPaaS (#9)

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

## AUTH-RESET-04 — hardening R4 delimitado

### W4-R3a — Health separado por estágio, sem nova infraestrutura

**AS IS R3:** \`auth_password_reset_queue_health()\` retornava apenas a outbox
de envio; a fila neutra \`auth_password_reset_requests\` podia ter \`PENDING\`
antigos ou \`FAILED\` sem aparecer no health/alarme, ainda que o HTTP
continuasse devolvendo 202. A reprodução anterior à mudança foi feita em
PG16 e PG18 descartáveis: **3 PENDING + 1 FAILED + idade 600s** na fila neutra
e **0/0/0** expostos pelo health R3.

**TO BE R4:** a MESMA função PostgreSQL mantém sua assinatura de quatro
colunas e os EXECUTE grants anteriores, mas retorna **exatamente duas linhas**
ordenadas explicitamente por \`stage_order\`: primeira = \`delivery\`
(\`auth_password_reset_outbox\`, contrato legado), segunda = \`neutral\`
(\`auth_password_reset_requests\`). A aplicação exige as duas linhas,
falhando explicitamente se o contrato estiver incompleto. Cada estágio
expõe \`pending\`, \`claimed\`, \`failed\` e
\`oldestPendingSeconds\` (zero quando não há pendentes). Estados da fila
neutra existentes: \`PENDING\`, \`CLAIMED\`, \`PREPARED\`, \`UNKNOWN\`,
\`SUPERSEDED\`, \`EXPIRED\`, \`FAILED\`; outros são terminais e não são
inventados como estados de produto. Estados da outbox existentes:
\`PENDING\`, \`CLAIMED\`, \`ACCEPTED\`, \`FAILED\`, \`EXPIRED\`,
\`CANCELLED\`.

O worker registra em log estruturado **somente agregados por estágio**
e motivos enumerados, nunca destinatário, HMAC, token, link ou ciphertext.
O alarme **local** abrange falha (\`failed>0\`), fila pendente envelhecida
(\`oldestPendingSeconds>120\`), ou \`claimed>0\` por duas amostras
consecutivas do mesmo estágio (amostragem ~30s contra lease ~20s).
Esta última é **heurística de possível preparação travada**, não prova
de falha nem monitoramento externo. Se todas as instâncias pararem, o
alarme local também para: monitor externo de heartbeat/backlog é
dependência operacional futura, não foi criado nesta R4.

### R3-500 — Resposta pública uniforme e sanitizada

O \`POST /auth/password/forgot\` responde **HTTP 500** e o JSON fixo
\`{"error":"password_reset_unavailable"}\` para falhas inesperadas do
ingresso neutro. A mesma estrutura, \`Cache-Control: no-store\` e
\`Referrer-Policy: no-referrer\` valem para conta conhecida ou
desconhecida; SQLSTATE, mensagens do PostgreSQL, nomes de tabelas e
destinatários **não** são refletidos. Somente um evento interno estático
\`neutral_intake_failed\` é registrado, sem serializar a exceção.
O 503 de feature desligada/worker indisponível, 202 neutro, 429 por IP
e demais rotas mantêm seus contratos anteriores.

### RET-P3 — Política candidata, NÃO aprovada e sem execução produtiva

A migration **085** inclui \`auth_password_reset_purge_terminal(days,dry_run)\`,
**administrativa**, com \`dry_run=TRUE\` por padrão, sem EXECUTE para
\`radar_app\` nem \`radar_worker\`, e **sem cron, trigger ou integração
ao reaper/janitor**. A remoção efetiva (se \`dry_run=FALSE\`) é limitada
a lotes de 5.000, \`FOR UPDATE SKIP LOCKED\`, e só considera os estados
terminais **\`PREPARED\`, \`UNKNOWN\`, \`SUPERSEDED\`, \`EXPIRED\`, \`FAILED\`**
cujo \`updated_at\` seja anterior ao prazo fornecido. Jamais remove
\`PENDING\`/\`CLAIMED\`, linhas com payload cifrado ou com token de
senha ainda válido ligado ao mesmo HMAC.

**30 dias foi usado exclusivamente como hipótese nos testes**, com
comparação de terminais antigos/recentes, pendências ativas e
referência a token válido. **Não é prazo de retenção aprovado**.
Antes de qualquer execução operacional, COORD + jurídico/LGPD
devem ratificar prazo, necessidade de trilha de auditoria,
responsável, observabilidade, limite de lote e estratégia de rollback.
O janitor/reaper atual só expira/cancela payload e não invoca essa
purga. Dados históricos reais não foram manipulados.

### CRY-P3 — endurecimento compatível, HKDF separado por gate

**Implementado sem mudança de formato ou chave raiz:** AES-256-GCM
passa \`authTagLength:16\` explicitamente e exige **tag canônica de
exatamente 16 bytes** ao decifrar destinatário e token. As gravações
R3 sempre geravam tag de 16 bytes, portanto os ciphertexts
sintéticos **pré-R4** continuam descriptografáveis. A versão nova
continua legível por consumidor legado R3. HMAC-SHA256 do
destinatário permanece **byte a byte compatível**; fingerprint
da chave e função de hash permanecem iguais.

**HKDF de subchaves foi avaliado, mas NÃO ativado.** Trocar a chave
AES e/ou HMAC hoje quebraria a decriptação de payload em
\`PENDING/CLAIMED\` e alteraria \`email_digest\`, com implicações para
supersessão e checagem de token. O teste sintético deriva subchave
HKDF e demonstra que o HMAC resultante difere do legado.
Adoção exige decisão do COORD e gate separado: versionar envelopes
(\`crypto_version\`), implementar leitura dupla de versões e
lookup compatível para HMAC enquanto há linhas antigas, coordenar
troca de fingerprint e só depois migrar quando a fila estiver drenada.
**Nenhum backfill, mudança de segredo ou migração criptográfica
produtiva nesta R4.**

### Riscos P3 registrados, fora do escopo de regra de negócio

- **SUP:** dentro da cota, pedido de terceiro pode invalidar link
  anterior; não é tomada de conta. Requer decisão futura UX/negócio.
- **W3-ST:** desativação após \`begin_send\` pode resultar em
  \`CANCELLED\` mesmo se o provedor já tiver recebido o e-mail.
  Sem introduzir novo estado nesta R4.
- **KEY:** primeiro heartbeat pode fixar fingerprint incompatível,
  causando indisponibilidade fail-closed. Exigir procedimento operacional
  de ativação/rotação, não alterar chave real aqui.

### Provas R4 e gates

- \`test/password-reset.r4.before.integration.test.ts\`: prova
  pré-correção (executada e retida como evidência histórica, NÃO rodar
  contra o health corrigido).
- \`test/password-reset.r4.health-retention.integration.test.ts\`: duas
  filas separadas, PENDING/CLAIMED/FAILED, alarme local, worker
  pausado/reconectado, reaper, preparação de pedido e expurgo
  candidato apenas no banco descartável PG16/18.
- \`test/password-reset.r3.adversarial.integration.test.ts\` agora
  verifica uniformidade de corpo, status, headers e ausência de SQLSTATE
  em falha de banco injetada.
- \`test/password-reset.unit.test.ts\` inclui compatibilidade de AES-GCM
  legado/nova versão, HMAC do R3 e contraprova HKDF não compatível.
- Matriz do CI de reset continua PG16+PG18 descartáveis e regressões
  de autenticação/RLS/cadastro. **CI isolado PASS não implica aceite
  técnico integral**, nem supera CI geral #310.
- B-3 proxy Railway **NOT_PROVEN**, Zoho real e Web/e2e **NOT_PROVEN**,
  feature \`AUTH_PASSWORD_RESET_ENABLED=false\`; sem autorização de
  merge, deploy, migração produtiva ou uso de segredos.

