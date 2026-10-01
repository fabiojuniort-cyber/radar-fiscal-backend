# Plano de escala do catálogo — 20 milhões de publicações (PERF-02)

Estado observado em 01/10/2026 (BRT). Proposta de gate **antes da carga
histórica do DOU (2002–2026)**. Complementa o PERF-01
([catalog-performance.md](catalog-performance.md)).

## 1. Como foi medido

- Banco local PostgreSQL 16 com **5 milhões** de publicações sintéticas
  (`ops/perf/seed-catalog-scale.sql`), 11 GB, distribuição parecida com a
  produção (90% federal, ~6% famílias ocultas, ~4% CONFAZ, 2% com 2 origens).
- P7 foi medido logo após reiniciar o PostgreSQL (cache frio), condição
  mais próxima da produção com pouca RAM; o filtro por fonte atual levou
  15 s a 2 min 14 s nessas condições.
- Endpoints medidos pela aplicação real (`ops/perf/bench-catalog.ts`) com o
  cache desligado (`AGGREGATE_CACHE_TTL_MS=0`), ou seja, o custo "a frio".
- Projeção para 20 milhões: varreduras escalam ~linearmente (x4); leituras
  por índice ficam praticamente constantes.
- **Limitações:** não havia disco para 20 milhões completos (~36 GB) nem para
  50 GB de texto; os textos sintéticos são curtos. A máquina local tem 15 GB
  de RAM, então o banco ficou em memória: em produção, com pouca RAM, as
  varreduras serão **mais lentas** que o projetado.

## 2. Resultado com o código do PERF-01 (cache desligado)

| Consulta | 300 mil | 5 milhões | 20 milhões (projeção) |
| --- | ---: | ---: | ---: |
| Acervo, páginas 1 / 40 / 4.000 | 5–45 ms | 0,2 s | ~0,5–1 s |
| Total geral (`/public/v2/stats`) | 0,05 s | 0,9 s | ~3–4 s |
| Acervo filtrado por UF | — | 0,9 s | ~4 s |
| Acervo filtrado por fonte (DOU/SPED) | 0,7 s | 7–10 s | ~30–40 s |
| Contagem por fonte (`/public/v2/sources`) | 2,5 s | 37 s | ~2,5 min |
| Filtros do Acervo (`/api/v2/archive/facets`) | 1,3 s | 48 s | ~3 min |
| Busca por palavra (`q`) | — | 27 s (texto curto) | minutos (lê 50 GB) |

O cache de 1 h do PERF-01 esconde contagens e filtros do usuário, mas o banco
continua pagando esses minutos a cada recálculo, e o primeiro acesso depois de
um deploy espera. **Filtro por fonte e busca não são cobertos pelo cache** e
ficariam inutilizáveis.

## 3. Soluções testadas no mesmo banco de 5 milhões

| # | Solução | Antes (5 mi) | Depois (5 mi) | 20 mi (projeção) |
| --- | --- | ---: | ---: | ---: |
| P1 | Contagens por fonte pré-calculadas (tabela de totais) | 37 s | **3 ms** | ~3 ms |
| P2 | Flag "oculta" gravada na publicação: total visível | 0,9 s | 0,24 s | ~1 s (fica em cache) |
| P3 | (descartado, ver P7) Fonte principal gravada + índice: Acervo por fonte, página 1 | 7–10 s | **1 ms** | ~1 ms |
| P3b | Mesmo índice: contagem exata por fonte | 7–10 s | 16–140 ms | ~0,1–0,6 s |
| P4 | Contagem limitada ("mais de 10.000 resultados") | — | **1 ms** | ~1 ms |
| P5 | Filtros do Acervo a partir da fonte gravada | 48 s | 0,3 s (ou ms via P1) | ms via P1 |
| P7 | **Índice "fonte → publicações por data"** (`publication_source_feed`, uma linha por origem): Acervo por fonte **com o significado atual** (inclui 2ª origem) — página 1 / 40 do DOU | 15 s / 2 min 14 s (banco frio) | **1 ms / 5 ms** | ~1–5 ms |
| P7b | Mesmo índice: contagem limitada "mais de 10.000" por fonte | 6–33 s (banco frio) | **21 ms** | ~21 ms |
| P6 | Busca pelo índice textual já existente (`search_vector`) — termo raro | 5,8–27 s | **20 ms** | ~20–50 ms |
| P6b | Idem — termo muito comum (900 mil resultados) | — | 0,5–1 s | ~2–4 s (precisa limite) |

Custos de migração medidos (5 milhões; a produção hoje é muito menor):

| Passo | 5 milhões | Observação |
| --- | ---: | --- |
| Colunas geradas `is_hidden` / `is_confaz` (reescreve a tabela) | 85 s | trava a tabela; hoje, com poucos registros, leva segundos |
| Preencher `primary_source_id` | 17,6 min | em lotes não trava; hoje leva segundos |
| Índice por fonte (P3, descartado) | 4 s | |
| Tabela + índice `publication_source_feed` (P7) | 22 s + 4 s | ~444 MB em 5 mi |
| Recalcular a tabela de totais inteira | 4 s | com as flags gravadas; antes eram 37 s |

**Conclusão:** essas mudanças são baratas **agora**, enquanto o banco é
pequeno, e caras depois da carga histórica. Por isso devem entrar antes dela.

## 4. Plano proposto (fases do gate)

| Fase | O que | Risco | Decisão de produto necessária |
| --- | --- | --- | --- |
| F1 | PERF-01: índice de visíveis, consultas reescritas, cache 1 h, frontend sem rajada | R2 + R3 (migration 028) | Já tomada (cache 1 h) |
| F2 | Gravar na publicação `is_hidden`, `is_confaz` (colunas geradas) e `primary_source_id` (preenchido pela persistência e backfill), com índices | R3 (migration com reescrita) | — |
| F3 | Tabela de totais por fonte/UF, recalculada pelo worker ao fim de cada coleta (e não na requisição); `/public/v2/sources`, `/stats` e facets leem dela | R2 | — |
| F4 | Acervo: filtro por fonte via índice próprio `publication_source_feed` (P7), mantido pela persistência a cada origem gravada — **mesmo significado de hoje**, inclusive regra CONFAZ/DOU; contagem limitada a 10.000 ("mais de 10.000"); total exato por fonte via F3. Custo: ~0,4 GB por 5 mi (~1,8 GB em 20 mi). Substitui a ideia de "fonte principal" (P3), que mudaria o significado do filtro | R2 (+ migration R3) | Decidido (01/10/2026): **manter o seletor de fonte com o significado atual** |
| F5 | Busca do Acervo pelo índice textual (`search_vector`), com nº do ato por igualdade exata; resultados por data; limite para termos muito comuns | R2 | **Sim:** a busca passa a ser por palavras inteiras com variações ("tributos" acha "tributo"), em vez de trechos de texto. Corrige falsos positivos atuais ("1216" hoje acha "12160"). |
| F6 | Infra: `pg_stat_statements`, log de consultas > 500 ms, `DB_POOL_MAX`, dimensionar RAM do PostgreSQL para o volume histórico | R3 (infra) | Custo do Railway |
| F7 | Carga histórica em lotes, fora do horário de coleta, `ANALYZE` e recálculo de totais ao final de cada lote; repetir o benchmark com a produção espelhada | R3 | Janela de carga |

## 5. Critério de aceite do gate (proposto)

Com o volume simulado (ou produção espelhada) de 20 milhões, **cache
desligado**:

- todas as consultas do painel, exceto a busca: **< 500 ms**;
- busca por termo comum: **< 2 s**; termo raro: **< 300 ms**;
- nenhuma consulta de requisição varrendo a tabela inteira de publicações
  (verificado por `pg_stat_statements` / `EXPLAIN`);
- rajada do painel sem fila no pool de conexões.

## 6. Reproduzir

Ver [ops/perf/README.md](../ops/perf/README.md): `seed-catalog-scale.sql`
(volume), `bench-catalog.ts` (endpoints), `experiment-build.sql` e
`experiment-measure.sql` (soluções P1–P6). Todos se recusam a rodar fora de
um banco cujo nome contenha `perf`.
