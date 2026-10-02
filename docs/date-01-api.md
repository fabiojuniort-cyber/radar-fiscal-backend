# DATE-01 — contrato do filtro de data do Acervo

`GET /api/v2/archive` aceita filtros opcionais sobre a data oficial persistida em `publications.published_on`:

- `publishedOn=YYYY-MM-DD`: data exata;
- `publishedFrom=YYYY-MM-DD`: limite inicial inclusivo;
- `publishedTo=YYYY-MM-DD`: limite final inclusivo.

`publishedOn` não pode ser combinado com intervalo. `publishedFrom` não pode ser posterior a `publishedTo`. Datas futuras são rejeitadas considerando `America/Sao_Paulo`.

Os filtros combinam com busca, esfera, UF, fonte, tipo de ato e NCM. Não há migration nova. O caminho `source + actType` preserva o hardening CAT-01: associação de fonte via `publication_source_feed`/`EXISTS` e data aplicada em `publications.published_on`; o caminho source-only pode usar `publication_source_feed.published_on` e seu índice de ordenação.
