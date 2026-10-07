# CI-COST-02 — CI rápido e regressão final

Governança: [tribusca-control#92](https://github.com/fabiojuniort-cyber/tribusca-control/issues/92).

## Como trabalhar

1. Abra o PR como **draft** durante implementação e envie blocos coerentes de commits.
2. Os checks rápidos validam roteamento, dependências, tipos, build e testes unitários. Corrija falhas reais dessas etapas.
3. O último gate deixa o draft vermelho com **DRAFT_FAST_ONLY**. Isso é intencional: checks rápidos não aprovam merge. **Não faça rerun nem novos commits só para eliminar esse aviso.**
4. Ao concluir a implementação, marque o PR **Ready for review**. O evento `ready_for_review` dispara a regressão completa no mesmo PR.
5. Todo novo commit de um PR pronto também executa a regressão completa. Converter novamente em draft restaura o modo rápido.
6. Antes do merge, confirme CI completo verde no head atual e revisão independente quando a governança exigir. Não use o CI rápido antigo como evidência final.

`opened`, `synchronize`, `reopened`, `ready_for_review` e `converted_to_draft` estão explícitos. O alcance de branches foi preservado. Push em `main` continua completo, sem depender de payload de PR.

Os nomes dos checks finais e a concurrency de CI-COST-01 foram preservados. Cancelamento continua limitado ao PR anterior; pushes têm grupos independentes. Não existem workflow-level `paths-ignore` nem novos runners para roteamento.

## Limites

A configuração atual de `main` não tem branch protection. O gate vermelho torna a falta de regressão completa visível, mas não impede um usuário com permissão de ignorar o procedimento e fazer merge. Esta frente não altera plano, billing, visibilidade ou proteção da branch.

A economia depende de desenvolver em draft. PRs abertos como prontos desde o primeiro commit continuam executando o CI completo em cada atualização. Minutos economizados precisam ser medidos em runs reais; duração de workflow não é equivalente ao total faturável dos jobs.

## Validação e rollback

`python3 -m unittest discover -s .github/scripts -p test_ci_plan.py` cobre drafts, ready, main, metadados inválidos, paths protegidos, diff incerto, nomes com Unicode/newline, exclusão/rename real e o gate DRAFT_FAST_ONLY.

O rollout valida os próprios PRs primeiro em draft e depois em ready, seguido de CI na main após merge. Não são necessários commits artificiais para testar os eventos.

Rollback: revert do commit squash desta frente restaura o CI completo em todo PR, preservando as melhorias independentes de CI-COST-01. Não revertê-las junto.

## Backend

Draft não inicia PostgreSQL 16, não prepara DB, não roda integrações/dry-runs e não inicia o job PG18. Mantém manifest TAX-06 e identidade byte a byte, build e todas as unidades existentes.

PR pronto mantém **todos** os gates anteriores no job `verify`, na mesma ordem. Só os guards DOU-CLEAN-02 e o job isolado PG18 usam seleção especializada.

PG18 sempre roda em main. Em PR pronto, roda para:
- `ops/dou-clean-02/**`, qualquer SQL, publication-scope, dou-historical-cleanup e RLS;
- migrations, infraestrutura de DB e auth;
- workflows/scripts de CI, dependências, configurações TypeScript e Docker;
- qualquer path fora da lista comprovadamente não relacionada ou diff não comprovado.

A lista não relacionada contém arquivos de `src/`, `test/`, `docs/`, README, AGENTS e gitignore, **somente depois** das regras protegidas. Os contratos isolados consomem a fixture e SQL do runner; testes/migrations reais continuam na regressão PostgreSQL 16. Novas dependências do runner exigem atualizar as regras e seus testes no mesmo PR.

O diff usa SHAs validados, `git fetch` limitado e `git diff --no-renames --name-only -z base head`. Exclusões e ambos os lados de renames permanecem visíveis. Falha, timeout, diff vazio ou inválido selecionam PG18. Erros capturados de git não expõem URLs/credenciais nos logs.

O job PG18 depende de `verify` verde, evitando gastar um segundo runner quando o gate principal falha. Roteamento fica no runner já existente.
