# E9-MOTOR R4

Base R3 `9c717590`, motor `7b7260b2`. Candidato R4 `a1a05c52d12fea0b2b458193609950112e57a656fd8231c7c5c201df892a0ccf`.

| Amostra | Leitura R3 → R4 | Alteração |
| --- | --- | --- |
| M26 | 129 → 0 caracteres não identificados | Assinatura presidencial identificada como proibida para seleção e título isolado de anexo ligado às tabelas. |
| http:M4 | 1.529 → 0 caracteres não identificados | Título e instruções de apêndice reconhecidos no anexo comprovado do HTML Plone, com contexto não operativo. |
| M34 | 349.020 → 0 caracteres não identificados | Epígrafe comprovada pela combinação do órgão e do título no contêiner. Cabeçalho do órgão separado do corpo. O recorte exclui navegação e rodapé. |

Os valores de origem da tabela usam o somatório dos spans das partes não identificadas da matriz. A prova registra também a metrificação por cobertura exclusiva, que pode incluir espaços fora dessas partes.

Os hashes das 50 capturas e metadados são fixados em [inputs.json](inputs.json). [equivalence.json](equivalence.json) compara texto, mapa de origem, estrutura, cobertura, limitações e contexto, com a identidade do motor neutralizada para a comparação semântica. A mudança de texto e mapa de M34 é esperada porque o leitor passa a receber somente o recorte comprovado. O documento continua com `legalStatus: unknown`. M25 e as páginas M9 permanecem no estado anterior.

[revalidation-proposal.json](revalidation-proposal.json) documenta as 20 amostras que sustentam as 17 células aceitas no R3. O ledger do candidato preserva os 46 registros existentes e acrescenta 20 revalidações e três novos registros offline. A matriz do candidato tem 20 aceitas, 29 cobertas e 32 pendentes. A aprovação da revisão independente e o mandato de merge seguem separados.

Para reproduzir com a base R3 e o candidato em diretórios isolados:

```sh
npm run anatomy:verify-build
npm run test:anatomy:e9-motor
node --import tsx ops/anatomy/e9-acervo/motor-r4/equivalence.mts <base> . <diretório-existente>
```
