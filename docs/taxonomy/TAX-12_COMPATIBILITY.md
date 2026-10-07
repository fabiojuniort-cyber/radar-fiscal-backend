# TAX-12 — compatibilidade e retirada de dimensões

## Objetivo

A TAX-12 simplifica a taxonomia corrente sem reescrever releases publicadas:

- `treatment` é fundida em `theme`;
- `platform` e `tax_species` deixam a release corrente;
- conceitos históricos continuam auditáveis nas releases antigas.

## Compatibilidade de códigos

A release nova grava em `manifest.taxonomyCompatibility`:

- `redirects`: códigos antigos que possuem sucessor semântico;
- `retiredCodes`: códigos retirados sem sucessor.

Exemplo:

```json
{
  "taxonomyCompatibility": {
    "version": 1,
    "redirects": {
      "treatment.exemption": "theme.exemption"
    },
    "retiredCodes": [
      "platform.sped",
      "tax_species.tax"
    ]
  }
}
```

Esse mapa é aplicado no runtime a:

- critérios persistidos de `monitoring_profiles.criteria.taxonomy`;
- códigos persistidos em `company_tax_profiles.personalization.taxonomy.conceptCodes`;
- cálculo de afinidade;
- decisões históricas de curadoria por conceito.

Um código retirado sem sucessor não é convertido para outro conceito e não deve produzir match.

## RESTORE

Quando o conceito sucessor em `theme` já existe historicamente, mas está `RETIRED`, a fusão usa `RESTORE`.

A identidade em `taxonomy_concepts.id` deve permanecer a mesma. Não é permitido recriar o mesmo código com nova identidade.

Aliases, códigos oficiais e `classify_by_label` são combinados no conceito canônico.

Para a fusão Tratamento → Tema, `CCLASSTRIB` é transferido para a dimensão `theme`, preservando a classificação oficial.

## Higienização do grafo

Ao retirar uma dimensão do DRAFT, a operação remove da release nova:

- grupos pertencentes à dimensão;
- vínculos de grupos;
- relation rules que usem a dimensão;
- concept relations que tenham conceito da dimensão em qualquer ponta;
- mappings oficiais da dimensão, salvo quando há evidência que exija migração explícita.

A publicação da release possui validações bloqueantes para impedir:

- conceitos ativos sob dimensão retirada;
- grupos órfãos;
- relation rules apontando para dimensão retirada;
- concept relations apontando para conceitos/dimensões retirados;
- redirects inválidos, cíclicos ou com alvo inexistente.

## Idempotência

Reexecutar a fusão após aplicação bem-sucedida deve retornar plano vazio, sem `DIMENSION_NOT_FOUND` e sem criar novos conceitos.

## Gates

Antes de publicar a release:

1. testes unitários de compatibilidade;
2. testes de matching com código legado;
3. teste de integração TAX-12 em PostgreSQL;
4. verificação de identidade no RESTORE;
5. zero resíduos de grupos/relações/regras em dimensões retiradas;
6. CI completo verde;
7. revisão independente do SHA congelado.

A operação produtiva permanece separada do merge de código e deve começar por dry-run.
