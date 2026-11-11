# AUTH-RESET-02 — Recuperar senha / Nova senha (#9): outbox durável

Status: PR isolado; **nao ativar em producao sem CI integral + revisao independente R3 + aceite do COORD/Fabio**. Cadastro inicial ONB-01 nao muda. Trial/validacao de e-mail ficam fora do escopo.

## Protocolo de envio oficial (Zoho CPaaS)

Documentacao oficial: https://www.zoho.com/cpaas/help/api/email-sending.html e https://www.zoho.com/cpaas/help/api/api-authentication.html.

- Operacao: POST https://cpaas.zoho.com/v1.1/email.
- Cabecalho: Authorization: Zoho-enczapikey <segredo do mail agent>.
- Corpo: from { address, name }, to [{ email_address: { address } }], subject, textbody/htmlbody.
- Resposta aceita como submissao: HTTP 200, message OK e codigo EM_104 no array data. Isso **nao equivale a entrega na caixa de entrada**.
- Rastreamento de abertura/clique desativado, pois redirecionadores podem vazar o token.
- A chave pertence ao Agent mail_agent_1 associado ao dominio trifaros.com.br; o identificador do agente nao e campo do POST /email.
- Nenhuma chave em commit, chat, logs ou variaveis de build do frontend.

## Variaveis de ambiente — somente backend API

| Variavel | Papel | Configurar em producao? |
| --- | --- | --- |
| AUTH_PASSWORD_RESET_ENABLED | Chave de ativação, **false por padrão** | API e worker, apenas após R3 + B-3 PROVEN |
| AUTH_PASSWORD_RESET_PUBLIC_URL | URL HTTPS da rota Web, ex.: https://trifaros.com.br/nova-senha | API e worker, depois do Web |
| ZOHO_CPAAS_API_KEY | **Segredo** de envio do agent mail_agent_1 | Somente serviço worker; secret Railway, nunca compartilhar via chat |
| ZOHO_CPAAS_FROM_ADDRESS | Remetente autorizado pelo Zoho | Worker; conferir com Zoho, não inferir valor |
| AUTH_PASSWORD_RESET_TOKEN_KEY | Chave AES-256-GCM em hex (64 caracteres), criada no secret manager, nunca no chat | API e worker; usar o MESMO segredo por ambiente |
| AUTH_PASSWORD_RESET_TRUSTED_PROXY_CIDRS | CIDRs exatos de proxies verificados | Vazio/NOT_PROVEN até aprovação formal B-3; API fica bloqueada |
| DATABASE_URL | Runtime PostgreSQL existente da API; migration 083 previamente aprovada/aplicada | Ja existente |
| DATABASE_ADMIN_URL | Aplicar migrations e executar testes em banco descartavel | **Nao passar a API operacional por chat** |

A API utiliza ambiente/endpoint oficial da regiao documentada (cpaas.zoho.com). Antes de habilitar, confirmar se a conta Zoho usa esse mesmo data center; caso nao, parametrizar e validar o dominio permitido em alteracao especifica, sem abrir URL arbitraria para SSRF.

## Arquitetura AS IS → TO BE

**AS IS (bloqueado):** a API aguardava resposta da rede Zoho dentro do HTTP
`/forgot`. Acima de 1,2s de latência, a resposta do e-mail existente era
mais lenta que a de inexistente (vazamento P1); uma falha deixava token válido
sem entrega. A cota por endereço retornava 429 para um terceiro. Não existia
fila durável.

**TO BE (PR #311):** ao solicitar recuperação, a API gera token aleatório,
guarda seu hash e uma cópia **cifrada com AES-256-GCM** na outbox do próprio
PostgreSQL, na MESMA transação. Retorna 202 depois do COMMIT, sem chamar a
rede. Um laço de envio **no worker Railway já existente** (duas réplicas)
busca jobs persistidos com `SKIP LOCKED`, confere validade do token, decifra
em memória e chama Zoho. Estado de envio: PENDING/CLAIMED/ACCEPTED/RETRY
(internamente PENDING com prazo)/FAILED/EXPIRED/CANCELLED. ACCEPTED significa
**submissão aceita pela API do Zoho, não entrega na caixa de entrada**.
No aceite ou falha terminal, a cópia cifrada do token é destruída.
Falha transitória tenta novamente (até 3 vezes), sem perder pendências
após reinício do processo. O processamento não cria serviço externo adicional
nem altera conectores fiscais.

**Limite técnico residual:** se o processo cair DEPOIS de o Zoho receber
um e-mail, mas ANTES de persistir o ACK, uma tentativa posterior pode gerar
segunda entrega do mesmo link. A outbox garante ao menos uma tentativa
com retries limitados, não exatamente uma entrega na rede. O link permanece
de uso único. Há uma pequena janela entre a checagem de validade e
a aceitação pela rede em que uma solicitação concorrente pode substituí-lo;
o conteúdo do link antigo não passa a ser utilizável. Não declarar eliminação
matemática desses riscos sem suporte a idempotência externa.

### Confiabilidade, proteção e configuração

- Token em claro nunca em tabela/log; AES-256-GCM, nonce de 96 bits, tag de 128 bits, AAD SHA-256 do token; chave `AUTH_PASSWORD_RESET_TOKEN_KEY` (64 hex) em SEGREDO do runtime API e Worker.
- Na falha definitiva, invalidar SOMENTE o hash correspondente ao job; falha antiga não invalida nova solicitação.
- Correlacionar filas somente por UUID e código/estado sanitizado, nunca token/link/e-mail em logs ou métricas.
- A API e o worker têm credenciais de DB com privilégios distintos; o worker só recebe EXECUTE em funções específicas e jamais SELECT direto nos tokens.
- A outbox é durável antes do 202, portanto queda/redeploy não perde trabalhos; jobs com token expirado não são enviados.
- `AUTH_PASSWORD_RESET_ENABLED=false` por padrão em API e Worker; qualquer configuração incompleta impede envio.

### B-3 — proxy/IP Railway: NOT_PROVEN e gate de ativação

Inspeção **somente leitura** do Railway: projeto "efficient-imagination", ambiente
production; o backend tem uma réplica e domínio `radar-fiscal-backend-production.up.railway.app`;
o worker existente tem duas réplicas. A conexão entre cliente, edge Railway
e Fastify não apresenta nessa consulta a cadeia completa, números de saltos
nem faixas de IP confiáveis. Por isso, B-3 permanece **NOT_PROVEN**.

Enquanto não existir evidência e revisão dos endereços exatos:
`AUTH_PASSWORD_RESET_TRUSTED_PROXY_CIDRS` fica vazio;
Fastify não confia em `X-Forwarded-For` arbitrário; e em produção
`AUTH_PASSWORD_RESET_ENABLED=true` sem CIDRs aprovados **não habilita**
as rotas, que respondem 503. **NÃO configurar `trustProxy: true` genérico**.
O worker também exige configuração de confiança declarada para iniciar.

## Contratos novos — propostos para aceite

### POST /auth/password/forgot

Body: { "email": "usuario@empresa.com.br" }.

- 202 { "status": "if_account_exists" } tanto para e-mail existente quanto desconhecido/inativo; sem indicacao de envio ou validacao de conta.
- 400 invalid_request se payload invalido.
- 429 too_many_requests + Retry-After SOMENTE ao exceder cota por IP; cota de e-mail retorna 202 neutro, sem emissão nem e-mail.
- 503 password_reset_unavailable quando nao habilitado/configurado.
- Sem autenticacao, sem cookie, sem fake JWT.

O backend gera 32 bytes aleatorios, token opaco base64url, guarda somente SHA-256, validade 30 minutos. Uma nova solicitacao invalida tokens anteriores daquele usuario. O link de uso unico e enviado em fragmento **#token=...** a URL fixa; o fragmento nao acompanha requisicoes HTTP ao host da pagina, evitando o token em logs do reverse proxy e Referer.

Antiabuso: persistente PostgreSQL usando a funcao de rate limit existente com hashes isolados por prefixo:
- 5 solicitacoes a cada 15 minutos por e-mail normalizado;
- 60 solicitacoes a cada 15 minutos por IP;
- tabela guarda somente hash, nunca e-mail nem IP em texto claro.

**Anti-enumeração B-1:** o Zoho só é chamado pelo worker APÓS o 202. O piso de 1,2 s no HTTP fica como defesa adicional contra diferenças internas do banco e é verificado nos testes de temporização com a proteção habilitada. Confirmar resultados antes de declarar CORRIGIDO.

### POST /auth/password/reset

Body: { "token": "<token do link>", "password": "<senha forte>", "confirmPassword": "<igual>" }.

- 204 sem corpo se trocou senha.
- 400 invalid_password_reset_data para body/senha/confirmacao invalidos.
- 400 invalid_or_expired_reset_token para token desconhecido, invalido, expirado ou ja utilizado.
- 429 too_many_requests + Retry-After; 503 quando desabilitado.
- Senha com o mesmo criterio do cadastro ONB-01: minimo 8, maiuscula, minuscula, numero e especial.
- Token validado e consumido atomicamente com atualizacao Argon2id e reset do lock de login.
- Todos os tokens de reset anteriores, **todas** as sessoes do usuario e **todos** os refresh tokens associados sao revogados na mesma transacao PostgreSQL. Como a autenticacao revalida o sid, JWT antigos tambem deixam de funcionar. O usuario deve autenticar-se novamente pelo POST /auth/login.
- Ate 60 tentativas de confirmacao por IP/15 minutos; token aleatorio com 256 bits.

Migration proposta: migrations/083_auth_password_reset.sql, aditiva, sem reescrita de usuarios legados. Funcoes SECURITY DEFINER com search_path fixo e EXECUTE apenas para radar_app, sem permissao direta do runtime na tabela de tokens. Validar a migration em PostgreSQL 18 isolado; **nao aplicar ao banco produtivo sem gate R3**.

## Validacao simulada e ambiente isolado

1. Teste de transporte sem HTTP real: test/password-reset.unit.test.ts injeta fetch fake, verifica URL, header Authorization, payload, remetente/destinatario e ausencia de tracking. Nao requer segredo Zoho.
2. Contrato completo com PostgreSQL **descartavel radar_fiscal_test**: test/password-reset.integration.test.ts injeta um emissor de e-mails em memoria e recupera o token do link capturado; valida solicitacao, resposta neutra para usuario desconhecido, chegada simulada, segunda solicitacao, expiracao por alteracao de dados sintéticos, nova senha, uso unico, concurrencia, bloqueio por limite, invalidez de JWT antigo, rejeicao do refresh antigo e login com senha nova.
3. CI: testes incluídos em npm test/integration; workflow dedicado `.github/workflows/auth-reset-pg18.yml`, matriz PostgreSQL 16 e 18, com testes de latência (piso temporal ativo), outbox, falha e concorrência. O CI geral continua condicionado a #310. **Nao sao testes de envio para caixa de e-mail real** e nao usam contas/segredos produtivos.
4. Validacao Zoho real futura, apos conexao segura via secrets e autorizacao: ambiente de homologacao isolado, destinatario de teste consentido, conferir recebimento/link, abrir app homologado, redefinir senha sintética, comprovar revogacao e auditar se mail/links nao vazam em logs. Nenhum envio automatico autorizado por este PR.

## Handoff preciso ao radar-fiscal-web

Implementar em PR Web **separado**, depois de aprovado o contrato:
1. Na tela Entrar, oferecer link acessivel "Esqueci minha senha" para abrir formulario de e-mail.
2. Ao confirmar, POST /auth/password/forgot, sem credentials/cookies; 202 deve sempre mostrar "Se houver uma conta vinculada a este e-mail, enviaremos instrucoes". Tratar 429 (espera) e 503 (indisponivel). Nunca mostrar se conta existe.
3. **F-1**: carregar `/nova-senha` **NUNCA valida, consome ou envia automaticamente o token**. Somente o envio voluntário do formulário chama `POST /auth/password/reset`. Scanners de links podem carregar/executar JS.
4. **F-2**: página `/nova-senha` deve enviar `Referrer-Policy: no-referrer`, CSP estrita compatível com a SPA, **sem analytics/scripts de terceiros**, pixels, telemetria ou error tracker de terceiros. Remover fragmento `#token` imediatamente antes de qualquer telemetria. Sanitizar explicitamente (ex. Sentry `beforeSend`) URL e erros, nunca transmitir token via analytics, histórico, console ou log. 
5. **F-3**: gate de autenticação é `.github/workflows/auth-reset-pg18.yml`, não o job histórico `onb01-pg18`.
6. Criar rota publica de SPA **/nova-senha** (nao existe no Web atual). Ler **somente** location.hash "#token=...", extrair token, apaga-lo do historico com history.replaceState imediatamente e nao envia-lo a analiticos/Sentry/logs.
7. Validar senha e confirmacao em tempo real como no cadastro; POST /auth/password/reset {token,password,confirmPassword}, com 'Content-Type: application/json', sem cookies; sucesso HTTP 204 retorna a "Entrar", descartando estado de sessao anterior. Erro de token invalido/expirado/ja usado pede nova solicitacao; nunca ecoar token no erro.
8. Testes Web mockados: fluxo de 202 existente/desconhecido, rate limit, falta de conexao, link expirado/usado, senha fraca/confirmacao, 204 com limpeza de URL e navegacao ao login; Playwright desktop/mobile. Same-origin proxy /auth deve rotear para backend.
9. Nao modificar a regra D-058: trial de 7 dias sem cartao inicia somente apos verificacao do e-mail e primeira empresa cadastrada; reset de senha nao confirma e-mail nem inicia trial.

## Gates pendentes

- Revisao independente R2/R3: SQL SECURITY DEFINER/privilegios, concorrencia, expiracao, anti-enumeracao (incluindo tempo), origem e-mail/entrega real, session fixation, token em fragmento, observabilidade sem segredos, seguranca de deploy/migration.
- Confirmar CI integral no SHA final. Revisar possivel drift de main antes do merge.
- Validar API Zoho em ambiente isolado com segredo em Railway; nenhuma chave no chat/PR. Confirmar SPF/DKIM/remetente, quotas e dominio.
- Aceite da #9 somente depois de fluxo Web+Backend integrado comprovado; baseline Frente 2 permanece 28% (14/50) ate decisao do COORD.
