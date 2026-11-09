# DOE-SP — fecho de assinaturas e célula Decreto × pequeno (E9-ACERVO-01 R5.3)

Origem: COORD → EXEC, tribusca-control#116, R5.3. Usa só a amostra preservada `doesp-p2d/fdb81d5f-3876-468a-70bc-08de3f1ee1ea.json` (Decreto 70.226/2025, SHA-256 `16c7fe4a…`). Nenhuma requisição; o grant `E9-P2d-G1` está suspenso.

## Defeito reproduzido
No motor `0e009431`, as duas assinaturas ("TARCÍSIO DE FREITAS" e "Arthur Luis Pinho de Lima") eram blocos não identificados **dentro** do caput do Art. 3 (`caput_continuation`). Com isso, o Art. 3 e o caput dele terminavam no fim do documento, e a seleção candidata do Art. 3 (1384–1527) cobria as assinaturas.

## R5.4 — BLOCK do COORD em `d4521f8` e regra corrigida

O COORD reproduziu dois falsos fechos: (A) "Artigo 1º - Fica designada para a função a servidora identificada abaixo." + "MARIA DE SOUZA"; (B) "…com a denominação indicada abaixo." + "PROGRAMA ESTADUAL DE SAÚDE". Posição final, ponto anterior e aparência de nome **não bastam**.

**Evidência estrutural positiva exigida:**
- os 1 a 4 blocos finais ficam juntos num **contêiner próprio** (`div` ou `section`);
- esse contêiner não tem nenhum outro bloco nem nenhum dispositivo;
- ele vem depois do último dispositivo e não o contém.

No Decreto 70.226 isso vale nas duas representações. No JSON oficial, os 7 parágrafos do ato são filhos diretos do `body` e as assinaturas ficam em `body/div`. O sanitizador do Acervo mantém o `div`.

**Guardas conservadoras adicionais:** linha de nome; ponto final no último dispositivo; nenhum anúncio de conteúdo seguinte ("abaixo", "a seguir", "seguinte(s)", "em anexo", `:`). Na dúvida, a linha fica vinculada ao dispositivo.

**Testes:**
- A e B, em linha solta **e** dentro de `div` próprio, seguem no artigo e na seleção operativa;
- nomes sem contêiner não fecham;
- um contêiner com dispositivo não fecha;
- o caso positivo com contêiner fecha, só na fonte DOE-SP.

Identidade `dff55ce1 → 5087b949`. Regressão em 78 leituras com a saída sem identidade, contra `fc04aae`: só o 70.226 muda.

## Regra (R5.3; condições estruturais acima, a partir do R5.4)
A regra é estrutural e não usa classes, porque a cópia do Acervo não as tem. Ela só se aplica quando **todas** as condições valem:
1. O documento **termina** com 1 a 4 blocos `unidentified/unknown`, todos depois do início do último dispositivo (a cauda nunca atravessa a fronteira de um dispositivo).
2. Cada bloco é uma linha de nome: só letras, espaços, `.`, `'` e `-`; de 2 a 8 palavras; pelo menos 2 maiúsculas; sem dígitos; sem `.`, `;`, `:` ou `,` final.
3. A última linha do dispositivo antes deles termina em **ponto**. Um `:` indica que vem mais conteúdo.

Quando a regra se aplica:
- os blocos passam a `signature/prohibited`, filhos do documento (`doe_sp_closing_signature`, `recognition: inferred`);
- o artigo e o caput terminam no fim do último bloco que lhes pertence;
- o texto canônico, os spans das assinaturas e o source map ficam inalterados.

Se qualquer condição falhar, a leitura anterior é mantida.

## Prova
- `test/anatomy.doesp-closing-signature.unit.test.ts`:
  - **JSON oficial:** Art. 1 + § único, Art. 2 e Art. 3 completos; o Art. 3 e o caput terminam antes das assinaturas; as assinaturas ficam fora de todo artigo, caput e seleção candidata e são rastreáveis ao bloco de origem.
  - **Equivalente do Acervo:** a mesma estrutura, com posições = oficial − 8.
  - **Contracasos:**
    - nome ou linha em maiúsculas **dentro** de um artigo, seguido de texto ou de outro dispositivo;
    - `:` antes dos nomes;
    - linha com dígitos ou pontuação;
    - mais de 4 linhas;
    - palavra única;
    - a mesma entrada lida como DOU.
- **Regressão:** a saída sem identidade foi comparada, motor antigo × novo, em 78 leituras: RFB ×10, DOE-SP ×2, HTML preservados × 3 perfis e 48 combinações de documentos sintéticos por perfil. **Só a amostra 70.226 mudou.** Nas demais fontes o delta é só de hash (`engineHash` `0e009431 → dff55ce1`).

## Célula DOE-SP × Decreto × pequeno
- A amostra entra na matriz pela preparação `prepareDoeSpRepresentation` (`doe-sp-json/0.1.0-provisional`) com o perfil DOE-SP.
- `validated` é derivado: linha de base (`official-samples-baseline.json`) **e** invariantes DOE-SP:
  - sem fallback do leitor;
  - nada elegível;
  - nenhuma seleção candidata sobre texto não identificado, proibido ou assinatura;
  - assinaturas `prohibited` e fora de artigos e caputs operativos.
- Drift, linha de base ausente ou fallback desvalidam (testado).
- O Decreto 70.225 (grande) não é lido (`input_size_limit`) e não conta.

**Limitações explícitas (permanecem):**
- a ementa ("Autoriza a outorga…", 173 caracteres) e "Decreta:" (9) seguem `unidentified/unknown`;
- nenhuma das duas é seleção candidata (invariante);
- `unidentified_content` fica registrado e o status é `partial`.

**Para o recheck independente:** o escopo da preparação provisória. Ela usa o `content` sem alteração e o `title` só como metadado. Ela foi conferida agora contra os dois JSON reais capturados (identidade, data, `content`), mas continua marcada como provisória até o parecer.

**Pendente:** tachado em amostra oficial, porque nenhum dos dois atos o contém. Aceite: COORD.
