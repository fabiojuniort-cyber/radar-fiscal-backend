# AUTH-RESET-01 — Recuperar senha / Nova senha (#9)

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
| AUTH_PASSWORD_RESET_ENABLED | Chave de ativacao; 'false' por padrao; rota devolve 503 enquanto inativa | 'true' apenas apos autorizacao R3 |
| AUTH_PASSWORD_RESET_PUBLIC_URL | URL HTTPS da tela web proposta, ex.: https://trifaros.com.br/nova-senha | Sim antes da ativacao |
| ZOHO_CPAAAS_API_KEY | **Segredo** de envio do agent mail_agent_1 (na aba SMTP/API) | Sim; Railway secret de runtime, nunca compartilhar pelo chat |
| ZOHO_CPAAAS_FROM_ADDRESS | Endereco remetente realmente aprovado/associado ao dominio verificado | Sim; confirmar endereco exato no Zoho |
| DATABASE_URL | Runtime PostgreSQL existente da API; migration 083 previamente aprovada/aplicada | Ja existente |
| DATABASE_ADMIN_URL | Aplicar migrations e executar testes em banco descartavel | **Nao passar a API operacional por chat** |

A API utiliza ambiente/endpoint oficial da regiao documentada (cpaas.zoho.com). Antes de habilitar, confirmar se a conta Zoho usa esse mesmo data center; caso nao, parametrizar e validar o dominio permitido em alteracao especifica, sem abrir URL arbitraria para SSRF.

## Contratos novos — propostos para aceite

### POST /auth/password/forgot

Body: { "email": "usuario@empresa.com.br" }.

- 202 { "status": "if_account_exists" } tanto para e-mail existente quanto desconhecido/inativo; sem indicacao de envio ou validacao de conta.
- 400 invalid_request se payload invalido.
- 429 too_many_requests + Retry-After, independentemente de existencia da conta.
- 503 password_reset_unavailable quando nao habilitado/configurado.
- Sem autenticacao, sem cookie, sem fake JWT.

O backend gera 32 bytes aleatorios, token opaco base64url, guarda somente SHA-256, validade 30 minutos. Uma nova solicitacao invalida tokens anteriores daquele usuario. O link de uso unico e enviado em fragmento **#token=...** a URL fixa; o fragmento nao acompanha requisicoes HTTP ao host da pagina, evitando o token em logs do reverse proxy e Referer.

Antiabuso: persistente PostgreSQL usando a funcao de rate limit existente com hashes isolados por prefixo:
- 5 solicitacoes a cada 15 minutos por e-mail normalizado;
- 60 solicitacoes a cada 15 minutos por IP;
- tabela guarda somente hash, nunca e-mail nem IP em texto claro.

**Risco residual:** diferencas de duracao do envio Zoho podem gerar canal lateral de tempo. Ha piso temporal de 1,2 s fora dos testes, mas isso nao fornece garantia perfeita de anti-enumeracao. Recomendacao de evolucao futura: outbox transacional + worker; nao afirmar seguranca perfeita antes de revisao adversarial. Se API operar sob proxy reverso com IP compartilhado, conferir cadeia de proxy confiavel antes do gate.

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
3. CI: testes adicionados a npm test e npm run test:integration; PG18 no job onb01-pg18. **Nao sao testes de envio para caixa de e-mail real** e nao usam contas/segredos produtivos.
4. Validacao Zoho real futura, apos conexao segura via secrets e autorizacao: ambiente de homologacao isolado, destinatario de teste consentido, conferir recebimento/link, abrir app homologado, redefinir senha sintética, comprovar revogacao e auditar se mail/links nao vazam em logs. Nenhum envio automatico autorizado por este PR.

## Handoff preciso ao radar-fiscal-web

Implementar em PR Web **separado**, depois de aprovado o contrato:
1. Na tela Entrar, oferecer link acessivel "Esqueci minha senha" para abrir formulario de e-mail.
2. Ao confirmar, POST /auth/password/forgot, sem credentials/cookies; 202 deve sempre mostrar "Se houver uma conta vinculada a este e-mail, enviaremos instrucoes". Tratar 429 (espera) e 503 (indisponivel). Nunca mostrar se conta existe.
3. Criar rota publica de SPA **/nova-senha** (nao existe no Web atual). Ler **somente** location.hash "#token=...", extrair token, apaga-lo do historico com history.replaceState imediatamente e nao envia-lo a analiticos/Sentry/logs.
4. Validar senha e confirmacao em tempo real como no cadastro; POST /auth/password/reset {token,password,confirmPassword}, com 'Content-Type: application/json', sem cookies; sucesso HTTP 204 retorna a "Entrar", descartando estado de sessao anterior. Erro de token invalido/expirado/ja usado pede nova solicitacao; nunca ecoar token no erro.
5. Testes Web mockados: fluxo de 202 existente/desconhecido, rate limit, falta de conexao, link expirado/usado, senha fraca/confirmacao, 204 com limpeza de URL e navegacao ao login; Playwright desktop/mobile. Same-origin proxy /auth deve rotear para backend.
6. Nao modificar a regra D-058: trial de 7 dias sem cartao inicia somente apos verificacao do e-mail e primeira empresa cadastrada; reset de senha nao confirma e-mail nem inicia trial.

## Gates pendentes

- Revisao independente R2/R3: SQL SECURITY DEFINER/privilegios, concorrencia, expiracao, anti-enumeracao (incluindo tempo), origem e-mail/entrega real, session fixation, token em fragmento, observabilidade sem segredos, seguranca de deploy/migration.
- Confirmar CI integral no SHA final. Revisar possivel drift de main antes do merge.
- Validar API Zoho em ambiente isolado com segredo em Railway; nenhuma chave no chat/PR. Confirmar SPF/DKIM/remetente, quotas e dominio.
- Aceite da #9 somente depois de fluxo Web+Backend integrado comprovado; baseline Frente 2 permanece 28% (14/50) ate decisao do COORD.
