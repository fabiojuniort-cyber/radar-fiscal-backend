# TriBusca — contexto para agentes do backend

Este repositório contém o código; a governança e o contexto entre chats ficam no `tribusca-control`. Antes de qualquer tarefa, leia:
1. https://github.com/fabiojuniort-cyber/tribusca-control/blob/main/contexts/BACKEND.md
2. O índice da frente indicada na Issue (DOE-SP: https://github.com/fabiojuniort-cyber/tribusca-control/blob/main/contexts/DOE-SP.md).
3. https://github.com/fabiojuniort-cyber/tribusca-control/blob/main/AGENTS.md
4. A Issue de governança específica e, então, o código/documentação atuais desta branch e da main.

A Issue define escopo, dependências, autorização e critérios. Verifique fatos operacionais ao vivo antes de usá-los. A implementação e schema reais estão neste repositório; o contexto central é índice datado, não substitui o código. Respeite os gates e a segurança do `tribusca-control`.

A cada marco relevante, registre evidências (PR/head, CI, revisão, deploy/run, bloqueio) na Issue. Mudanças de contrato, operação ou conector exigem documentação técnica no mesmo PR. Ao entregar, faça o handoff na Issue conforme `docs/HANDOFF.md` do `tribusca-control`; o Gerente Geral audita e atualiza o estado/contextos centrais. Não alegar que chats ou arquivos se sincronizam automaticamente. Não iniciar o próximo DOE antes do gate final de São Paulo.
