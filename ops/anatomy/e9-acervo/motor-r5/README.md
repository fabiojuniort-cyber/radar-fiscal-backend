# E9-MOTOR R5 · Leis do Planalto

Base em ccc075fa06b8d260205361aed564a390eb290c7d, motor 9469ef07a55429acb2cdf50dee72bd350d435c8849a8ec24829faf9cb8a481fa. As entradas são as capturas preservadas do acervo. O perfil PLANALTO exige preparação emitida para o HTML exato e o identificador da amostra.

| Célula | Insumo | Não identificados, R4 → R5 | Evidência |
| --- | --- | --- | --- |
| Lei pequena | M10, Lei 10.168/2000 | 284 → 0 | Fecho e assinatura, marcador editorial adjacente ao aviso e separadores. |
| Lei média | M12, Lei 9.718/1998 | 326 → 0 | Títulos centrados imediatamente após os capítulos, fecho e separadores. |
| Lei grande | http:M1, Lei 10.637/2002 | 733 → 0 | Numeração e títulos de capítulo, fecho e bloco com todos os trechos visíveis tachados. |
| Contraprova da Lei grande | http:M2, Lei 10.833/2003 | 5.973 → 5.662 | Parcial. Permanecem itens numerados, uma tabela TIPI aninhada e resíduos editoriais. Nenhum aceite desta amostra. |

Os números acima somam os spans das partes não identificadas, como nas notas da matriz. A prova também mede a cobertura exclusiva. A aceitação da célula grande fica limitada a http:M1, conforme o ledger. O leitor preserva texto canônico, mapa de origem e os spans das citações. O ajuste exige evidência estrutural antes de reconhecer texto editorial. A regra de cobertura só reconhece lacunas compostas de espaço em branco. O grupo estrutural de capítulo segue a convenção de contexto `operative_candidate`, inclusive em caixa mista. O título descritivo permanece `prohibited` como parte filha. Assinaturas, avisos e blocos integralmente tachados identificados pelo ajuste ficam fora da seleção. `legalStatus` continua `unknown`.

### Limite do perfil PLANALTO

A regra de títulos de capítulo tem uma lista fechada de 11 textos, espelhada em `planaltoChapterTitles` no leitor. O parágrafo precisa estar centralizado e imediatamente após o grupo do capítulo no mesmo contêiner. A comparação normaliza os espaços e ignora caixa.

1. DA CONTRIBUIÇÃO PARA O PIS/PASEP E COFINS
2. DO IMPOSTO SOBRE A RENDA
3. DO IMPOSTO SOBRE OPERAÇÕES DE CRÉDITO, CÂMBIO E SEGURO, OU RELATIVAS A TÍTULOS OU VALORES MOBILIÁRIOS
4. DA COBRANÇA NÃO-CUMULATIVA DO PIS E DO PASEP
5. DA COBRANÇA NÃO-CUMULATIVA DA COFINS
6. DAS OUTRAS DISPOSIÇÕES RELATIVAS À LEGISLAÇÃO
7. DAS OUTRAS DISPOSIÇÕES RELATIVAS À LEGISLAÇÃO TRIBUTÁRIA
8. DAS DISPOSIÇÕES RELATIVAS À LEGISLAÇÃO ADUANEIRA
9. DISPOSIÇÕES FINAIS
10. DAS DISPOSIÇÕES FINAIS
11. DAS DISPOSIÇÕES GERAIS E FINAIS

O título 6 admite a continuação exata TRIBUTÁRIA E ADUANEIRA no parágrafo centralizado imediatamente seguinte. Outros títulos ficam sujeitos às regras preexistentes do leitor.

### Prova e registros

As 12 células mencionadas no início da R4 eram as células sem aceite com amostra validada e parcial na matriz R3, commit 9c717590. Na matriz R4, três dessas células têm aceite, e nove continuam sem aceite com amostra parcial, incluindo M25. O Convênio ICMS grande conserva http:M3 parcial e é aceito por http:M4. A matriz registra M9 como identificado e sem leitura validada. M25 e M9 estão fora do escopo R5.

A prova reproduzível valida os bytes e metadados de 50 capturas, recalcula os digests e compara a saída por fonte com a identidade do motor neutralizada. A prova percorre toda a cadeia de ancestrais de cada parte `operative_candidate` em todas as saídas observadas dos dois motores. Qualquer ancestral `prohibited` no candidato reprova a execução. A base R4 é imutável e as ocorrências preexistentes em M12 e http:M2 ficam registradas. O [inventário de ancestralidade](ancestralidade-planalto.md) discrimina todos os ancestrais e descendentes. M12 recupera a estrutura operativa quando o tachado cobre apenas o ordinal e mantém os marcadores explícitos de revogação proibidos. Em http:M2, os incisos substitutivos do art. 62 voltam ao caput pela âncora do inciso I. Os demais casos confirmados são redações tachadas, cujos descendentes ficam proibidos. Capturas sem leitura do motor são registradas explicitamente. Registra quatro deltas previstos, todos do Planalto, 46 amostras equivalentes de outras fontes e zero deltas inesperados. A matriz tem 23 aceitas, 29 cobertas e 32 pendentes de cobertura. Os 69 registros anteriores foram preservados e foram anexados 23 registros de revalidação das 20 células do R4 e três aceites offline. A revisão independente e a autorização de merge são gates separados.

Para reproduzir em cópias graváveis e isoladas da base e do candidato, com as dependências instaladas:

```sh
npm run anatomy:verify-build
npm run test:anatomy:e9-motor
node --import tsx ops/anatomy/e9-acervo/motor-r5/equivalence.mts <base> . <diretório-existente>
```
