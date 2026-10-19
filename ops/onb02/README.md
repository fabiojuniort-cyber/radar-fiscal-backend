# ONB-02 R7 — implementação para revisão, sem produção

Contrato vigente: [docs/audit-policy-r7.md](../../docs/audit-policy-r7.md).
Issue #118. R4/R5/R6 de minimização textual foram abandonados.

- 073: purga do grafo com guardas/timeout, evidência COMPANY_PURGED e bloqueio
  temporário enquanto houver auditoria histórica pendente.
- 074: allowlist e validação no banco; adaptadores de escritores existentes;
  marcador por linha, checkpoint e função de lote exclusiva do operador.
- Backfill separado: --plan apenas contagens; --apply exige --ack-irreversible-r7.
- Não há busca textual nem mascaramento por empresa dentro da purga.
- Preparar deploy e backfill como duas autorizações distintas. Não executar agora.
- Dados globais do Acervo, outras empresas e inativas preexistentes permanecem.
- Conferir ledger/checksum/owner/ACL em cada ambiente antes de implantação futura.
- Durante predeploy/troca do backend, pausar escritores antigos para evitar falhas
  da guarda ao receber payloads antigos. Não relaxar a allowlist para compatibilidade.
- Histórico usa tenant + UUID + evento de exclusão confirmado, sem snapshots.
- IDs retidos são pseudônimos, não promessa de anonimização absoluta.
- ACCEPTED_RISK de recuperação registrado permanece; este pacote não o reabre.
