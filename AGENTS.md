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
- exclusão de empresa é definitiva, com matriz/filiais e perfis; estabelecimentos inativos preexistentes permanecem armazenados até ação explícita, sem reativação;
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

## Exclusão definitiva de empresa — ONB-02 (R3; gate obrigatório)

A exclusão de **empresa** pelo usuário deve remover fisicamente o cadastro,
a matriz e filiais, perfis tributários e vínculos dependentes daquela empresa,
sem apagar publicações legais globais ou a taxonomia de outros usuários. Um novo
cadastro do mesmo CNPJ deve criar novo identificador e perfil vazio, sem
reativação de dados anteriores. É uma mudança **R3**: aplicar somente após
CI integral, revisão independente, backup/restauração comprovada e aprovação
do gate produtivo, conforme `ops/onb02/README.md` e Issue #118.
Nenhum `GRANT DELETE ON companies` generalizado ao runtime.

A exclusão individual de estabelecimento mantém os dados preexistentes inativos até
exclusão explícita autorizada. **Não existe reativação** de empresa, matriz ou filial:
qualquer novo cadastro exige exclusão definitiva prévia e gera novo identificador,
sem recuperar perfis, histórico privado nem pré-preenchimento do onboarding legado.
A confirmação de exclusão definitiva exige o nome digitado; clientes antigos sem
`X-Company-Delete-Intent: permanent-v1` recebem 409 e não executam a purga.
O serviço aplica SET LOCAL statement_timeout=30s e lock_timeout=5s antes do SELECT.
Os endpoints rejeitam reactivateInactive=true com 410; inativas não são purgadas
automaticamente. A política R7 usa allowlist tipada por evento em toda escrita.
A purga não minimiza auditoria por texto e fica bloqueada até o backfill histórico
separado estar concluído. R7.1: tipos sem regra são listados no --plan e bloqueiam
--apply antes de qualquer escrita; nunca esvaziar payload de evento desconhecido.
R7.2: autores novos exigem UUID ou identidade de sistema enumerada; autor privado
legado vira NULL com actor_redacted=true. Linhas v1 com autor inválido também são
pendentes. Simulações históricas preservam as seis combinações FULL_ARCHIVE/RECENT
e ALL/SAMPLE/NONE.
Ver docs/audit-policy-r7.md e docs/audit-event-inventory-r7.json. O backfill em produção exige
autorização própria, além do deploy. Políticas de recuperação seguem ACCEPTED_RISK.

### Local Negócio

- `Local Negócio` é um código interno informado manualmente pelo cliente para identificar matriz/filial; não é dado da RFB nem da SEFAZ.
- Persistir o código no estabelecimento (`business_location_code`), inclusive para a matriz; não duplicar o dado na tabela `companies`.
- No cadastro de empresa, o campo representa o Local Negócio da matriz.
- Reconsultas de CNPJ/RFB/IE não podem apagar nem sobrescrever o Local Negócio informado manualmente.
- O código deve ser único entre estabelecimentos ativos da mesma empresa quando preenchido.
- Valor vazio deve ser persistido como `NULL`.

### Resiliência da consulta CNPJ

- A consulta cadastral server-side usa BrasilAPI e Minha Receita como providers primários concorrentes para reduzir a indisponibilidade percebida.
- A indisponibilidade dos providers não deve tornar o produto inutilizável: a experiência pode oferecer cadastro manual controlado da empresa/matriz ou do estabelecimento, preservando o CNPJ validado como identidade.
- `cnpj_not_found`, `cnpj_provider_unavailable` e `cnpj_provider_invalid_response` continuam semanticamente distintos; resposta 404 isolada junto com falha de outro provider não deve ser promovida automaticamente a inexistência definitiva.
- Cada tentativa de provider deve gerar observabilidade estruturada com provider, duração, outcome, HTTP status quando houver e classe de erro, sem registrar CNPJ, credenciais ou dados pessoais desnecessários.
- Providers futuros devem implementar o contrato `CnpjRegistryProvider`; o código reserva integração oficial/comercial futura (por exemplo SERPRO) sem ativar credenciais ou endpoints do Conecta GOV por padrão.
- Provider de terceiro não deve ser adicionado a produção quando seus termos de uso/licenciamento forem incompatíveis ou não comprovados para um SaaS multi-tenant.
- Persistir somente os campos necessários ao produto; nenhum provider cadastral autoriza expor QSA ou ampliar o conjunto de dados sem escopo específico.
- Cadastro manual de matriz deve ser atômico: empresa e estabelecimento matriz são criados na mesma transação; Local Negócio e IE manuais mantêm proveniência manual e não são sobrescritos por indisponibilidade externa.

## CI com custo controlado

Durante implementação, trabalhe em PR **draft** e envie blocos coerentes de commits. O draft roda checks rápidos e termina com `DRAFT_FAST_ONLY`: aviso intencional de regressão completa pendente, não uma falha do produto. **Não rerodar esse CI nem criar commits só para eliminar o aviso.**

Quando estiver pronto, marque **Ready for review** para disparar todos os gates completos; cada atualização posterior do head também roda a regressão completa. Só faça merge com CI completo verde no head atual e revisão exigida pela governança. Main mantém a regressão completa. Procedimento, seleção PG18 e rollback: `docs/ci-cost-02.md`.
