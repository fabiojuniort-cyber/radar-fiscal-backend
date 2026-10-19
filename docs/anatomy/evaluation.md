# ANAT-04-EVAL-01 — avaliador puro da matriz de medição

Origem: COORD → CLAUDE-EXEC, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6258917779), PR #244 (draft). Implementado em 19/10/2026.

**Nada foi medido.** O avaliador recebe um gold (`AnatomyGold`) e uma predição já carregados em memória e devolve as métricas da [matriz](GOLD-COVERAGE.md). Ele não lê arquivos, não executa o motor e não acessa corpus, reserva, fonte nem banco. Os testes usam só dados sintéticos. A única exceção é uma contagem estática sobre os golds 01 e 02, que confere os papéis estruturais da matriz sem nenhuma predição.

## API (`src/modules/anatomy/evaluation.ts`, `ANAT-EVAL/1.0.0`)

- `prf(tp, previstos, gold)`: tabela de decisão de P, R e F1, com `null` = N/A:
  - P é N/A sem predições;
  - R é N/A sem gold;
  - com gold e predições mas nenhum acerto, P = R = F1 = 0.
- `ratio(numerador, denominador)`: `value: null` quando o denominador é 0.
- `matchOneToOne(gold, previstos, chaveGold, chavePrevisto)`: pares em ordem de ocorrência, com rastreamento por índice. Uma predição duplicada não gera outro acerto e vira FP.
- `goldCodeRoles(gold)`: spans de códigos candidatos estruturais e de não candidatos ao canal `ncm`.
  - **Candidato:** NCM, contexto `operative_candidate`, não é capítulo, membro de faixa nem alvo de exceção.
  - **Não candidato:** qualquer outro código, inclusive NBM.
- `evaluateEntry(id, fonte, gold, predição)`: E1–E5, R1–R6, M1, M2a, M2b, M2c (N/A), M2 (N/A), S1a, S1b, S2 (N/A) e C1.
- `aggregate(entradas)`: agrupa por fonte e em `ALL`. P, R e F1 são recalculados a partir das contagens somadas; razões somam numeradores e denominadores. **Nenhuma média de razões.** N/A é preservado.

A predição é uma forma mínima: partes, entidades, relações, seleções e cobertura opcional. A conversão de um `AnatomyResult` real para essa forma fica para a etapa de medição; não foi feita aqui.

## Regras implementadas, iguais às da matriz

| Métrica | Chave ou regra |
|---|---|
| E1 | tipo + span (sem a raiz) |
| E2 | pai previsto igual ao par do pai do gold; denominador = partes casadas cujo pai do gold não é a raiz e também foi casado |
| E3 | entre os irmãos **casados** do gold, na ordem do gold, cada par consecutivo precisa ter o mesmo pai previsto e a mesma ordem relativa. Assim, um irmão omitido não esconde uma inversão entre os vizinhos (correção EVAL-01) |
| E4 | contexto igual entre partes casadas, com matriz de confusão `gold->previsto` |
| E5 | span + linha/coluna/rowSpan/colSpan |
| R1 / R2 | NCM e NBM por domínio + span, **sem capítulos** (span de 2 caracteres) |
| R3 | casamento só por span entre códigos, contando trocas NCM↔NBM |
| R4 | capítulos de 2 dígitos |
| R5 | spans de CITATION/OTHER/PROCESS/CNPJ do gold atingidos por algum NCM previsto, cada span contado uma vez |
| R6 | CITATION |
| M1 | span do operador + as duas pontas **em ordem**, cada ponta identificada por **domínio + span**; ponta NCM↔NBM trocada ou id inexistente não casa (correção EVAL-01) |
| M2a | span do operador + **conjunto** de alvos (sem ordem), cada alvo por **domínio + span** (correção EVAL-01) |
| M2b | `scopeSpan` exato entre pares de M2a; escopo ampliado ou reduzido é erro |
| M2c / M2 | **N/A** nesta etapa (`condition: null` não prova ausência de condição) |
| S1a | não candidatos do gold atingidos por pelo menos uma seleção `ncm` positiva **com span válido** ÷ não candidatos do gold. Denominador do gold, independente de casamento; cada span conta uma vez |
| S1b | `emitted` = todas as positivas `ncm`, classificadas de forma **exaustiva** em uma única classe (a soma das classes é igual a `emitted`): `onNonCandidate`, `exactCandidate`, `inexactOnCandidate`, `outsideGoldCodes`, `inGap`, `unlocated`. **`violations`** (comprovadas) = `onNonCandidate` + `inexactOnCandidate` + `outsideGoldCodes`. **`unverifiable`** = `inGap` (lacuna declarada com span ou parte `unidentified` do gold) + `unlocated` (sem span, invertido ou fora do texto). Classes avaliadas nesta ordem de prioridade (correção EVAL-01) |
| S2 | **N/A**: depende de evidência jurídica aprovada (ANAT-06) |
| C1 | `recognizedLength ÷ textLength` quando a predição traz cobertura; caso contrário N/A. É descritiva |

Seleções `thematic_text` e seleções negativas não entram em S1.

**Limitação conhecida:** os golds aprovados declaram lacunas quase sempre sem span (`span: null`). Nesses casos, a lacuna não delimita uma região, e uma emissão nela cai em `outsideGoldCodes` só quando o texto está anotado. Se surgir uma região sem garantia, ela deve ganhar span no gold antes da medição.

## Testes (`test/anatomy.evaluation.unit.test.ts`, sintéticos)

- tabela de decisão nos cinco casos e razões N/A;
- duplicatas, com valores primitivos e com objetos;
- predição perfeita (1 onde definida, N/A onde deve ser);
- erros de pai, ordem, contexto e geometria contados separadamente;
- troca NCM↔NBM, classe capítulo e falso NCM sobre citação;
- faixa com pontas invertidas, conjunto de alvos sem ordem, escopo ampliado, M2c e M2 N/A;
- S1a com o mesmo span atingido duas vezes e S1b separando emissões sobre não candidatos de positivas inventadas;
- documento sem códigos: S1a N/A e S1b igual a 1;
- agregação por fonte e `ALL`, sem média, preservando N/A;
- **reproduções adversariais do parecer EVAL-01** (PR #244, review 5566614441): relação com ponta NCM↔NBM trocada e id inexistente; seleções inexatas, sem span, invertidas e fora do texto, sempre classificadas; emissões em lacuna declarada e em parte `unidentified` como não verificáveis; irmão omitido sem esconder inversão; agregação das classes S1b;
- papéis estáticos dos golds 01 (640 candidatos e 1.362 não candidatos) e 02 (0 e 1), iguais aos da matriz.
