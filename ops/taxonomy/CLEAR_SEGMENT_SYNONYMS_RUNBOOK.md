# Limpar sinônimos de Segmento — issue 71

Pedido explícito do Product Owner: retirar todos os sinônimos da tabela Segmento,
mantendo execução pelo Railway. Edição curatorial R1 no DRAFT v1.3.0, usando
`updateConcept({aliases: []})`, inclusive itens legados e retirados.

Executor existente `segmentos-cnae-carga-70`, sem domínio/cron/volume, restart
NEVER. Credenciais por referências internas temporárias ao serviço API; login
dedicado `radar_taxonomy_curator_runtime`. Nenhuma migration, publicação,
remoção de conceitos ou alteração de outras dimensões/settings.

1. PR versionado/revisado, build/typecheck e integração curatorial verdes.
2. Start `node dist/infrastructure/database/taxonomy-clear-segment-synonyms.js
   --mode=preflight`: somente leitura; confirmar versão, 1.409 itens e número
   de sinônimos. A fonte deve ser fixada no SHA exato. Como o Railpack incorpora
   o start à build, alterar start requer nova conexão/build, não redeploy da
   imagem anterior.
3. `--mode=dry-run`: executar e conferir zero aliases; comparar todos os dados
   de sector exceto aliases/revisionNo, outras dimensões, publicada e settings;
   rollback integral e read-back idêntico ao snapshot anterior.
4. Registrar gate na issue, somente após CI/preflight/dry-run sem divergência.
   Nova build no mesmo SHA com `--mode=apply --confirm`.
5. Conferência antes/após COMMIT: zero aliases em TODOS os conceitos sector,
   incluindo legados/retirados; códigos/descrições/grupos/flags preservados.
   Recuperação: aliases anteriores de cada conceito ficam no `before_data`
   da auditoria `TAXONOMY_CURATION_SECTOR_ALIASES_CLEARED`, dentro da Railway.
   Não exportar/logar a lista. O dicionário global e releases publicadas não
   são apagados. Erro antes do COMMIT reverte toda a operação.
6. Recarregar a UI, conferir e salvar evidência. Esvaziar referências de conexão
   (skipDeploys) e retornar próxima configuração a preflight após conclusão.
