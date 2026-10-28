# ONB-03.1 — IE manual no card Estabelecimentos

Follow-up de tribusca-control#117 / #121. Backend deve ser implantado antes do web; esta entrega para no gate de revisão.

O card Estabelecimentos permite editar, salvar e limpar a IE de cada unidade sem fechar o popup. Salvar IE é explícito e separado do salvamento do card tributário. Edições pendentes bloqueiam Voltar/Pular/Salvar e próximo até salvar ou descartar. Fechar o popup continua permitido quando nenhuma requisição está em andamento; rascunhos de IE não salvos não são persistidos. Um erro mantém o texto digitado e não avança nem tenta novamente sozinho. Em conflito, Recarregar IE descarta explicitamente o rascunho em favor do dado corrente da unidade.

## API

PATCH /api/v1/companies/:companyId/establishments/:establishmentId/state-registration

Requer autenticação, X-Tenant-Id e OWNER/ADMIN ativo. Empresa e unidade ativa devem pertencer ao tenant e uma à outra. O corpo estrito contém apenas expectedStateRegistration (string ou null) e stateRegistration (string de até 30 caracteres ou null). O valor anterior deve coincidir exatamente com o armazenado: IE alterada por outra tela retorna 409 state_registration_conflict, sem escrita. A proteção compara o valor da IE, não uma versão global de cadastro; não detecta mudança e retorno ao mesmo valor (ABA).

A transação bloqueia empresa e unidade, compara o valor anterior e escreve somente state_registration e os campos de proveniência estadual. Valor vazio vira null. Valor manual novo recebe fonte MANUAL; situação/horário/estado da consulta anterior são limpos porque não confirmam o novo valor manual. Salvar o mesmo valor é no-op e preserva proveniência/timestamp oficial. A resposta lê a IE persistida e retorna establishmentId, stateRegistration e stateRegistrationSource. O web valida a unidade antes de aplicar o readback.

Nenhum endereço, CNPJ, CNAE, Local Negócio, taxonomia, perfil tributário ou progresso do assistente é reenviado por essa operação. Sem migration, backfill ou nova permissão. O PUT completo de cadastro existente continua com o contrato anterior; esta mudança não adiciona OCC a esse editor legado. Se ele gravar depois, continua sendo uma edição explícita daquele fluxo.

## Verificação

Integração HTTP estende o cenário isolado de onboarding: dois PATCH concorrentes [200,409], tenant alheio, membro sem papel administrativo, unidade inexistente, campos extras recusados, limite de tamanho, readback, matriz intacta, limpar/no-op e comparação integral dos perfis/CNAEs e de todos os demais campos da unidade.

Testes React verificam popup aberto, payload mínimo por unidade/tenant, conflitos/recarga explícita, preservação do rascunho em erro e bloqueio durante salvamento. Playwright adiciona o save de IE dentro do popup ao cenário autenticado nos quatro viewports. Não há smoke com escrita produtiva nesta entrega.
