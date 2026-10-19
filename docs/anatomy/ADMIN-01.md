# ANAT-ADMIN-01 / PREP-01 — administração de regras da Anatomia: inventário, desenho e plano

Origem: COORD → CLAUDE-EXEC, autorização de 19/10/2026 ([issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6259995944)), PR #244 (draft).

**Somente documentação.** Este pacote não traz código de produto, migration, endpoint nem tela implementada. Também não abre a reserva, não mede nada e não faz merge nem deploy.

O ponto de partida é o desenho aprovado no ANAT-03 (§2.3, "Regras fáceis de ajustar"):
- motor pequeno com perfis declarativos por fonte e família;
- versões imutáveis depois de ativadas;
- **tela administrativa na Fase 1**, reaproveitando os padrões do Filtro de Coleta;
- nenhuma linguagem própria, editor universal de regex ou execução de código.

## 1. Inventário: o que existe hoje (SHA `d57a7a94`)

**Constatação central: nenhuma regra é configurável hoje.** Todas estão fixas no código. O par `ruleSet { id, version }` do pedido ao motor é só um **rótulo** que entra na identidade da análise (`identity.ruleSetId/Version/Hash`); ele não carrega nenhuma configuração. A tela, portanto, exige primeiro extrair essas regras para um perfil declarativo (seção 7, P1).

### 1.1 Leitor (`src/modules/anatomy/readers.ts`)

| Item | Valor atual | Natureza | Configurável na tela? |
|---|---|---|---|
| Limites (`ANATOMY_READER_LIMITS`) | 2 MiB, profundidade 128, 50.000 nós | Segurança | **Não**: fixo no código; a tela só exibe |
| Tags de bloco | `p, div, section, h1–h4, li, table, tr, td, th, article` | Parser | Não (é capacidade do adaptador) |
| Tags excluídas | `script, style, noscript, template, iframe, object, head` | Segurança | **Não** |
| CONFAZ, classes históricas | `RedaoAnt, RemissoAnt, A8-2RemissaoAnt, A8-3RedacaoAnt` | Perfil CONFAZ | Sim (lista de classes) |
| CONFAZ, classes de nota | `DataPublicao, A2DataPublicacao, Remisso, RemissoAnt, A8-1Remissao, A8-2RemissaoAnt` | Perfil CONFAZ | Sim |
| CONFAZ, texto e título | `TextoAcordo, A5-1TextoAcordo` (texto); `TituloAcordo` (epígrafe); `Ementa` | Perfil CONFAZ | Sim |
| DOU, classes oficiais | `identifica` → epígrafe; `ementa`; `assina`/`cargo` → assinatura | Perfil DOU | Sim |
| DOU, retificação | início de bloco "Onde se lê" / "Leia-se" | Perfil DOU | Sim (marcadores literais) |
| Redação citada | bloco iniciado por `"` ou `“`, fechamento `" (NR)` | Geral | Sim (lista de aspas e de fechos) |
| Preâmbulo | "O Conselho/Ministro/Secretário/Governador/Presidente", "A Secretária/Receita Federal", "CONSIDERANDO" | Geral | Sim (lista de inícios) |
| Marcadores estruturais | ANEXO, Cláusula, Art./Artigo, §/Parágrafo único, inciso romano, alínea `a)` | Geral | Sim (rótulos), sem mudar a gramática |
| Coluna NCM (`identifyNcmPartIds`) | cabeçalho `[CÓDIGO] NCM[/SH]` abre a coluna; `NBM`, `TIPI`, `SH` ou `CÓDIGO` (com ou sem `/…`) a fecham | Perfil por fonte | Sim (rótulos de coluna) |
| Namespace das regras | `reader/v1/<motivo>` | Identidade | Não |

### 1.2 Entidades (`src/modules/anatomy/entities.ts`)

| Item | Valor atual | Configurável? |
|---|---|---|
| Domínios protegidos (antes do NCM) | CITATION, OTHER (identificador de dispositivo), PROCESS (formato e rótulo), CNPJ, CEP, DATE, CNAE, CFOP, CST, CCLASSTRIB, CEST, NBM, SH | Rótulos e abreviações (por exemplo "IN RFB") sim; **padrões de formato, não**: são built-ins versionados |
| Gatilho NCM | rótulo `NCM`/`NCM/SH` + "código(s)/nº" e lista numérica limitada | Rótulos sim; gramática da lista não |
| Tokens permitidos na lista | `até, a, e, ou, exceto, excetuado(s), excluído(s), salvo, exclusive, inclusive, de` e pontuação | Sim (lista fechada) |
| Faixa M01 | operador entre duas pontas, **sem expansão** (`M01_bounded_range_no_expansion`) | Operadores sim; expansão **não** |
| Exceção M02 | marcadores de exceção, escopo conservador (`M02_unknown_scope_conservative_mask` / `M02_scoped_exception`) | Marcadores sim |
| Catálogo NCM | `{ edition, codes }` vindo do pedido | Fora da tela de regras (é dado de referência) |
| Capítulo de 2 dígitos | só informativo (`chapter_informative_only`) | Não (é regra do contrato) |

### 1.3 Preparações e identidade

- **Preparações:** `dou-xml-cdata/1.0.0`, já congelada. `doe-sp-json/0.1.0-provisional` e `rfb-api-original/0.1.0-provisional`, só sintéticas. São adaptadores de formato: **não** são editáveis pela tela.
- **Identidade:** `engineHash` (`ad69d285…`) cobre o código; `ruleSetHash` entra na identidade da análise. Mudar o perfil precisa mudar `ruleSetHash` e invalidar as aprovações jurídicas dependentes, conforme o contrato.

### 1.4 Persistência e permissões existentes

- `anatomy_rule_sets` (id, version, `status ∈ draft/reviewed/retired`, rule_hash, contract_version, `profiles jsonb`, author, reviewer): **só no schema descartável do CI** (`test/support/anatomy-ci-schema.sql`). Não há migration produtiva, nem autorização para ela.
- **Admin de plataforma:** `isPlatformAdmin` / `requirePlatformAdmin` (`src/modules/auth/platform-role.ts`), usado pelo Filtro de Coleta.
- **Curador de taxonomia:** papel de banco separado, com pool próprio (`taxonomy-admin.route.ts`). Não serve para a ANAT, porque o desenho exige não acoplar políticas.
- **Auditoria:** `audit_log` (migration 006): `actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`, `before_data`, `after_data`, `correlation_id`.
- **Padrão de interação a reaproveitar:** o Filtro de Coleta usa `…/preview` → `…/confirm` → `…/save` em `/api/v1/admin/collection-filter/…`.

## 2. Perfil declarativo proposto (`ANAT-PROFILE/1`)

- **Herança curta:** `default` → `source` (CONFAZ, DOU, DOE-SP, RFB) → `family` (por exemplo, "Convênio", "Despacho", "Solução de Consulta"). O valor efetivo é o mais específico.
- **Exceção por ato:** só como correção documentada, vinculada ao hash da entrada, com motivo, e contada no painel para não virar remendo oculto.

```jsonc
{
  "profileVersion": "ANAT-PROFILE/1",
  "scope": { "source": "CONFAZ", "family": null },            // null = perfil da fonte
  "classes": { "historical": ["RedaoAnt", "…"], "editorialNote": ["Remisso", "…"], "body": ["TextoAcordo"],
               "epigraph": ["TituloAcordo"], "summary": ["Ementa"], "signature": [] },
  "blockStarts": { "preamble": ["O Conselho", "CONSIDERANDO"], "rectificationOriginal": [], "rectificationCorrected": [] },
  "quotes": { "open": ["\"", "“"], "close": ["\" (NR)", "”"] },
  "structuralLabels": { "annex": ["ANEXO"], "clause": ["Cláusula"], "article": ["Art.", "Artigo"] },
  "ncmColumnHeaders": ["NCM", "CÓDIGO NCM", "NCM/SH"],
  "notNcmColumnHeaders": ["CÓDIGO", "NBM", "SH", "TIPI"],
  "actAbbreviations": ["IN RFB", "Conv. ICMS"],
  "listTokens": ["até", "a", "e", "ou", "exceto", "salvo"],
  "rangeOperators": ["a", "até"],
  "exceptionMarkers": ["exceto", "excetuado", "salvo", "exclusive"],
  "tablePolicy": { "ambiguousGeometry": "unknown_partial" },   // único valor aceito: conservador e obrigatório
  "examples": [ { "id": "ex-1", "purpose": "coluna NCM/SH", "input": "…html…", "expect": { "parts": [ … ], "entities": [ … ] }, "polarity": "positive" } ]
}
```

**Restrições de segurança (validadas no backend, em falha fechada):**
- só **listas de literais**; nenhum regex livre, JavaScript, SQL ou URL;
- **limites (decisão do COORD):** no máximo 64 itens por campo, de 64 unidades UTF-16 por literal e de 64 KiB por perfil;
- **simulação futura (decisão do COORD):** 2 s por amostra, execução sequencial, até 20 amostras; a amostra que estourar o tempo é marcada como `partial`;
- **política de tabela ambígua (obrigatória):** geometria ambígua sempre vira `unknown` com resultado `partial`; nenhum perfil pode afrouxar isso;
- campos fora do schema são rejeitados;
- os formatos de domínio (CNPJ, CEP, data, NCM 4–8) continuam built-ins versionados com o código e não são editáveis.

**Hash:** `ruleSetHash = SHA-256(canonicalJson(perfis efetivos ordenados))`. Ele substitui o rótulo atual e entra na identidade de cada análise.

## 3. Ciclo de vida das versões

```
rascunho ──simular/comparar──▶ rascunho (com resultados) ──revisar──▶ revisado ──ativar──▶ ATIVO
    ▲                                                                                 │
    └──────────── nova versão a partir de qualquer revisão ◀────── retornar ◀─────────┘
                                                        (reativa a versão anterior; nada é apagado)
ATIVO ──substituído──▶ retirado (somente leitura)
```

- **Uma versão ativa por escopo.** Uma versão ativada é **imutável**: corrigir significa criar uma nova versão.
- **Retorno:** reativa a versão anterior e os resultados dela, mantendo o histórico da nova. Não apaga análises. **Retornar a uma versão não reaprova evidências jurídicas:** aprovações de vigência ficam presas ao hash de entrada e de trecho, e qualquer análise cuja identidade mude por causa do retorno volta a depender de conferência própria.
- **Revisão:** o revisor precisa ser diferente do autor, a regra usada no gold. O revisor registra fundamento e a decisão sobre cada diferença da comparação.
- **Ativar não reprocessa nada.** A tela mostra o **escopo afetado** (fontes, famílias e representações cujo `ruleSetHash` muda; contagem de publicações). O reprocessamento é uma operação separada e autorizada, já prevista em `anatomy_runs`.
- **Estrutura não decide direito:** mudar uma regra de estrutura nunca aprova situação jurídica. A conferência de vigência é outra tela, com outra trilha.

## 4. Telas

São oito telas, todas restritas a administrador de plataforma (seção 5). Os textos abaixo são wireframes descritivos.

**T1. Perfis e versões.** Lista por escopo (geral, fonte, família), mostrando versão ativa, rascunhos, autor, revisor, data, `ruleSetHash` abreviado e contagem de exceções por ato. Ações: "Nova versão a partir de…" e "Ver histórico".

**T2. Editor de rascunho.** Formulário por seção do perfil (classes, inícios de bloco, aspas, rótulos estruturais, colunas NCM, abreviações, tokens, operadores, exceções, política de tabela). Cada campo:
- mostra o valor herdado e o efetivo;
- valida limites na hora;
- tem ajuda com o efeito esperado.

Não há campo de regex. Ações: "Salvar rascunho" e "Descartar".

**T3. Exemplos da regra.** Para cada ajuste: nome legível, finalidade, escopo e exemplos positivos e negativos com o resultado esperado. Os exemplos rodam a cada simulação e **complementam, mas não substituem** o corpus de referência ou as métricas.

**T4. Simulação.**
- **Amostras:** escolha apenas no **conjunto de desenvolvimento** congelado (hoje 01, 02, 03, 05, 07, 10, 11) e nos exemplos da regra. A **reserva nunca aparece na lista**, e o backend rejeita os IDs dela.
- **Resultado:** para cada amostra, mostra o texto com trechos reconhecidos ou ignorados, a regra responsável (`ruleId`), conflitos, limitações e cobertura.

**T5. Comparação antes/depois.** Mesmo snapshot de entrada, duas versões identificadas pelo hash. Mostra:
- partes criadas, removidas ou reclassificadas;
- NCMs e citações acrescentados ou removidos;
- mudanças na seleção elegível, com motivos.

Cada diferença precisa ser marcada pelo revisor como **esperada**, **regressão** ou **não avaliada**. Uma queda de contagem não é bloqueada automaticamente, e um aumento não é aceito automaticamente. Falha em caso crítico ou em exemplo da regra bloqueia a revisão. Quando a entrada ou a evidência também mudou, a tela destaca isso em vez de atribuir a diferença à regra.

Se houver gold aprovado para a amostra, a tela exibe as métricas do avaliador (`evaluateEntry`) como **informação de desenvolvimento**, sem gate e sem jamais usar a reserva.

**T6. Revisão.** Um revisor diferente do autor confere as decisões de T5, registra o fundamento e aprova ou devolve. Fica gravado no `audit_log`.

**T7. Ativação.** Mostra:
- o escopo afetado;
- o impacto estimado (número de publicações cujo hash muda);
- o aviso "ativar não reprocessa";
- a confirmação em duas etapas (preview → confirm), no padrão do Filtro de Coleta.

**T8. Histórico, retorno e auditoria.** Linha do tempo das versões, com diferença entre versões, quem fez o quê e quando, e a ação "Retornar a esta versão", que passa pela mesma confirmação da T7.

**Exemplos de manutenção** (casos de aceite da tela):
1. Acrescentar `NCM/SH` aos rótulos de coluna do CONFAZ.
2. Reconhecer uma nova classe editorial CONFAZ como nota histórica.
3. Adicionar a abreviação `IN RFB`.
4. Mudar a política de confiança em células mescladas.

Cada um deve mostrar a diferença em T5 e o escopo de reprocessamento em T7.

## 5. Permissões e auditoria

| Ação | Quem | Mecanismo existente |
|---|---|---|
| Ver perfis, histórico e auditoria | Admin de plataforma | `requirePlatformAdmin` |
| Criar e editar rascunho, simular, comparar | Admin de plataforma (autor) | `requirePlatformAdmin` |
| Revisar e aprovar | Admin de plataforma **diferente do autor** | `requirePlatformAdmin` + checagem autor ≠ revisor no backend |
| Ativar e retornar | Admin de plataforma; a política (autor, revisor ou terceiro) é **decisão do COORD** | `requirePlatformAdmin` + confirmação em duas etapas |
| Reprocessar | Operação autorizada, fora desta tela | `anatomy_runs`, em fase futura |
| Usuário de tenant ou curador de taxonomia | **Sem acesso** | — |

Toda mutação grava em `audit_log`:
- `entity_type = 'anatomy_rule_set'`;
- `action ∈ {DRAFT_SAVED, SIMULATED, REVIEWED, ACTIVATED, ROLLED_BACK, RETIRED}`;
- `before_data` e `after_data` com hash e diferença;
- `correlation_id` da operação.

## 6. Necessidades de backend e de frontend

**Backend** (repositório atual; nada disso foi implementado):
1. `src/modules/anatomy/profile.ts`: schema `ANAT-PROFILE/1`, validação com limites, resolução da herança, `ruleSetHash`.
2. **Refatoração do leitor e do extrator** para receber o perfil efetivo em vez de constantes. O perfil padrão precisa reproduzir **exatamente** o comportamento atual (ver P1).
3. Serviços puros de **simulação** (motor + avaliador sobre amostras de desenvolvimento) e de **comparação** (diferença entre dois `AnatomyResult` do mesmo snapshot), reaproveitando `evaluation.ts` e o adaptador.
4. **Persistência:** migration produtiva de `anatomy_rule_sets`, mais uma tabela de exemplos/decisões ou uma coluna JSONB de revisão. **Exige autorização específica.**
5. **API** em `/api/v1/admin/anatomy-rules/…`:
   - `GET` perfis e versões;
   - `POST draft`, `PUT draft`;
   - `POST simulate`, `POST compare`;
   - `POST review`;
   - `POST activate/preview`, `POST activate/confirm`;
   - `POST rollback/preview`, `POST rollback/confirm`;
   - `GET history`.

   Todas com `requirePlatformAdmin`.
6. **Cálculo de escopo afetado:** contagem de publicações por fonte e família cujo `ruleSetHash` mudaria, sem disparar reprocessamento.

**Frontend:** o repositório do frontend **não está neste workspace**, então a implementação depende de acesso a ele. Seriam necessários:
- as oito telas;
- componentes de diferença de texto com spans, de lista editável com limites e de painel de impacto;
- reaproveitamento dos componentes de confirmação do Filtro de Coleta.

## 7. Plano de implementação (proposta; cada fase precisa de autorização própria)

| Fase | Entrega | Critério de aceite | Dependências |
|---|---|---|---|
| **P1.A** Schema e resolução pura dos perfis (**autorizada**) | `profile.ts`: validação, limites, herança, perfil efetivo, hash determinístico; perfis padrão extraídos das constantes atuais | Só testes sintéticos. **Sem integração ao motor**, sem alteração de contrato, `engineHash` ou golds | Branch e PR próprios |
| **P1.B** Perfil padrão no motor | Leitor e extrator recebendo o perfil efetivo | Nas 7 entradas de desenvolvimento e em todos os testes sintéticos, **o comportamento estrutural é o mesmo** (partes, spans, contextos, entidades, relações, seleções e limitações). **Os hashes derivados mudam necessariamente:** `engineHash`, `ruleSetHash`, `analysisId` e `outputHash`. Por isso a comparação é feita sobre o conteúdo, excluindo campos de identidade, e a mudança de hashes é registrada de forma explícita. Os 7 golds e suas aprovações não mudam, porque não dependem desses hashes | Autorização do COORD (muda o motor) |
| **P2** Simulação e comparação puras | Serviços puros e testes sintéticos | Diferença classificada; reserva rejeitada pelo ID; limites de perfil e de tempo testados | P1 |
| **P3** Persistência e API | Migration produtiva, rotas admin, `audit_log` | Testes de integração em banco descartável; autor ≠ revisor; ativação sem reprocessar; retorno sem apagar | **Autorização de migration produtiva** |
| **P4** Telas | T1–T8 no frontend | Os quatro exemplos de manutenção da seção 4 executados de ponta a ponta em ambiente de teste | Acesso ao repositório do frontend e P3 |
| **P5** Integração com reprocessamento | Disparo autorizado via `anatomy_runs`, fora da tela | Reprocessamento seletivo por escopo e hash | Fase operacional futura |

**Aceite da Fase 1, item "tela":** P1 a P4 concluídos, com os quatro exemplos de manutenção demonstrados e auditados, e permissões e reserva testadas. P5 não faz parte do aceite da tela.

## 8. Decisões do COORD (19/10/2026)

Registradas na [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6260137987).

1. **Ativação:** admin de plataforma, depois de revisão independente vinculada ao **hash exato** da versão. Alterar o conteúdo invalida a aprovação.
2. **Perfis:** padrão geral e por fonte. A herança por família continua suportada, mas sem especializações desnecessárias no início.
3. **Limites iniciais:** 64 itens por campo, 64 unidades UTF-16 por literal, 64 KiB por perfil. Simulação futura: 2 s por amostra, sequencial, até 20 amostras.
4. **Métricas:** diagnósticas na comparação. A execução sobre o corpus exige autorização específica.
5. **Migration:** a preparação e os testes isolados podem fazer parte de um pacote posterior. A aplicação produtiva continua **não autorizada**.
6. **Próxima atividade autorizada:** P1.A, em branch e PR próprios.

A **tela continua obrigatória na Fase 1**.

**Limites mantidos:** sem código de produto, migration, abertura da reserva, medição, merge ou deploy. A recaptura dos 18 originais continua pendente da autorização do Fábio e não bloqueia este documento.
