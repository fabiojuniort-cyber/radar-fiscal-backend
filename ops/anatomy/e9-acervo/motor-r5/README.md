# E9-MOTOR R5 · Leis do Planalto

Base em ccc075fa06b8d260205361aed564a390eb290c7d, motor 9469ef07a55429acb2cdf50dee72bd350d435c8849a8ec24829faf9cb8a481fa. As entradas são as capturas preservadas do acervo. O perfil PLANALTO exige preparação emitida para o HTML exato e o identificador da amostra.

| Célula | Insumo | Não identificados, R4 → R5 | Evidência |
| --- | --- | --- | --- |
| Lei pequena | M10, Lei 10.168/2000 | 284 → 0 | Fecho e assinatura, marcador editorial adjacente ao aviso e separadores. |
| Lei média | M12, Lei 9.718/1998 | 326 → 0 | Títulos centrados imediatamente após os capítulos, fecho e separadores. |
| Lei grande | http:M1, Lei 10.637/2002 | 733 → 0 | Numeração e títulos de capítulo, fecho e bloco com todos os trechos visíveis tachados. |
| Contraprova da Lei grande | http:M2, Lei 10.833/2003 | 5.973 → 5.662 | Parcial. Permanecem itens numerados, uma tabela TIPI aninhada e resíduos editoriais. Nenhum aceite desta amostra. |

Os números acima somam os spans das partes não identificadas, como nas notas da matriz. A prova também mede a cobertura exclusiva. A aceitação da célula grande fica limitada a http:M1, conforme o ledger. O leitor preserva texto canônico, mapa de origem e os spans das citações. O ajuste exige evidência estrutural antes de reconhecer texto editorial. A regra de cobertura só reconhece lacunas compostas de espaço em branco. Partes qualificadas pelas novas regras ficam fora da seleção operativa e legalStatus continua unknown.

As 12 células mencionadas no início da R4 eram as células sem aceite com amostra validada e parcial na matriz R3, commit 9c717590. Na matriz R4, três dessas células têm aceite, e nove continuam sem aceite com amostra parcial, incluindo M25. O Convênio ICMS grande conserva http:M3 parcial e é aceito por http:M4. A matriz registra M9 como identificado e sem leitura validada. M25 e M9 estão fora do escopo R5.

A prova reproduzível valida os bytes e metadados de 50 capturas, recalcula os digests e compara a saída por fonte com a identidade do motor neutralizada. Registra quatro deltas previstos, todos do Planalto, 46 amostras equivalentes de outras fontes e zero deltas inesperados. A matriz tem 23 aceitas, 29 cobertas e 32 pendentes de cobertura. Os 69 registros anteriores foram preservados e foram anexados 23 registros de revalidação das 20 células do R4 e três aceites offline. A revisão independente e a autorização de merge são gates separados.

Para reproduzir em cópias graváveis e isoladas da base e do candidato, com as dependências instaladas:

```sh
npm run anatomy:verify-build
npm run test:anatomy:e9-motor
node --import tsx ops/anatomy/e9-acervo/motor-r5/equivalence.mts <base> . <diretório-existente>
```
