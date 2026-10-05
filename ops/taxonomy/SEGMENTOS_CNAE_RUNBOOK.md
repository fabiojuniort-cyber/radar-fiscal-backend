# Carga pontual dos segmentos CNAE — tribusca-control#70

Autorização vigente do Product Owner: atualizar Segmento com a planilha entregue,
incluindo Subsegmento, CNAE antes da descrição e sinônimos; executar diretamente
pelo Railway. Carga curatorial aditiva R1 no DRAFT v1.3.0, usando as funções
TAX-11 existentes. Não é repair, migration, publicação ou classificação de atos.

Pacote público `ops/taxonomy/loads/trifaros-cnae-2.3.json`: SHA-256
`9bd8e47e5a9d1975b27f6841c498d2867cc687b64a92f77bf4057dc3db30434d`.
1.332 CNAEs, 32 segmentos, 137 subsegmentos, 17.671 sinônimos. Derivado de
`TriFaros_Segmentos_CNAE_Empresas_Brasil.xlsx`; descritores positivos IBGE.
As quatro subclasses com mais de 200 descritores ficam no limite do contrato,
preservando a descrição e os 199 descritores mais curtos. Notas de exclusão
não viram sinônimos. Nenhum dado privado é incorporado ao artefato.

## Executor e gates

1. PR com typecheck, build, unit tests e integração curatorial verdes; registrar
   o commit revisado e o gate na issue 70.
2. Serviço operacional pontual na produção do projeto `efficient-imagination`,
   sem domínio, cron ou volume. Referências internas a
   `radar-fiscal-backend.DATABASE_URL` e
   `radar-fiscal-backend.DB_CURATOR_RUNTIME_PASSWORD`; não copiar valores.
   O código deriva o login NOINHERIT `radar_taxonomy_curator_runtime` e recusa
   superuser/admin. Restart policy NEVER; pre-deploy vazio (sem migrations).
3. Source fixada no commit exato; build `npm run build`. Start:
   `node dist/infrastructure/database/taxonomy-load-segments.js --mode=preflight`.
   Esperado: DRAFT v1.3.0 e inicialmente 45 itens de sector; nenhuma escrita.
4. Executar `--mode=dry-run`: transação única, advisory lock de curadoria,
   conferência integral, ROLLBACK, conferência do rollback. Esperado inicialmente
   1.332 criados, 0 atualizados, 1.409 itens sector após a simulação,
   published/otherDimensions/settingsUnchanged=true e rollbackVerified=true.
5. Somente após gates verdes e sem divergência executar `--mode=apply --confirm`.
   O mesmo pacote e transação são usados. Sem retirar itens antigos. Conferir
   todos os códigos/descrições, os 137 vínculos e todos os 17.671 aliases
   antes do COMMIT e novamente em leitura após o COMMIT.
6. Conferir na interface, salvar evidência e registrar relatório sintético.
   Não publicar a release nem ligar a classificação automática.

## Reversão e limites

Qualquer erro anterior ao COMMIT desfaz toda a carga, inclusive auditoria e
identidades novas. Dry-run confirma isso. A release publicada, itens legados,
outras dimensões e settings são comparados antes/depois; divergência aborta.
Não há SQL novo de modificação nem mudança de grants/schema/autenticação.
Uma reexecução identifica os CNAEs exatos e atualiza os existentes sem duplicar;
mapeamentos ambíguos são recusados. A carga permanece num rascunho reversível
pela curadoria normal. O executor encerra e não tem recorrência.
