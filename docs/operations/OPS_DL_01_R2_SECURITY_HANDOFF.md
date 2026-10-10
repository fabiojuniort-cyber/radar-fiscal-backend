# OPS-DL-01 R2 — Handoff do botão Salvar / limites DOU

Status: PREPARADO PARA REVISÃO INDEPENDENTE; NÃO autoriza merge ou produção.
Gates TAX13-R9/049+ continuam BLOCK. Migration 048 não alterada. Sem coleta
histórica, sem PDF obrigatório; texto XML INLABS permanece canônico.

## Fronteira de identidade e risco corrigido

A versão anterior da migration 050 autorizava a operação quando a conexão
partilhada radar_app_runtime declarava app.user_id de um administrador conhecido.
GUC não é prova de JWT. A R2 NÃO executa o write por radar_app_runtime.

Agora:
1. Fastify autentica JWT e valida PLATFORM_ADMIN no preHandler;
2. somente o handler PUT cria um token HMAC-SHA256 v1 com o userId autenticado,
   o timestamp em segundos, um nonce UUID e os quatro limites inteiros na
   ordem (pdf,zip,expandedZip,xmlEntry);
3. a assinatura usa DOU_LIMITS_SIGNING_SECRET (32 bytes em hex) do ambiente da
   API; não reutilizar JWT_ACCESS_SECRET ou senha SQL;
4. o handler executa a função via DATABASE_DOU_LIMITS_URL com login isolado
   radar_dou_limits_runtime, sem role radar_app/worker e sem DML/SELECT brutos;
5. a função SECURITY DEFINER valida session_user exato, idade ±90s, HMAC
   contra segredo armazenado em tabela protegida somente pelo owner, nonce
   inédito, role PLATFORM_ADMIN ativa no banco com lock de revogação antes do
   COMMIT, limites, SOURCE DOU, UPDATE e audit no mesmo commit.

Payload HMAC exato:
OPS-DL-01/v1|{userUuid}|{unixSeconds}|{nonceUuid}|{pdfMiB}|{zipMiB}|
{expandedZipMiB}|{xmlEntryMiB}, SEM quebras de linha. Chave é 32 bytes.
Nonce comprometido não é reutilizável; reenvio com assinatura válida falha
com unique violation (erro 23505). Nenhum segredo/assinatura em audit_log.

**Modelo de confiança:** SQL injection ou vazamento somente da conexão comum
radar_app_runtime não consegue escrever nem fingindo app.user_id. Para
comprometer o write é necessária credencial dedicada E um token HMAC válido
ou comprometimento do runtime da API/chave; estes são riscos residuais.
Um superuser de PostgreSQL e a própria API comprometida não são defensáveis
somente com este esquema. Revisar autorização do Fastify/JWT separadamente.

## Provisionamento separado, fail closed

Não publicar credenciais em GitHub e não criar senha/chave em migração. Após
aprovação, provisionar de forma segura no gerenciador de secrets:
- DB_DOU_LIMITS_PASSWORD (diferente de app/worker/curator);
- DOU_LIMITS_SIGNING_SECRET (64 caracteres hex de 32 bytes CSPRNG);
- DATABASE_DOU_LIMITS_URL (usuário exato radar_dou_limits_runtime).

Provision-runtime-role prepara o login e instala chave pelo DBA somente se
ambos os secrets existirem. Se faltar um, não habilitar; se a chave divergir
da já instalada, abortar (rotação exige processo independente). A migração
cria papel NOLOGIN, tabelas e funções mas NÃO cria credenciais. GET editable
usa disponibilidade da conexão dedicada mais readiness da chave no banco.
Não permitir UPDATE em public.sources via radar_app.

CI fabrica credenciais efêmeras independentes, mascara as variáveis e não
usa segredos de produção.

## CI e fixtures / critérios

- DOU SQL gateway: test/dou-limits-admin.integration.test.ts roda **isolado**
  após a suíte geral, com fonte DOU semeada/restaurada somente nesse job;
  não se deve executar em paralelo ao teste de coleta que manipula sources.
- Testar conexões SQL app com GUC admin falsificado => 42501;
  conexão dedicada MAC inválido => 42501;
  operação assinada legítima => UPDATE/audit; nonce repetido => 23505;
  dois PUTs simultâneos => resultados inteiros e auditoria; admin revogado
  e cliente não-admin não podem gravar; nenhum UPDATE direto do app.
- PostgreSQL 16 e 18: .github/workflows/ops-dou-limits-pg-gate.yml.
- CI geral backend e CI frontend devem ser VERDES no HEAD congelado.
- Backfill desligado passa a consultar readWorkerDouLimits(db,sourceId)
  exatamente como coleta regular, a cada tentativa. Não rodar backfill para
  provar uma integração. PDF 20 MiB é campo FUTURO/inativo até TAX13 aprovado.

## Ordem de migration

A migration 050_ops_dou_download_limits.sql depende somente dos contratos
anteriores já instalados (003 sources, 006 audit, 009 security, 036 admin).
Não cria e não exige migration 049 TAX13. Migrator usa nomes lexicográficos
e checksums individuais em schema_migrations e pode aplicar adições futuras
044–049 sem reaplicar 050. Isto é análise estática da ordem, não valida
a compatibilidade do conteúdo de futuras migrations ainda não aprovadas:
essa compatibilidade precisa ser revisada quando seus SHAs estiverem fixados.

## Gate de produção (NÃO executado)

Revisor independente novo deve aprovar SQL + role + segredo + testes.
Depois CI geral completo verde, plano de rollback (reverter apenas chave,
credencial e client-side editable; SQL já aplicado fica inerte), autorização
específica de deploy backend primeiro, frontend depois, smoke save/GET/audit
e reset do limite original, negar não-admin. Nunca contornar TAX13.
