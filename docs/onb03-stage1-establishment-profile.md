# ONB-03 — Etapa 1 / P07
Perfil por estabelecimento persistido em personalization.establishmentOverrides, no histórico versionado existente.
Cada unidade ativa tem regime, conceitos canônicos e NCM próprios; ausência significa vazio/não informado, sem herdar da matriz.
O cadastro de filial não copia escolhas nem cria perfil. Nenhum backfill ou atualização de cliente existente.
PUT continua exigindo administrador, tenant e empresa acessível. Rejeita unidade alheia, duplicada/inativa,
conceito sem release publicada vigente e NCM não atribuível no catálogo atual.
Omitir establishmentOverrides preserva os valores já salvos, que também passam por validação.
A linha da empresa serializa gravações concorrentes do histórico; unidades são protegidas durante validação.
Sem migration, SQL produtivo ou mudança no matching Sonar. O assistente por card e escopo completo por unidade
serão a etapa 3; T07/T08 dependem da aprovação/publicação da etapa 2.
Testes de integração usam banco descartável: persistência/readback, filial nova sem cópia, omissão legada,
rejeições sem alteração, outra empresa, outro tenant e usuário sem papel administrativo.
Backend #247 deve preceder web #127 após revisão independente e autorização COORD.
