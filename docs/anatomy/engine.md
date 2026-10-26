# Núcleo offline ANAT-04

Origem CLAUDE-COORD → GPT-EXEC, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244. O contrato foi publicado no CHECKPOINT-01 antes deste núcleo. Nenhuma rota, worker, coletor ou classificador existente importa estes módulos.

`analyzeAnatomy(request)` recebe somente uma representação concreta já fornecida, identidade da versão, fonte, data de referência, versão das regras, catálogo controlado opcional e manifesto de anexos. Não há conexão ou busca de conteúdo. HTML e texto simultâneos são rejeitados por ambiguidade; a representação deve ser escolhida explicitamente.

O leitor preserva texto canônico, origem e cobertura; a extração registra ocorrências e validação; o contrato verifica as referências e o resultado. A identidade inclui hashes do texto canônico, da apresentação exata recebida, do manifesto de anexos, das regras/perfil/catálogo e do motor. Catálogo não é evidência de situação jurídica. Anexo ausente ou não processado produz resultado parcial; falta/falha não vira constatação definitiva de ausência de assunto.

O motor mantém todas as situações jurídicas desconhecidas e todas as seleções negativas por ausência de evidência aprovada. A aplicação do dossiê ANAT-03 está fora deste pacote. Casos positivos e invalidação de evidências são demonstrados somente por fixtures sintéticas do contrato/consumidor, sem uma API para injetar aprovação real no motor.

`simulateTaxonomyConsumer(result)` importa exclusivamente o contrato. Valida o resultado integral, conserva blocos temáticos separados e exporta NCM apenas de seleções explícitas do canal `ncm`. Não reextrai números do texto temático, não expande prefixos/faixas, não gera tags/matches nem chama a classificação real. Cada ocorrência mantém parte, intervalo e evidência.

## Identidade verificável do motor

`ops/anatomy/build-identity.mjs` calcula SHA-256 real dos módulos ANAT e do lock de dependências, com representação de fontes UTF-8/LF explicitamente declarada. Inclui também o próprio gerador; exclui apenas seus produtos gerados para evitar recursão. O manifesto `engine-build.json` registra cada hash. O campo obrigatório `identity.engineHash` usa essa identidade, além de `engineVersion`.

Após editar um desses arquivos, executar explicitamente `node ops/anatomy/build-identity.mjs --write`, inspecionar o delta e commitar manifesto/constante. `npm run anatomy:verify-build` só confere e falha diante de deriva; não atualiza silenciosamente o valor no CI. A assinatura é de fontes/configuração travadas, não atestado de deploy ou assinatura criptográfica de distribuição. Entrada e runtime devem permanecer conforme o lock/Node 24 do CI para reprodução.

## Verificação e limites

`npm run test:anatomy` executa somente fixtures sintéticas e integridade de arquivos, sem aplicar regras ao corpus de 30 publicações ou à reserva final. Cobre contexto, literal/UTF-16, tabelas, domínios protegidos, faixas/exceções, mudança de hashes, consumidor e ausência de aprovação.

O SQL em `test/support/anatomy-ci-schema.sql` é preparado apenas pelo workflow descartável documentado em [ci-schema.md](ci-schema.md). Nenhum caminho de migration produtiva o descobre. O banco de CI também testa falhas atômicas e referência de saída pela identidade esperada completa, inclusive mudança de apresentação sem novo texto, e por status compatível.

Perfis e algoritmos desta versão são conservadores e versionados em código; administração/configuração por tela é ANAT-05. Não há resolução de links citados, reconstrução ambígua, OCR, consolidação temporal geral ou aplicação real de benefício. As metas quantitativas só poderão ser aferidas com as 30 entradas e gold completo revisado. Testes sintéticos não substituem esse gate.
