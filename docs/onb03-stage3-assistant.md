# ONB-03 Etapa 3 — assistente por estabelecimento

Implementação para revisão independente, sem autorização de merge/deploy.

O assistente usa Empresa → Estabelecimentos → um card por CNAE de cada unidade ativa → Resumo. Os dados cadastrais e a IE continuam editáveis na tela única Empresa e filiais, pelos fluxos existentes (incluindo cadastro manual quando a consulta CNPJ falha). A animação de importação dura seis segundos, sorteia frases do segmento e respeita reduced-motion.

GET /api/v1/companies/:companyId/onboarding é somente leitura. PUT recebe expectedVersion, releaseId, cardId, establishmentId (somente CNAE), status CONFIRMED/SKIPPED e escolhas. A transação valida tenant/administrador, bloqueia a empresa, compara a versão corrente e grava uma nova company_tax_profiles. Conflito retorna 409 e não faz retry automático. O PUT legado de tax-profile também exige expectedVersion; clientes antigos recebem 409 em vez de sobrescrever outra tela.

A retomada está em personalization.onboarding (schemaVersion 1), por empresa/unidade/CNAE. Não há backfill de perfis. Uma filial nova tem estado e escolhas vazios. As escolhas por CNAE são compostas com as seleções manuais preexistentes; remover/pular um card preserva escolhas ainda confirmadas em outro. Salvar pelo editor legado reinicia o estado do assistente, pois ele substitui o perfil completo. Mudança da release exige recarregar/reconfirmar os cards. As sugestões vêm exclusivamente de publishedOperationalLinks, portanto dos vínculos operacionais aprovados da release PUBLISHED atual (produção v1.9.0); nunca do staging/rascunho. Nenhuma sugestão é selecionada ou salva automaticamente.

As NCMs dos cards aceitam prefixos existentes ou com descendentes CURRENT, sem completar zeros. Os campos guardam as sequências de dígitos exibidas nos vínculos publicados. A edição manual deve usar somente dígitos, separados por vírgula; códigos sem correspondência são recusados.

Migration 080 cria somente onboarding_phrases e importa as 380 frases do CSV em ops/onb03-frases.csv. As posições 077–079 ficam reservadas à frente ANAT. Runtime pode ler; UPDATE exige PLATFORM_ADMIN via RLS e contexto de usuário. Edição administrativa usa CAS da versão da linha, mantém ao menos uma frase por segmento e não permite remover generico. A página de administradores expõe o editor. Desfazer uma edição usa a lista anterior com a versão corrente. Rollback de código preserva a tabela e os dados; nenhum rollback/backfill de perfis é automático.

Mapeamento F2 → CSV (categorias de apresentação por pai F2; pais compostos combinam as frases das correspondências temáticas abaixo). Não altera identidades da taxonomia. Os 19 grupos originais são preservados na tabela, inclusive os usados em pais compostos. Desconhecidos usam generico. O mapeamento explícito completo está em src/modules/onboarding/assistant.model.ts; não há inferência por CNAE nem rótulos de clientes.

Validação: teste unitário de composição de escolhas sobrepostas e filial vazia; teste de integração HTTP para GET sem escrita, isolamento tenant/empresa/unidade, CNAE inválido, versão concorrente, snapshot legado obsoleto, NCM inexistente, release obsoleta, retomada, nova filial, pular/concluir e acesso administrativo; testes React de retomada, confirmação explícita, prefixo sem zeros e conflito sem avanço/retry. Regressões existentes de CNPJ/manual/IE/perfil continuam nos gates completos. A integração local está bloqueada por EACCES no TCP de loopback desta sessão; executar na CI com PostgreSQL descartável.

| Segmento F2 | Grupos CSV |
| --- | --- |
| Agropecuária, pesca e insumos agrícolas | agro, pecuaria |
| Veterinário e pets | generico |
| Energia, petróleo, gás e combustíveis | energia, combustiveis |
| Mineração, metalurgia e produtos metálicos | mineracao, metalurgia |
| Alimentos, bebidas e tabaco | alimentos |
| Moda, têxtil, calçados e acessórios | textil |
| Casa, madeira, móveis e utilidades | florestal |
| Construção, materiais e engenharia | construcao |
| Papel, embalagens, gráfica e editorial | florestal |
| Beleza, cosméticos e bem-estar | generico |
| Mídia, cultura, esporte, lazer e eventos | generico |
| Tecnologia, eletrônicos e telecomunicações | tecnologia |
| Química, borracha e plásticos | quimicos |
| Saúde, farmacêutico e assistência | farmaceutico |
| Automotivo e equipamentos de transporte | automotivo |
| Indústria, máquinas e equipamentos | maquinas |
| Segurança, vigilância e proteção | generico |
| Água, saneamento, resíduos e reciclagem | generico |
| Marketing, publicidade e design | generico |
| Imobiliário | generico |
| Comércio multissetorial, holdings e atividades transversais | atacado, varejo |
| Transporte e logística | transporte |
| Turismo e hospedagem | generico |
| Restaurantes e serviços de alimentação | alimentos |
| Consultoria, pesquisa e serviços técnicos | generico |
| Finanças, seguros e previdência | generico |
| Jurídico, contabilidade e auditoria | generico |
| RH, facilities e apoio empresarial | generico |
| Locação, licenciamento e gestão de ativos | generico |
| Administração pública e instituições | generico |
| Educação e treinamento | generico |
| Serviços pessoais, domésticos e funerários | generico |

Se a release mudou e existem códigos históricos que não pertencem à release atual, o card retorna taxonomy_selection_review_required (409): revisar/salvar o perfil no editor existente antes de retomar. Não relabelar escolhas desconhecidas como membros da nova release. A versão do editor legado é capturada junto com os valores do formulário, evitando aceitar dados antigos com uma versão recém-refeita por refetch. O salvamento de card compartilha o advisory lock da curadoria para serializar com publicação.
