# F3-SIMPL-01 — reaplicar o filtro ao acervo

O endpoint histórico `/out-of-scope/preview` mantém o endereço para compatibilidade, mas seleciona exclusivamente DISCARD do mesmo motor F3 da coleta, via `collection_filter_f3_candidates` e `evaluateHistoricalCollectionCandidate`. DOU e DOE-SP são avaliados com a política APPROVED atual. Não há seleção adicional por OUT_OF_SCOPE, flag gerada da migration 029 ou tipo inferido divergente no DOE-SP. KEEP e UNKNOWN nunca entram no plano.

O confirm recalcula o plano, verifica o token vinculado à revisão e à evidência, bloqueia os alvos e recalcula novamente antes da exclusão. Vínculos com empresa e outras origens oficiais impedem a exclusão. O único ramo de execução é `collection_filter_direct_purge_batch` com a regra efetivamente escolhida pelo motor; nenhum ramo legado é chamado. Não altera regras nem reclassifica a fila Novos tipos.

Os campos legados `outOfScope`, `hiddenLegacy` e `suspectDoe` continuam em zero por compatibilidade com clientes anteriores; não representam seletores. `count` e `ruleDiscards` são a quantidade elegível após proteções. `byRule` inclui fonte, seção e tipo; cada amostra inclui o tipo decidido. Fontes sem suporte F3 são preservadas.

A prova do passo 1 foi aceita pelo COORD a partir da prévia produtiva exibida pelo Fábio: três contadores legados em zero antes/depois da limpeza. Esta sessão não realizou SELECT produtivo. Código/PR somente: sem migration, merge, deploy ou exclusão de produção.

Validação isolada: equivalência do conjunto de IDs da prévia com decisões do runtime da coleta para as mesmas publicações; flags legadas não sobrepõem KEEP/UNKNOWN; proteção de empresa/outra origem; token invalidado por mudança de revisão mesmo com os mesmos IDs; stress de 3.000 regras/12.000 atos e regressões existentes. Revisão independente do COORD antes de merge.
