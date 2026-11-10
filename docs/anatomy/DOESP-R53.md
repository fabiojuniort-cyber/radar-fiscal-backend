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

## R5.5 — cláusula final do ato

**Caso novo do COORD:** um conteúdo normativo final com aparência de nome, num `div` próprio, depois de um artigo comum terminado em ponto e sem as palavras da guarda. Exemplo: "…o programa de atenção primária." + `div` "PROGRAMA ESTADUAL DE SAÚDE". O motor `5087b949` **reproduziu o falso fecho**.

**Correção estrutural:** o último dispositivo precisa ser a **cláusula final do ato**, de vigência ou de revogação (LC 95/98, arts. 3º, III, 8º e 9º). Depois dela não vem conteúdo normativo. Sem ela, o vínculo ao artigo fica.
- A comparação ignora caracteres de formatação invisíveis, como o U+00AD em "vi­gor" do 70.226. O texto canônico fica intacto.

**Testes R5.5:**
- A e B em linha solta e em `div`, com **vínculo** e **seleção** verificados separadamente: verdadeiros nas 4 variantes;
- o caso novo fica vinculado e selecionável;
- o fecho acontece depois da cláusula de vigência **ou** de revogação, e não acontece sem cláusula final.

Identidade `5087b949 → 9f45b30f`. Regressão em 78 leituras contra `fc04aae`: só o 70.226 muda.

## R5.6 — a vigência ou a revogação precisa ser a função do dispositivo

**Recheck do COORD:** a expressão do R5.5 também casava com "O programa que entra em vigor em janeiro terá a denominação aprovada neste artigo.". Reproduzido no leitor completo (`dec748d`): o `div` "PROGRAMA ESTADUAL DE SAÚDE" virava assinatura.

**Correção:** depois do rótulo do dispositivo, o texto precisa **começar** pela cláusula, por uma de duas formas:
- vigência com o próprio ato como sujeito ("Este decreto / Esta resolução / O presente … entra em vigor / produz(irá) efeitos / vigorará");
- fórmula de revogação ("Revogam-se…", "Fica(m) revogado(s)…").

**Testes R5.6:**
- o caso do COORD fica vinculado e selecionável;
- 3 frases com a expressão no meio não fecham;
- vigência (decreto ou resolução, "entra em vigor" ou "produzirá efeitos") e revogação ("Revogam-se", "Fica revogado") fecham;
- o Decreto 70.226 fica inalterado nas duas representações.

Identidade `9f45b30f → 87c46320`. Regressão em 78 leituras contra `fc04aae`: só o 70.226 muda.

## R5.7 — o ato é imediatamente o sujeito da vigência

**BLOCK do revisor:** "Este decreto que entra em vigor em janeiro aprova a denominação do programa." e "Este decreto cujo programa entra em vigor…", seguidos de `div` "PROGRAMA ESTADUAL DE SAÚDE", fechavam como assinatura no motor `87c46320`. O intervalo de até 3 palavras entre o ato e o verbo aceitava "que" e "cujo programa".

**Correção:** entre o ato e o predicado só cabe o **número do próprio ato** ("Este Decreto nº 70.226 entra em vigor…"). Qualquer outra palavra, como uma oração relativa ou um adjunto, significa que o predicado pertence a outra coisa, e o vínculo ao artigo fica.

**Testes R5.7:**
- 3 variantes (com "que", "cujo programa" sem vírgula e "cujo programa" com vírgulas) ficam vinculadas e selecionáveis;
- positivos preservados: "Este decreto entra em vigor", "Este Decreto nº 70.226 entra em vigor" e "A presente resolução produzirá efeitos";
- Decreto 70.226 inalterado nas duas representações.

Identidade `87c46320 → e0074a7d`. Regressão em 78 leituras contra `fc04aae`: só o 70.226 muda.

## R5.8 — o dispositivo inteiro precisa ser a cláusula de encerramento

**Caso do COORD:** "Este decreto entra em vigor na data de sua publicação e dá ao programa de atenção primária a denominação constante deste artigo." + `div` "PROGRAMA ESTADUAL DE SAÚDE". Reproduzido em `c18247e`: vínculo não, seleção não, vira `signature`.

**Correção:** o dispositivo **inteiro** precisa ser a cláusula de encerramento.
- **Vigência:** depois do predicado, só pode vir um complemento de tempo (sem "e", ";" ou vírgula interna), opcionalmente com uma revogação anexa (", ficando revogad…").
- **Revogação:** sem ";" e sem "e" / "bem como" seguido de outro verbo dispositivo.
- Qualquer outra disposição ou ambiguidade preserva o vínculo e a seleção.

**Testes R5.8:**
- 4 dispositivos mistos ficam vinculados e selecionáveis: "e dá…", ";", ", e fica denominado…" e revogação "… e fica denominado…";
- positivos preservados: vigência com "na data de sua publicação, ficando revogadas…", vigência "a partir de 1º de janeiro de 2026" e revogação em lista ("Decretos nº 1… e nº 2…");
- contracasos anteriores mantidos;
- Decreto 70.226 inalterado nas duas representações.

Identidade `e0074a7d → c1b0a56d`. Regressão em 78 leituras contra `fc04aae`: só o 70.226 muda.

## R5.9 — gramática positiva da cláusula de encerramento (substitui as listas de exceção do R5.5 ao R5.8)

**BLOCK do revisor na R5.8:** dois casos continuavam fechando no leitor completo.
- "Este decreto entra em vigor na data de sua publicação. O programa … passa a denominar-se…": vigência seguida de uma segunda frase.
- "Fica revogado o Decreto nº 1, de 2020, passando o programa a denominar-se…": revogação seguida de uma disposição no gerúndio.

A causa de fundo era a abordagem: as regras anteriores listavam o que **não** é encerramento, e essas listas são sempre incompletas.

**Correção:** o dispositivo **inteiro**, como uma única frase, precisa casar com uma das duas formas abaixo. Fora delas, vínculo e seleção ficam.
- **Vigência:** "Este/Esta/O presente/A presente <ato> [nº N]" + "entra em vigor" / "produz(irá) [seus] efeitos" / "vigorará" + um **tempo** de lista fechada ("na data de sua publicação", "a partir de <data | publicação>", "em <data>", "N (extenso) dias após a data de sua publicação"). Opcionalmente, ", ficando revogad… (as disposições em contrário | <lista de atos>)". Ponto final.
- **Revogação:** "Revogam-se / Fica(m) revogad…" + ("as disposições em contrário" | <lista de atos com nº e data>), opcionalmente com tempo. Ponto final.

**Testes R5.9:**
- os 4 casos do revisor e suas variantes ficam vinculados e selecionáveis;
- **teste sistemático:** 10 cláusulas de encerramento válidas fecham, e cada uma acrescida de 5 disposições extras (frase seguinte, gerúndio, "e dá…", ";", ", devendo…"), ou seja, **50 combinações**, preserva vínculo e seleção;
- todos os contracasos anteriores (A/B, R5.5 a R5.8) mantidos;
- Decreto 70.226 inalterado nas duas representações.

Identidade `c1b0a56d → 398c8620`. Regressão em 78 leituras contra `fc04aae`: só o 70.226 muda.

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
