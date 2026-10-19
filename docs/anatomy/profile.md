# ANAT P1.A — schema e resolução pura dos perfis de regras (`ANAT-PROFILE/1`)

Origem: COORD → CLAUDE-EXEC, autorização de 19/10/2026 ([issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6260137987)). Branch próprio `feat/anat-p1a-profiles`, criado sobre `feat/anat-04-core` (PR #244). Desenho completo em [ADMIN-01.md](ADMIN-01.md).

**Escopo:** funções puras em `src/modules/anatomy/profile.ts`, testadas só com dados sintéticos. **Não houve integração ao motor:** `readers.ts` e `entities.ts` continuam com as próprias constantes. Contrato, `engineHash` (`ad69d285…`) e os sete golds aprovados ficaram como estavam. A integração é a fase P1.B, que precisa de autorização própria.

## O que está implementado

- `validateProfile(valor)`: valida um perfil e falha de modo fechado (`ProfileValidationError` com código).
  - **Formato:** `profileVersion: 'ANAT-PROFILE/1'`; `scope` é `default`, `source` (CONFAZ, DOU, DOE-SP, RFB) ou `family` (fonte + nome).
  - **Campos** (só listas de literais): `classes.{historical, editorialNote, body, epigraph, summary, signature}`, `blockStarts.{preamble, rectificationOriginal, rectificationCorrected}`, `quotes.{open, close, closeSuffix}`, `labels.{annex, clause, article, paragraph}`, `ncm.{markers, columnHeaders, columnBlockers}`, `lists.tokens`, `ranges.operators` e `exceptions.markers`.
  - **Política de tabela:** `table.ambiguousGeometry` aceita **só** `unknown_partial`. A política conservadora para tabelas ambíguas é obrigatória.
  - **Limites (decisão do COORD):**
    - no máximo 64 itens por campo;
    - de 1 a 64 **unidades UTF-16** por literal (um emoji conta como 2);
    - perfil de até 64 KiB, medido em bytes UTF-8 do JSON canônico.
  - **Literais:** sem caracteres de controle, sem espaço no início ou no fim, sem duplicatas no mesmo campo. Grupos e campos desconhecidos são rejeitados (não há campo de regex, código ou URL).
  - O perfil `default` precisa definir todos os campos. Os perfis `source` e `family` podem sobrescrever qualquer subconjunto.
- `resolveEffectiveProfile(perfis, { source, family? })`: herança curta `default → source → family`.
  - **Sobrescrita por campo:** uma lista presente num perfil mais específico substitui a herdada inteira; um campo omitido é herdado; lista vazia significa "nenhum".
  - Exige exatamente um `default` e no máximo um perfil por escopo. Uma família sem perfil de fonte herda direto do `default`.
  - **Devolve:**
    - `fields` completos;
    - `chain`, os perfis aplicados com o próprio `profileHash`;
    - `effectiveHash`.
- **Hashes determinísticos:**
  - `profileHash` = SHA-256 do JSON canônico do perfil validado. A ordem das chaves não importa.
  - `effectiveHash` = SHA-256 de `{ profileVersion, fields }`, ou seja, do **comportamento**. A mesma configuração efetiva dá o mesmo hash, venha de qualquer cadeia. A cadeia fica registrada à parte, para auditoria.
  - A ordem dentro de uma lista é conteúdo e muda o hash.
- `PROFILE_FIELD_SEMANTICS`: a semântica de casamento de cada campo (prefixo de bloco sem diferenciar maiúsculas, classe CSS exata etc.). É fixa, **não é editável por perfil** e serve de referência para o P1.B.
- `DEFAULT_PROFILES`: perfis `default`, `source:CONFAZ` e `source:DOU` **extraídos das constantes atuais** de `readers.ts` e `entities.ts` (SHA `d57a7a94`). As variantes de acento e grafia que as regex atuais aceitam aparecem como literais explícitos (por exemplo, `O Secretário`/`O Secretario`, `Cláusula`/`Clausula`, `CÓDIGO NCM`/`CODIGO NCM`).

## Testes (`test/anatomy.profile.unit.test.ts`, 8 testes)

- **Perfis padrão:** validam e resolvem para as quatro fontes; o CONFAZ herda do `default`; o DOE-SP fica só com o `default`.
- **Herança:** a família prevalece; a sobrescrita da fonte se mantém; o restante vem do `default`; família sem perfil de fonte funciona; lista vazia é aceita; a entrada não é alterada.
- **Hashes:** independem da ordem dos perfis e das chaves; mudam quando um literal ou a ordem de uma lista muda; mesmo comportamento por cadeias diferentes dá mesmo `effectiveHash` com `chain` diferente.
- **Limites:** 64/65 itens; 64/65 unidades UTF-16; 32/33 emojis; perfil acima de 64 KiB.
- **Falha fechada:** caractere de controle, quebra de linha, espaços nas bordas, literal vazio, duplicata, tipo errado, grupo ou campo desconhecido, política de tabela afrouxada, versão errada, chave extra, fonte inválida, família vazia, `default` incompleto.
- **Resolução:** sem `default`, `default` duplicado, fonte ou família duplicada, alvo inválido, item que não é perfil.
- **Fidelidade às constantes atuais** (lidas como texto-fonte, sem importar nem alterar o motor):
  - as listas de classes CONFAZ (históricas, notas, texto) são **exatamente iguais** às alternâncias das regex do leitor;
  - as classes DOU aparecem no leitor;
  - cada literal padrão de preâmbulo, retificação, cabeçalho e bloqueio de coluna NCM, rótulos estruturais, tokens de lista, operadores de faixa, marcadores de exceção, marcadores NCM, aspas e sufixo `(NR)` é **aceito pela regra atual** de onde foi extraído.

## Limites e próximos passos

- Os perfis ainda **não mudam o comportamento** do motor. O P1.B vai ligar o leitor e o extrator ao perfil efetivo. Nessa fase o comportamento estrutural precisa ser preservado, e os hashes derivados (`engineHash`, `ruleSetHash`, `analysisId`, `outputHash`) vão mudar necessariamente.
- Os testes de fidelidade checam **solidez** (todo literal padrão é aceito pela regra atual) e, nas listas de classes, **igualdade**. Nas regras que hoje são regex com variações gramaticais (por exemplo, numeral romano de inciso), a gramática continua built-in e fora do perfil.
- Sem migration, endpoint, tela, medição, reserva, merge ou deploy.
