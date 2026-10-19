# ANAT P1.B — perfis integrados ao leitor, ao extrator e ao motor

Origem: COORD → CLAUDE-EXEC, autorização de 19/10/2026 ([issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6260474445)). Branch próprio `feat/anat-p1b-engine-profiles`, dependente do PR #248 (P1.A). Desenho em [ADMIN-01.md](ADMIN-01.md); schema em [profile.md](profile.md).

**Escopo cumprido:**
- perfis ligados ao leitor, ao extrator e ao motor;
- identidade e `engineHash` atualizados de forma explícita;
- equivalência e efeitos demonstrados **só com testes sintéticos**;
- golds, aprovações e proteções fixas preservados.

**As sete entradas reais não foram analisadas pelo motor nesta etapa;** isso depende de autorização posterior. Ver a seção 5 sobre os testes de regressão que já existiam.

## 1. O que mudou

- **`src/modules/anatomy/profile-rules.ts`** (novo): `compileProfileRules(efetivo, fonte)` transforma o perfil efetivo nos casadores usados pelo motor; `defaultRules(fonte)` compila os `DEFAULT_PROFILES`. Os literais são sempre escapados. A gramática em volta deles é fixa: numeração depois de um rótulo, fronteiras de palavra, lista numérica, `§` exigindo número.
- **Leitor (`readers.ts`):**
  - `readAnatomyInput` aceita `rules`, e o padrão é `defaultRules(source)`. Regras compiladas para outra fonte são recusadas com `TypeError`.
  - As constantes de classes, aspas, preâmbulo, retificação, rótulos e cabeçalhos/bloqueadores NCM agora vêm do perfil.
  - `identifyNcmPartIds(resultado, rules)`.
- **Extrator (`entities.ts`):** marcador NCM, tokens de lista, operadores de faixa e marcadores de exceção vêm do perfil (`rules`).
- **Motor (`engine.ts`):**
  - o pedido aceita `profiles` (opcional; o padrão é `DEFAULT_PROFILES`) e `family` (opcional);
  - o perfil efetivo é resolvido em falha fechada (`ProfileValidationError`), compilado e repassado ao leitor e ao extrator.
- **Identidade:**
  - `ruleSetHash` deixa de usar o rótulo fixo `profile: 'conservative/0.1.0'` e passa a usar `{ format: 'ANAT-PROFILE/1', effectiveHash }`;
  - `profile.ts` e `profile-rules.ts` entram na identidade da build;
  - **`engineHash` vai de `ad69d285…` para `8b2eefbb2f4d051934f8aeea9b80078adcd58bccfa4ebb9a0430cc4fe10fe638`.**

  Como previsto no ADMIN-01, `ruleSetHash`, `analysisId` e `outputHash` mudam necessariamente.
- **Contrato (`contract.ts`):** inalterado.

## 2. Semântica fixa por fonte (não configurável)

- **CONFAZ:**
  - classes valem no bloco **e nos descendentes**;
  - as classes de epígrafe, ementa, histórico e nota também alimentam a **zona herdada no DOM** e o histórico de célula;
  - motivos: `confaz_epigraph`, `confaz_summary`, `confaz_editorial_note`, `confaz_text_class` e `confaz_historical_wording`.
- **DOU, DOE-SP e RFB:**
  - classes valem só no **próprio bloco**;
  - o motivo carrega o nome da classe (por exemplo, `dou_identifica`, `dou_assina`);
  - classes não criam zona herdada no DOM.
- **Retificação:** vale para qualquer fonte cujo perfil tenha inícios de bloco de retificação; nos perfis padrão, só o DOU. O motivo é `<fonte>_rectification_*`.
- **Gramática interna:** numeração de inciso e de alínea.
- **Proteções fixas (fora do perfil):**
  - padrões de domínio protegido: CITATION, PROCESS, CNPJ, CEP, DATE, CNAE, CFOP, CST, cClassTrib, CEST, NBM, SH, TIPI, código de receita, SUS;
  - limites de tamanho e complexidade e tags excluídas;
  - política conservadora de tabela ambígua;
  - continuação de lista dentro da exceção e vínculo `NCM` antes do alvo;
  - capítulo de 2 dígitos só informativo;
  - elegibilidade sempre negativa sem evidência aprovada.

## 3. Equivalência do perfil padrão

1. **Snapshot estrutural antes e depois.** Em 12 documentos sintéticos (`test/support/anatomy-synthetic-docs.ts`), cobrindo todas as regras movidas para o perfil e as proteções fixas, a saída do motor **sem** `identity`, `analysisId` e `outputHash` foi congelada **antes** da integração. Isso está no commit `ab9f9f4`, gerado com o `src` idêntico ao de `585f5a49`. Depois da integração, a saída é **idêntica** nos 12 documentos: partes, spans, contextos, motivos, entidades, relações, seleções, cobertura e limitações.
2. **Diferencial contra o oráculo.** As 20 regex originais foram copiadas literalmente de `585f5a49` para `test/support/anatomy-legacy-rules.ts` (a cópia foi conferida contra `git show`). Cada casador compilado do perfil padrão é comparado com a regra original numa bateria de variantes: maiúsculas e minúsculas, espaços, tabulação, letra ou dígito colado, pontuação, prefixos. **Resultado: idêntico em todas as regras, exceto as diferenças deliberadas do preâmbulo:**
   - **Fronteira de palavra no fim do início de bloco:** a regra original só exigia fronteira depois de `CONSIDERANDO`; agora todo início de bloco termina em fronteira. Exemplo: `O Conselhox` deixa de ser preâmbulo.
   - **Espaço interno flexível:** cada espaço num literal aceita qualquer sequência de espaços. A regra original tinha um espaço literal em `Receita Federal`, então `A  Receita  Federal` e `A\tReceita\tFederal` passam a ser preâmbulo.

   Essas são as **únicas** diferenças encontradas, e o teste exige exatamente essa lista. Nenhuma ocorre nos 12 documentos sintéticos.
3. **Classes:** os conjuntos CONFAZ compilados são exatamente as alternâncias originais; o escopo é `subtree` no CONFAZ e `own` nas demais fontes.

## 4. Efeitos das configurações (sintético)

Cada campo editável muda o motor da forma configurada:
- uma nova classe histórica CONFAZ torna histórica a cláusula;
- uma nova classe de assinatura DOU gera `signature:dou_assinatura2`;
- um novo cabeçalho de coluna (sem a palavra NCM) abre a coluna para códigos;
- um novo token de lista estende a lista NCM;
- um novo operador de faixa cria uma faixa limitada, **sem expansão**;
- um novo marcador de exceção cria uma composta de exceção;
- um novo início de bloco cria um preâmbulo em zona proibida;
- um perfil de família só se aplica quando o pedido informa essa família.

**Identidade:**
- o mesmo perfil efetivo, em qualquer ordem, gera o mesmo `ruleSetHash`;
- mudar o perfil muda `ruleSetHash` e `analysisId`;
- `identity.engineHash` é o novo hash da build.

**Proteções e falha fechada:**
- perfis com política de tabela afrouxada ou campo de domínio são recusados;
- domínios protegidos continuam vencendo uma lista NCM, mesmo com tokens extras (CNPJ e processo);
- epígrafe com NCM não gera ocorrência;
- `script` continua excluído;
- geometria ambígua continua `unknown`/`partial`;
- nenhuma seleção fica elegível;
- perfis inválidos, perfil efetivo conflitante (cabeçalho bloqueado) e regras compiladas para outra fonte são rejeitados.

## 5. Validação e o que **não** foi feito

- `npm run test:anatomy`: **139/139**; `tsc --noEmit` e `npm run build`: OK; identidade verificada (`8b2eefbb…`); snapshot sintético verificado.
- **Golds, especificações, aprovações e contrato:** diferença vazia em relação a `585f5a49`.
- **Testes que já existiam e tocam as entradas de desenvolvimento:** `test:anatomy` já incluía a verificação do **texto canônico** congelado (`dev-canonical`) e a reprodutibilidade dos golds. Ambos usam o leitor só para extrair o **texto** das 7 entradas de desenvolvimento, que continua idêntico. **Nenhuma comparação estrutural do motor com essas entradas foi feita** nem relatada.
- Sem medição, reserva, recaptura, migration, endpoint, tela, merge ou deploy.
