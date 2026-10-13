# NCM-03 — isolamento de role no CI

O enriquecimento automático de NCM é responsabilidade do Worker.

Por isso, os testes de integração da coleta devem executar com `radar_worker_runtime`, enquanto API, autenticação e RLS permanecem com `radar_app_runtime`. Fixtures e limpeza continuam usando a conexão administrativa de teste.

Essa separação evita conceder privilégios de escrita do Worker à aplicação e mantém o teste aderente ao ambiente de produção.
