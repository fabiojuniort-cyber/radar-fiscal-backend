# CONFAZ — pesquisa de alternativas de egress

Data: 2026-09-19.

Este documento registra pesquisa técnica. Não constitui ADR aprovado nem autorização de contratação.

## Contexto

O Worker Railway em Hobby não consegue abrir conexão TCP para `www.confaz.fazenda.gov.br:443` a partir de SFO, IAD ou AMS. O erro observado é `UND_ERR_CONNECT_TIMEOUT`.

O recurso Railway Static Outbound IP é restrito ao plano Pro. O workspace atual está em Hobby.

## Opção 1 — Railway Static Outbound IP

- alteração mínima de arquitetura;
- aplica-se somente ao `radar-fiscal-worker`;
- mantém parsing, deduplicação, versionamento e persistência exatamente onde estão;
- IPs estáticos são regionais e podem ser compartilhados com outros clientes Railway;
- requer plano Pro;
- Hobby: US$ 5/mês de base;
- Pro: US$ 20/mês de base;
- incremento mínimo de assinatura: US$ 15/mês;
- não há garantia de que o CONFAZ aceite o novo conjunto de IPs; precisa de teste real.

Prioridade: primeiro teste, por ser a menor mudança operacional.

## Opção 2 — Fixie HTTP/HTTPS proxy

Características pesquisadas:

- proxy HTTP/S padrão;
- HTTPS via CONNECT tunnel, mantendo TLS ponta a ponta;
- dois IPs estáticos por grupo/proxy;
- alta disponibilidade, health monitoring e failover;
- logs e monitoramento de uso no dashboard;
- integração simples por URL de proxy em variável de ambiente;
- permite uso somente pelo conector/fonte desejada, sem mover o Worker;
- plano gratuito: 500 requests/mês e 100 MB, suficiente para prova técnica curta;
- US$ 5/mês: 2.500 requests;
- US$ 19/mês: 25.000 requests / 10 GB.

Adequação: muito boa para POC e para source-specific egress. Exige criar conta/proxy e guardar `FIXIE_URL` como secret no Railway.

## Opção 3 — QuotaGuard Static

Características pesquisadas:

- HTTP, HTTPS e SOCKS5;
- par de IPs estáticos;
- alta disponibilidade/failover;
- analytics;
- regiões US ou EU;
- outbound HTTPS por CONNECT tunnel sem decriptar payload;
- Starter US$ 19/mês, 20.000 requests / 10 GB;
- trial de 3 dias;
- planos compartilhados usam par de IPs estáticos compartilhados; Enterprise oferece dedicado.

Adequação: boa, porém custo inicial maior que Fixie e sem região Brasil.

## Opção 4 — Fly.io relay mínimo

Características pesquisadas:

- região `gru` (São Paulo);
- Static Egress IPs para Machines;
- IP de egress persiste até liberação explícita;
- US$ 0,005/h por IP (~US$ 3,60/mês), além do compute da Machine;
- possibilidade de relay mínimo controlado pelo Radar Fiscal;
- observabilidade e controle maiores que proxy SaaS;
- exige operar e proteger um serviço próprio.

Adequação: forte candidato para infraestrutura reutilizável caso múltiplas fontes brasileiras apresentem bloqueio de egress.

## Opção 5 — AWS Lightsail São Paulo

Características pesquisadas:

- região `sa-east-1` (São Paulo);
- instância Linux com IPv4 a partir de US$ 5/mês;
- static IP incluído enquanto ligado à instância;
- infraestrutura e monitoramento AWS/Lightsail;
- maior responsabilidade operacional: SO, patches, proxy, firewall, autenticação e observabilidade.

Adequação: baixo custo e boa região, porém maior carga operacional que Fixie ou Railway Static IP.

## Comparação resumida

| Opção | IP estável | Região BR | Custo inicial aproximado | Segurança HTTPS | Observabilidade | Operação |
| --- | --- | --- | ---: | --- | --- | --- |
| Railway Pro Static IP | Sim, compartilhado possível | Não no projeto atual | +US$ 15/mês de base | TLS direto | Railway | Muito baixa |
| Fixie | Sim | Não explicitamente BR | US$ 0 POC; US$ 5–19/mês | CONNECT, TLS ponta a ponta | Dashboard/logs | Muito baixa |
| QuotaGuard | Sim | Não, US/EU | US$ 19/mês | CONNECT, TLS ponta a ponta | Analytics | Muito baixa |
| Fly.io relay | Sim, dedicado ao app | Sim, GRU | ~US$ 3,60/mês por egress IP + compute | Controlado pelo Radar | Plataforma + app | Média |
| Lightsail relay | Sim, dedicado à instância | Sim, São Paulo | a partir de US$ 5/mês | Controlado pelo Radar | AWS/Lightsail + app | Média/alta |

## Arquitetura proposta se fallback for necessário

```
Railway Scheduler
  -> Railway Worker
     -> adapter/source-specific egress
        -> relay/proxy
           -> fonte oficial
```

O relay não deve receber lógica tributária, parser, deduplicação, versionamento, acesso ao PostgreSQL ou persistência.

A aplicação deve preferir configuração source-specific, por exemplo um proxy/agent apenas no conector CONFAZ, evitando transformar todo o tráfego externo do Worker em tráfego proxied.

## Segurança mínima para relay próprio

- autenticação forte Worker -> relay;
- allowlist de destinos no relay, inicialmente apenas `www.confaz.fazenda.gov.br:443`;
- somente método CONNECT/HTTPS ou fetch relay estritamente restrito;
- nenhum acesso ao PostgreSQL;
- sem credenciais de tenant;
- logs sem conteúdo sensível;
- limites de taxa e timeout;
- healthcheck e métricas;
- secrets apenas em variáveis seguras;
- negar uso como open proxy.

## Estado

Nenhum fallback foi consolidado nem contratado.

Ordem recomendada:
1. testar Railway Static Outbound IP se o workspace for atualizado para Pro;
2. se falhar, executar POC gratuita com Fixie;
3. se a estratégia precisar ser reutilizável para múltiplas fontes e/ou exigir região Brasil, comparar POC Fixie com relay próprio Fly.io/Lightsail;
4. antes de produção com relay próprio, criar ADR proposto e obter aprovação do Gerente Geral.
