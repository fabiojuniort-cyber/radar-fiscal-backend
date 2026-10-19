# ONB-02 R7.1 — implementação para revisão, sem produção

Contrato vigente: [docs/audit-policy-r7.md](../../docs/audit-policy-r7.md).
Issue #118. R4/R5/R6 de minimização textual foram abandonados.

- 073: purga do grafo com guardas/timeout, evidência COMPANY_PURGED e bloqueio
  temporário enquanto houver auditoria histórica pendente.
- 074: allowlist e validação no banco; adaptadores de escritores existentes;
  marcador por linha, checkpoint e função de lote exclusiva do operador.
- Backfill separado: --plan lista todos os pares ação/tipo, contagens e regra sim/não;
  --apply exige --ack-irreversible-r7 e aborta com relatório/código 1 se faltar regra,
  antes de alterar auditorias ou checkpoint. Não esvazia payload de desconhecidos.
- A função SQL repete o preflight antes de cada lote. O lock ROW EXCLUSIVE impede
  DDL que desabilite a guarda durante o lote, sem bloquear INSERTs normais;
  a guarda continua rejeitando novos tipos sem regra.
- Inventário com origem de 40 tipos existentes: docs/audit-event-inventory-r7.json.
- Não há busca textual nem mascaramento por empresa dentro da purga.
- Preparar deploy e backfill como duas autorizações distintas. Não executar agora.
- Dados globais do Acervo, outras empresas e inativas preexistentes permanecem.
- Conferir ledger/checksum/owner/ACL em cada ambiente antes de implantação futura.
- Durante predeploy/troca do backend, pausar escritores antigos para evitar falhas
  da guarda ao receber payloads antigos. Não relaxar a allowlist para compatibilidade.
- Histórico usa tenant + UUID + evento de exclusão confirmado, sem snapshots.
- IDs retidos são pseudônimos, não promessa de anonimização absoluta.
- ACCEPTED_RISK de recuperação registrado permanece; este pacote não o reabre.
