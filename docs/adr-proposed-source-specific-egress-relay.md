# ADR proposto — Source-specific egress relay para fontes oficiais bloqueadas

Status: **PROPOSTO — NÃO APROVADO / NÃO CONSOLIDADO**

Data: 2026-09-20

## Contexto

O conector CONFAZ está funcional em código, testes e persistência simulada/integrada, porém o ambiente Railway não consegue estabelecer TCP/HTTPS com `www.confaz.fazenda.gov.br:443`.

A falha foi reproduzida anteriormente em múltiplas regiões Railway. Após upgrade para Pro, um teste controlado habilitou Static Outbound IP apenas no `radar-fiscal-worker`.

O Worker saiu pelo IP `152.55.176.226` e continuou recebendo `UND_ERR_CONNECT_TIMEOUT` antes de qualquer resposta HTTP.

Portanto, Static Outbound IP por si só não resolve o bloqueio.

## Objetivo

Permitir que conectores específicos utilizem um caminho de saída alternativo sem mover do Railway:

- parsing;
- normalização;
- deduplicação;
- versionamento;
- Motor de Coleta;
- PostgreSQL;
- persistência;
- retries e histórico operacional.

## Arquitetura proposta

```
Railway Scheduler
  -> Railway Worker
     -> conector da fonte
        -> source-specific proxy adapter
           -> relay/proxy HTTPS
              -> fonte oficial
```

O relay é somente transporte de saída.

## Regras obrigatórias

1. A configuração deve ser por fonte. Para CONFAZ, usar secret como `CONFAZ_PROXY_URL`.
2. Não definir `HTTPS_PROXY` global para todo o Worker como solução permanente.
3. O proxy não recebe credenciais de banco, dados de tenants nem regras tributárias.
4. HTTPS deve permanecer criptografado ponta a ponta por túnel CONNECT sempre que o fornecedor suportar.
5. Nunca registrar a URL do proxy com usuário/senha em logs, metadata de run ou banco.
6. O Worker deve continuar registrando tentativas, falhas, retries e origem oficial normalmente.
7. Timeout/rate limiting/User-Agent do conector permanecem sob controle do Radar Fiscal.
8. Falha do relay deve ser distinguível operacionalmente de erro de parsing.
9. A solução não pode funcionar como open proxy.
10. A ativação deve ser reversível removendo o secret/configuração da fonte.

## POC preferencial

Primeiro candidato: Fixie HTTP/HTTPS.

Motivos:

- plano gratuito suficiente para prova curta;
- proxy HTTP/S convencional;
- HTTPS via CONNECT;
- dois IPs estáticos por proxy;
- dashboard com uso/logs;
- nenhuma lógica do Radar Fiscal precisa sair do Railway;
- menor esforço operacional que manter VM própria.

A POC deve conter somente:

1. criar proxy gratuito;
2. armazenar Proxy URL como secret no Worker;
3. ativar proxy somente para CONFAZ;
4. executar uma requisição HTTPS de baixo volume;
5. se houver sucesso, executar coleta incremental real;
6. validar persistência e idempotência;
7. remover/desabilitar a POC se falhar.

## Alternativas

### Fly.io relay próprio em GRU

Vantagens:
- região São Paulo;
- egress dedicado ao app;
- maior controle;
- reutilização futura para outras fontes.

Desvantagens:
- serviço adicional para operar, atualizar e proteger;
- autenticação, allowlist, rate limit, logs e healthcheck passam a ser responsabilidade do Radar Fiscal.

### AWS Lightsail São Paulo

Vantagens:
- IP estático e região brasileira;
- custo baixo e infraestrutura conhecida.

Desvantagens:
- maior carga operacional de SO/proxy/firewall/patching.

### QuotaGuard Static

Vantagens:
- produto gerenciado e simples.

Desvantagens:
- custo inicial superior ao Fixie para uma POC e sem vantagem comprovada para este caso.

## Critério de decisão

A solução só poderá sair de PROPOSTO para ACEITO depois de uma prova real:

- Railway Worker -> relay -> CONFAZ com HTTP válido;
- pelo menos uma publicação oficial persistida;
- repetição/idempotência;
- observabilidade suficiente;
- custo e credenciais documentados;
- sem regressão no Motor de Coleta.

## Estado atual

Nenhuma solução de relay está contratada ou ativa.

O código de POC pode ser preparado em branch isolada, mas não deve ser mergeado/ativado em produção antes da prova real e da aprovação do Gerente Geral.
