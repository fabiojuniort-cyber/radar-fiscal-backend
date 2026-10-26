# ANAT-04 — CHECKPOINT-01: contrato verificável

Origem: **CLAUDE-COORD → GPT-EXEC**, autorização de Fábio, 16/10/2026. [Coordenação #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116). Entrega parcial R2, sem merge ou produção.

**ANAT-04: 14,3% — primeiro de sete marcos**, após a publicação deste contrato e do checkpoint na issue. Corpus parcialmente congelado não conclui o segundo marco. Este percentual descreve entregas, não precisão ou aprovação jurídica.

## Entregue

- Contrato ANAT→TAX v1, JSON Schema e validação semântica executável: árvore ordenada, UTF-16, ponteiros e mapa de origem, entidades, cobertura integral, limitações, exclusões e identidade por hashes/versões.
- Reconhecimento/validação, contexto/situação e elegibilidade separados. Canais `thematic_text` e `ncm` distinguem relevância textual de seleção numérica; consumidores não podem reextrair NCM do canal temático.
- Evidências exclusivamente controladas em fixtures. Identidade, data, dependências, conflitos, zonas proibidas, histórico, operadores e alcance integral da ocorrência são verificados antes de aceitar seleção positiva.
- ANAT-02 mínimo documentado, sem novo acesso: dois HTMLs sanitizados com igualdade persistida comprovada anteriormente por SELECT humano. `content_text`, anexos e visibilidade produtiva continuam `NOT_PROVEN`.
- Manifesto dos 30 IDs, com 12 publicações/14 arquivos disponíveis e hashes conferidos, 18 respostas originais ausentes e zero gold revisado. Dez reservadas preservadas, sem regras ou avaliação.
- Testes de contrato e integridade incluídos no CI rápido existente. Atributo `-text` nos snapshots impede normalização de bytes pelo Git.

## Verificação local

Node 24, TypeScript 7.0.2: typecheck e build passaram. Após a última correção, novo typecheck passou; 18 testes sintéticos do contrato e quatro testes de inventário passaram, incluindo paridade do JSON Schema publicado com o executável. Roteamento existente do CI: 16 testes passaram em temporário dentro do clone.

A suíte unitária global foi iniciada, apresentou testes passando e depois ficou sem conclusão no ambiente Windows; foi interrompida. **Não se declara regressão global PASS.** Dependências locais foram copiadas de instalação existente para o clone isolado, sem alterar pacote/lock; o CI instalará pelo lock com `npm ci`. CI remoto e regressão completa ainda não estão comprovados. O PR draft tem gate `DRAFT_FAST_ONLY` intencional, conforme `AGENTS.md`; não é aceite final.

## Revisão independente Astra

O subagente GPT Astra revisou e reproduziu falhas: seleção de contêiner incluindo filho histórico/proibido; desvio por seleção genérica de operador; origem invertida; evidências conflitantes; completude indevida com desconhecido. Foram corrigidas e a rechecagem confirmou as quatro reproduções iniciais e a paridade do schema.

Na última rechecagem, Astra encontrou ainda que aprovação só do prefixo podia liberar NCM inteiro. Foi corrigido exigindo igualdade entre span da seleção NCM e span da ocorrência, com regressão que também testa prova curta e prova integral. **Astra atingiu limite de uso antes de rever essa última correção ou emitir parecer final favorável.** A correção passou nos testes do executor; não é autoaprovação de revisão independente. A revisão final do pacote inteiro também permanece pendente.

## BLOCK e continuidade

`BLOCK_CORPUS_INPUTS_AND_GOLD`: recuperar as 18 respostas DOE-SP/RFB já lidas no desenho, conferindo hashes, e preparar/revisar spans completos das 30 entradas. Não substituir por variantes truncadas nem obter novas respostas sob a proibição atual de coleta. Tentativa de leitura do histórico da sessão remota do desenho excedeu limite da ferramenta; nenhum arquivo foi recuperado e nenhuma mensagem foi enviada a outro chat.

Após registrar este checkpoint, a implementação isolada dos leitores, entidades/operadores, consumidor e DDL somente CI continua autorizada, sem necessidade de nova aprovação de produto. A medição e o aceite seguem bloqueados pelo corpus; a rechecagem independente está pendente da disponibilidade do Astra. Dossiê real fica no ANAT-06. Sem SQL, migration, escrita em banco, coleta operacional, Railway, integração real da taxonomia, merge ou deploy neste checkpoint.
