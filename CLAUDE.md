@AGENTS.md

## Claude Code — como aplicar a orquestração

- Dispare sub-agentes com a ferramenta `Agent` e defina `model` por chamada: `haiku` (busca/leitura), `sonnet` (implementação/testes), `opus` (só se precisar de raciocínio pesado isolado). Sem `model`, herda o da sessão.
- Não use `fork` para economizar: ele sempre roda no modelo da sessão.
- Sub-agentes rodam em segundo plano; reúna os resultados, revise e só então edite/commite na branch designada.
