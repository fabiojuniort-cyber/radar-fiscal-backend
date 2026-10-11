# CI-COST-01: cancelamento de execuções substituídas

Governança: https://github.com/fabiojuniort-cyber/tribusca-control/issues/91

## Comportamento

O workflow mantém todos os eventos, jobs, nomes dos checks, testes e gates existentes.
O grupo de concurrency inclui workflow, evento e número do PR. Um commit novo cancela
a execução anterior somente daquele PR. PRs diferentes não compartilham grupo.
Eventos fora de pull_request usam run_id como identificador único: pushes de main
continuam independentes e não são cancelados nem substituídos na fila.

O tempo já consumido antes do cancelamento continua contabilizado. Cancelamento
não dispensa a validação completa da versão mais recente antes de merge.

## Verificação e medição

- Validar a sintaxe do workflow e conferir que nenhum gate foi removido.
- Verificar no próximo ciclo real de commits do mesmo PR que a execução antiga
  termina como cancelled e a mais recente executa todos os gates.
- Não criar commits vazios nem reruns para medir economia.
- Comparar minutos cobrados por job e por PR concluído; duração total do workflow
  não representa a soma de runners quando há jobs paralelos.
- Economia mensal só pode ser declarada depois de observada.

## Limites e reversão

Este incremento não altera seleção de testes, branch protection, billing,
deploys ou operações de banco. Para reverter o cancelamento, remover somente
o bloco concurrency; preservar o restante do workflow.
