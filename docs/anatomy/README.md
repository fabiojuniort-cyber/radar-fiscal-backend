# ANAT-04 — núcleo isolado

Origem: **CLAUDE-COORD → GPT-EXEC**, pacote R2 autorizado por Fábio em 16/10/2026. Coordenação e retorno durável na [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116). Base do código: backend `30e749093c08e6f126da12142534f5c9ba65872f`, branch `feat/anat-04-core`. O [desenho Astra](https://github.com/fabiojuniort-cyber/tribusca-control/blob/c83f3c69958827ef69ecef9b54417693a6bd398d/docs/anat-desenho.md) é a referência, ajustada pelo escopo ANAT-04 encaminhado por Fábio.

## Primeira entrega

[Contrato ANAT→TAX v1](contract-v1.md), schema verificável e testes isolados. Nenhum módulo da aplicação importa a Anatomia nesta entrega. O schema de forma é acompanhado de validação semântica de árvore, posições, referências, cobertura, hashes e seleção. Validação do contrato não demonstra qualidade de um extrator.

Os testes são sintéticos. A elegibilidade aceita evidências de fixtures controladas; não carrega o dossiê ANAT-03 nem aprova vigência real. ANAT-03 continua em conferência paralela; sua aprovação não é pré-requisito dos testes controlados. Integração da taxonomia, tela de regras e carga do dossiê pertencem a outros pacotes.

## ANAT-02 mínimo consumido

| Campo | Estado e uso permitido |
|---|---|
| `publicationVersionId` | IDs fornecidos pelo SELECT humano: 52/91 `ec18e755-128c-41ca-8cd3-2bdad7d9d9eb`; 100/97 `8f1a2386-30fc-4f11-a88a-e96a65807793` |
| HTML de apresentação | Dois snapshots sanitizados, congelados no manifesto do corpus; hashes iguais aos confirmados por Fábio |
| Formato | `SANITIZED_HTML`, conforme evidência ANAT-02 |
| Texto canônico / `inputTextHash` | Texto da representação efetivamente consumida, a ser fixado pelo adaptador. Igualdade com `publication_versions.content_text` **NOT_PROVEN**; não preencher com hash produtivo presumido |
| `representationId` e ponteiros | Devem identificar o snapshot consumido; não inferir que o campo `is_current` é vigência jurídica |
| Anexos / `attachmentManifestHash` | Manifesto explícito das entradas fornecidas e ausências; disponibilidade produtiva **NOT_PROVEN**. Lista vazia não prova ausência de anexos oficiais |
| Versões de regras e motor | Locais e explícitas no contrato; nenhuma regra produtiva alterada |

Prova SQL anterior: [resultado do Dashboard](https://github.com/fabiojuniort-cyber/tribusca-control/blob/c83f3c69958827ef69ecef9b54417693a6bd398d/docs/anat/anat-02-dashboard-resultado.json). O executor não abriu conexão ao banco. A autorização manda usar os snapshots quando não houver canal permitido; Railway é proibida neste pacote. Grants/RLS, `content_text` e anexos produtivos permanecem lacunas declaradas. Esta entrega não adiciona rota ou persistência que amplie visibilidade.

## Corpus e bloqueio

[Preparação DOU e texto canônico congelado](dou-preparation.md); [preparações DOE-SP/RFB provisórias, só sintéticas](json-preparation.md); [gold das 7 entradas de desenvolvimento (aprovadas, escopo estrutural v1)](GOLD-01.md); [cobertura e lacunas para a medição](GOLD-COVERAGE.md); [avaliador puro, sem medição](evaluation.md); [administração de regras: inventário, desenho e plano](ADMIN-01.md); [P1.A — schema e resolução de perfis](profile.md); [P1.B — perfis integrados ao motor](profile-engine.md); [UNICODE-01a — contenção de texto não NFC](unicode.md); [UNICODE-01b/B1 — sombra NFC e mapa UTF-16, componente isolado](nfc-shadow.md); [UNICODE-01b/B2 — recuperação NFC integrada ao motor](unicode-recovery.md); [ADMIN-01 P2 — simulação, comparação e revisão (serviços puros)](rules-simulation.md); [busca de recuperação](RECOVERY-01.md); [estrutura oficial](official-structure.md); [protocolo do gold](gold-protocol.md). [Inventário](corpus-inventory.md) e [manifesto](../../test/fixtures/anatomy/corpus-manifest.json): 30 IDs, 12 publicações disponíveis em 14 arquivos, 18 corpos originais ausentes, zero gold completo revisado. Reserva fixa: 04, 06, 08, 09, 12, 14, 16, 18, 24, 28. Cópia e hash não executam regras nem produzem resultado de holdout.

**BLOCK_CORPUS_INPUTS_AND_GOLD** impede medição/aceite do pacote. Recuperar as 18 respostas já capturadas e conferir os hashes; depois anotar os 30 atos integralmente em UTF-16 e obter revisão Astra antes de medir. Nenhuma coleta nova foi autorizada. Os originais podem estar no ambiente remoto da sessão de desenho; a leitura do histórico local dessa sessão excedeu o limite da ferramenta e não recuperou os arquivos. Não foi enviada mensagem a outro chat.

## Marcos e conclusão

Percentual usa sete marcos de mesmo peso: (1) contrato verificável e checkpoint; (2) corpus/gold revisado; (3) estrutura; (4) entidades/M01/M02; (5) consumidor simulado/elegibilidade; (6) DDL/CI descartável; (7) aceite e revisão independente. Preparação parcial de um marco não o conclui. O contrato é a primeira entrega, não o pacote completo.

O CHECKPOINT-01 é histórico da primeira entrega. O [CHECKPOINT-02](CHECKPOINT-02.md) acrescenta leitores CONFAZ/DOU/DOE-SP/RFB, proteção de domínios, entidades, faixas/exceções, consumidor simulado e SQL exclusivo de preparação do CI. A implementação está em [engine.md](engine.md); limites por componente em [readers.md](readers.md), [entities.md](entities.md) e [ci-schema.md](ci-schema.md). O estado mais recente de CI, percentual e revisão fica nos comentários da issue #116, sem sobrescrever o histórico dos checkpoints.

Não usar migration automática nem conectar à classificação real. A preparação SQL é nova neste lote e só pode executar no banco descartável do workflow dedicado, jamais localmente ou em produção. Gates finais exigem corpus/gold completos, métricas comprovadas, CI completo verde, revisão independente Astra e autorização do COORD para merge. Nenhuma aprovação de benefício real foi criada.

Durante implementação o PR permanece draft, como exige `AGENTS.md`. O gate `DRAFT_FAST_ONLY` é intencional e não comprova regressão completa. Não rerodar o CI para removê-lo. Sem código conectado a produção, alterações na taxonomia/detector/classificação/cadastros, escrita em banco, coleta, Railway, merge ou deploy.
