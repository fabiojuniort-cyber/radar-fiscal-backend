# TriBusca — contexto para agentes do backend

Este repositório contém o código; a governança e o contexto entre chats ficam no `tribusca-control`. Antes de qualquer tarefa, leia:
1. https://github.com/fabiojuniort-cyber/tribusca-control/blob/main/contexts/BACKEND.md
2. O índice da frente indicada na Issue (DOE-SP: https://github.com/fabiojuniort-cyber/tribusca-control/blob/main/contexts/DOE-SP.md).
3. https://github.com/fabiojuniort-cyber/tribusca-control/blob/main/AGENTS.md
4. A Issue de governança específica e, então, o código/documentação atuais desta branch e da main.

A Issue define escopo, dependências, autorização e critérios. Verifique fatos operacionais ao vivo antes de usá-los. A implementação e schema reais estão neste repositório; o contexto central é índice datado, não substitui o código. Respeite os gates e a segurança do `tribusca-control`.

A cada marco relevante, registre evidências (PR/head, CI, revisão, deploy/run, bloqueio) na Issue. Mudanças de contrato, operação ou conector exigem documentação técnica no mesmo PR. Ao entregar, faça o handoff na Issue conforme `docs/HANDOFF.md` do `tribusca-control`; o Gerente Geral audita e atualiza o estado/contextos centrais. Não alegar que chats ou arquivos se sincronizam automaticamente. Não iniciar o próximo DOE antes do gate final de São Paulo.

## Cadastro empresarial e Perfil Tributário

Regras para cadastro por CNPJ e perfil do Sonar:
- razão social, nome fantasia, endereço e CNAEs são dados cadastrais do CNPJ/RFB; não atribuir esses dados à SEFAZ;
- a integração de consulta cadastral é server-side e deve persistir apenas os campos necessários ao produto; dados como QSA não devem ser expostos sem escopo específico;
- ao cadastrar uma empresa por CNPJ, criar também a matriz e registrar CNAE principal e todos os secundários;
- `company_cnaes` deve refletir o conjunto de CNAEs dos estabelecimentos ativos; a matriz define o CNAE principal da empresa;
- CNPJ é identidade cadastral e não deve ser alterado por edição manual; correções cadastrais usam nova consulta ou exclusão/recriação controlada;
- exclusão de empresa/estabelecimento é lógica (`is_active=false`) para preservar histórico; matriz só é desativada junto com a empresa;
- o Perfil Tributário mistura contexto cadastral automático com seleção manual baseada em conceitos de uma release `PUBLISHED` da Taxonomia TriBusca;
- salvar códigos canônicos e `releaseId/releaseVersion` no perfil para permitir matching reprodutível; nunca converter a taxonomia em tags livres.


### Inscrição Estadual

- Inscrição Estadual é dado estadual e não deve ser inferida a partir do cadastro CNPJ/RFB.
- Após resolver o CNPJ e a UF, a aplicação pode consultar a fonte oficial estadual (SEFAZ/SINTEGRA) por conector independente da UF.
- Persistir IE junto com proveniência: fonte, horário, situação retornada e estado da tentativa.
- Estados mínimos da tentativa: `SUCCESS`, `NOT_FOUND`, `UNAVAILABLE` e `NOT_SUPPORTED`; nunca converter indisponibilidade em ausência de IE.
- Consulta estadual não deve bloquear a criação do estabelecimento quando a RFB já respondeu; falha estadual é enriquecimento incompleto.
- UFs com CAPTCHA, Gov.br ou outro desafio humano não podem ser automatizadas por bypass. Nesses casos, manter IE editável/manual e informar que a automação está indisponível ou em implementação.
- Reconsulta cadastral deve atualizar RFB e tentar novamente a consulta estadual suportada.

## Reativação de cadastros soft-deleted

Empresas e estabelecimentos são desativados com `is_active = false` para preservar histórico. As restrições únicas de CNPJ continuam válidas para registros inativos.

Por isso, fluxos cadastrais por CNPJ não devem tentar inserir um novo registro quando o mesmo identificador já existir:
- empresa existente no mesmo tenant deve ser atualizada e reativada;
- matriz existente deve ser atualizada e reativada;
- estabelecimento existente na mesma empresa deve ser atualizado e reativado;
- CNAEs e dados de RFB/IE devem ser atualizados na reativação;
- não remover histórico nem contornar unicidade com novos UUIDs.
