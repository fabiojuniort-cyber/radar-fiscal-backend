# ONB-03 Etapa 3 — início técnico do assistente

Issue: fabiojuniort-cyber/tribusca-control#117. Este documento organiza a implementação autorizada; não representa endpoints/UI já implementados nem liberação de produção.

## Contrato aprovado

Popup: Empresa → Estabelecimentos/IE → um card por CNAE do estabelecimento → Resumo → Concluir. Voltar, Avançar e Pular; salvamento independente por card; fechar/retomar; reabrir pelo perfil. Cadastro/consulta por CNPJ existente preservado, inclusive fallback manual. Tela única de empresa e filiais. Filial posterior inicia vazia e abre somente seu próprio assistente/CNAEs, sem herdar escolhas da matriz.

## Persistência e concorrência obrigatória

- Estado por tenant/empresa/estabelecimento, com versão, card atual, status por card e conclusão. Cards CNAE têm identidade estável baseada nos sete dígitos, nunca índice da lista.
- RLS e validação server-side de empresa/estabelecimento ativo; administrador autorizado; rejeitar ID de outra empresa/tenant.
- Cada gravação recebe versão-base e o único card afetado. Versão obsoleta retorna 409 legível e não grava; UI recarrega antes de nova confirmação.
- Salvar escolhas deve usar o perfil versionado existente, sob lock da empresa, fazendo merge exclusivamente no estabelecimento/card alvo. Nunca reenviar ou substituir todos os overrides a partir de snapshot da tela.
- Resolver também o caminho legado de salvamento com snapshot desatualizado; somente adicionar OCC ao endpoint novo deixaria o follow-up da Etapa 1 aberto.
- Seleções por CNAE agregam em união por estabelecimento, preservando escolhas de outros cards e de outras unidades. Retirar sugestão de um card não retira escolha confirmada em outro card.
- Não fazer migration/backfill de escolhas de clientes. Reabrir perfil existente exige ação explícita do usuário e preserva seleções anteriores até salvar o card.

## Sugestões e release

Consumir apenas publishedOperationalLinks da última release publicada, com CNAE exato, e retornar release/regra/proveniência. Staging e DRAFT não são recomendações operacionais ao cliente. Uma sugestão ainda não é escolha: o cliente confirma, remove ou adiciona. CNAE sem sugestão continua navegável e editável. Mudança de release deve produzir mensagem/compatibilização explícita, preservando histórico, sem apagar escolhas silenciosamente.

## Frases e animação

Animação na importação entre 5 e 10 segundos, frases em ordem aleatória por segmento, fallback genérico; respeitar preferência de movimento reduzido. Tabela editável administrativamente, com carga inicial do CSV aprovado (19 segmentos × 20 frases). O staging F2 possui 32 segmentos: mapear explicitamente para os 19 grupos do CSV, mantendo fallback para sem correspondência. Não inventar/substituir as 380 frases.

**Dependência aberta:** onb03-frases-animacao.csv foi procurado pelo nome exato e por nome simplificado, sem resultado. O arquivo precisa ser anexado/disponibilizado para validar colunas, encoding, 380 linhas e mapeamento. Isso bloqueia a carga inicial real das frases, não o desenho dos endpoints e o desenvolvimento dos demais cards.

## Verificação e gate

Testar matriz completa; filial posterior vazia; retomada; pular; CNAE sem sugestão; CNPJ indisponível/manual; isolamento tenant/empresa/unidade; duas telas alterando unidades diferentes e versão-base obsoleta; mudança de release; duplicidade de seleção entre cards; confirmar que GET não grava perfis. CIs integrais nos HEADs finais; revisão independente; merge/deploy somente após autorização do COORD. Não publicar outra taxonomia nem perfis por esta implementação.

Numeração de migration deve ser conferida ao vivo antes do PR: ANAT reserva 077–079; não ocupar nem renumerar arquivos de outra frente.
