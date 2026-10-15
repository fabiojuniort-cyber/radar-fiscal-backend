# Classificação automática e Acervo

F2-CLASS-ALL / tribusca-control#114: a classificação considera todas as publicações visíveis do Acervo, sem exclusão adicional por fonte, tipo de ato ou status anterior. O contador, a seleção do worker, a classificação individual e o enriquecimento NCM compartilham `collection-filter.catalog-visibility.ts` com o Acervo. RLS e os bloqueios de publicação fora de escopo continuam vigentes.

DOU e DOE-SP preservados pela F3 continuam visíveis mesmo com o indicador legado `is_hidden`. As outras fontes seguem a visibilidade existente do Acervo. Uma publicação visível sem versão atual conta no total como pendente; só pode ser processada quando houver uma versão atual. O worker continua exigindo o enriquecimento NCM concluído antes de classificar e conserva o retry e a idempotência existentes.

`classificationExcludedSources` permanece no contrato como `[]`. Valores antigos em `taxonomy_runtime_settings` não restringem o processamento. O endpoint de compatibilidade `PUT /api/v1/admin/taxonomy/settings/excluded-sources` aceita apenas `sources: []`; qualquer lista não vazia retorna 409 `classification_archive_scope_fixed`. O setter interno também recusa listas não vazias. Não é necessário modificar os valores antigos no banco para aplicar esse comportamento.

O botão de ativação permanece independente: desligado, nenhum lote automático é processado. A versão publicada mais recente continua sendo a referência; o histórico e os rascunhos não são reescritos nem publicados por esta mudança. Os operadores de reconstrução DOE-SP continuam recusando exclusão de publicações com histórico associado.

O progresso é recalculado por GET de `/api/v1/admin/taxonomy/state`. Os totais do Acervo mantêm o cache agregado existente (padrão: uma hora de validade e uma hora de stale durante atualização). Ambos usam o mesmo conjunto, mas podem mostrar snapshots temporais diferentes durante esse intervalo. Esta alteração não limpa cache nem ativa classificação em produção.

Validação: integração de curadoria cobre DOE-SP/DOU com ocultação legada, outra fonte visível mesmo com exclusão persistida, outra fonte efetivamente oculta, publicação sem versão, igualdade com o total do Acervo em cache frio, pré-requisito NCM e idempotência. A implantação depende de CI completo e revisão independente do head. Reversão de código pelo fluxo normal de PR; classificações gravadas permanecem no histórico.
