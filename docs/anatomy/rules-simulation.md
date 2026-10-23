# ANAT-ADMIN-01 / P2 — simulação, comparação e revisão (serviços puros)

Origem: autorização do COORD (issue #116) para a fase P2 do [ADMIN-01](ADMIN-01.md). Módulo: `src/modules/anatomy/rules-simulation.ts`. Testes: `test/anatomy.rules-simulation.unit.test.ts`.

**Escopo:** são os serviços **em memória** que a tela de administração vai consumir.
- Não há persistência, API administrativa, ativação nem retorno de versão.
- Não há leitura de corpus, gold ou reserva.
- Motor, contrato, proteções, golds e critérios de medição não mudaram. O módulo não é importado pelo motor, então o `engineHash` continua o mesmo.

## Delta em relação ao plano P2 do ADMIN-01

O ADMIN-01 previa simulação "motor + avaliador sobre amostras de desenvolvimento" (as 7 entradas reais). **Esta parte não foi implementada**: o escopo autorizado agora é só de entradas sintéticas explícitas.
- **Mantidos do plano:**
  - exemplos positivos e negativos com resultado esperado (T3);
  - comparação antes/depois do mesmo snapshot identificada por hash (T5);
  - decisão do revisor sobre cada diferença;
  - limites de 2 s por amostra e até 20 amostras;
  - rejeição dos IDs da reserva.
- **Ficam para outra fase:**
  - amostras do conjunto de desenvolvimento e métricas do avaliador, que dependem de autorização de execução sobre o corpus;
  - autor diferente do revisor e trilha de auditoria (`audit_log`), que pertencem à P3 (persistência e API).

## Serviços

### `simulateProfiles({ profiles, examples }, clock?)`

**Exemplo (validado em `strictObject`):**
- `id`, que não pode ser um ID da reserva (04, 06, 08, 09, 12, 14, 16, 18, 24, 28);
- `purpose`, `polarity` (`positive` ou `negative`), `source`, `family`;
- `input` com exatamente um de `html` ou `text`, até 256 Ki unidades UTF-16. Não aceita nenhum campo que referencie o corpus;
- `catalog` opcional;
- `expect`: de 1 a 64 matchers (`part` por tipo e contexto opcional; `entity` por domínio, literal e relação; `limitation` por código).

**Semântica:**
- exemplo positivo: todos os matchers precisam estar presentes;
- exemplo negativo: nenhum pode estar presente.

**Execução:**
- até 20 exemplos, **sequenciais e isolados**: cada exemplo recebe requisição nova e perfis clonados, com data de referência fixa;
- o perfil candidato é resolvido para cada alvo **antes** de qualquer execução. Um perfil inválido (fora do schema, abaixo do piso de proteções ou com conflito) rejeita a simulação inteira (`invalid_profile`), sem relatório parcial;
- um exemplo que passa de 2 s fica `partial`. O motor é síncrono, então o tempo é medido; não há interrupção;
- qualquer entrada de elegibilidade `eligible: true` lança `positive_selection`. Nenhuma seleção positiva sem evidência jurídica.

**Relatório:**
- `engineHash` e `profileSetHash` (SHA-256 do JSON canônico dos perfis);
- por exemplo: `effectiveProfileHash`, `ruleSetHash`, `outputHash`, status do resultado, limitações e cada verificação feita.

### `compareResults(before, after)` e `compareProfiles({ example, before, after })`

- Exige o **mesmo snapshot** (`inputTextHash` e `inputPresentationHash`).
- As chaves são estáveis por conteúdo (`tipo@início-fim`, `domínio@início-fim`), não por IDs internos.
- **Categorias comparadas:**

| Categoria | Atributos comparados |
|---|---|
| Partes | Contexto, motivos, reconhecimento, cobertura, pai e tabela |
| Entidades | Literal, `normalized`, parte, regra e validação |
| Relações | Tipo, operador, condição, grupo, alvos, escopo e expansão |
| Limitações | Código, span e parte |
| Elegibilidade | `eligible`, motivos de exclusão e evidências |

- Cada diferença tem `added`, `removed` ou `changed`, com o antes e o depois, e um ID determinístico.
- A comparação traz `engineHash`, `ruleSetHash`, `outputHash` e status dos dois lados; `compareProfiles` acrescenta os `profileSetHash`.
- A comparação também tem um `id`, que é o hash do conteúdo.
- As contagens por categoria são **apenas informativas**.

### `reviewDifferences(comparison, decisions)`

- Cada diferença recebe `expected`, `regression` ou `not_evaluated` (o padrão), com nota.
- São recusados:
  - IDs desconhecidos ou duplicados;
  - decisões fora da lista;
  - uma comparação cujo conteúdo não corresponda ao seu `id` (a revisão fica presa à comparação exata).
- **Veredito:**
  - qualquer `regression` → `blocked`;
  - senão, qualquer `not_evaluated` → `incomplete`;
  - senão → `clear`.
- **A mudança de contagem, sozinha, nunca decide regressão.**

## Testes (só sintéticos)

| Requisito | Teste |
|---|---|
| Exemplos positivos e negativos com o candidato; hashes do motor e dos perfis; zero seleção positiva | `P2 simulation: positive and negative…` |
| Determinismo e isolamento: mesma entrada dá o mesmo relatório; a ordem não vaza; outra execução entre duas não interfere; as entradas não são mutadas | `deterministic and isolated` |
| Perfis inválidos (campo desconhecido, piso, conflito, sem default) e entradas inválidas (ID da reserva, sem expectativa, html e text juntos, campo de corpus, mais de 20, ID duplicado) | `rejected fail-closed` |
| Limite de 2 s → `partial` | `time budget` |
| Diferenças em partes, entidades, relações, limitações e elegibilidade; elegibilidade nova continua `false`; comparação determinística | `P2 comparison…` |
| Classificação explícita; contagem não decide; IDs desconhecidos ou duplicados e comparação adulterada recusados | `P2 review…` |
