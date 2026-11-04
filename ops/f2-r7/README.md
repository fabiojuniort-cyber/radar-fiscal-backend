# F2 R7 - par observacional autorizado

## Limita��o descoberta na execu��o inicial

O run41930483691 usa o HEAD23c9226f. O wrapper inicial pool.query liberava
conex�es sem o erro no finally, diferente do pg-pool que chama release(err).
Isso pode conservar sess�o/cache que seriam descartados. Os resultados desse
par n�o constituem compara��o equivalente nem prova causal, mesmo se verdes.
Esta revis�o corrige a passagem do erro e adiciona teste espec�fico de descarte.
N�o repete o par: o workflow responde somente ao primeiro opened, attempt1.
Nova execu��o exige decis�o espec�fica ap�s o limite original de duas �rvores.

Autoriza��o: tribusca-control#127 coment�rio6642909200, reiterada pelo F�bio.
N�o mergear esta prepara��o; nenhum deploy/ambiente produtivo envolvido.

Uma execu��o do workflow no evento opened da branch exata, PR draft, attempt1.
N�o usa ready nem synchronize para repetir; n�o h� dispatch/rerun/loop de casos.
O CI geral do draft n�o executa R7 completo. O harness � um gate separado, n�o CI limpa de #285.

Ordem fixa: controle b2150ab5, integra��o2c41fbab. Cada caso tem worktree isolada
e container novo, sem volume, imagem PG18.6 pelo digest aprovado e Node24.22.2.
Toda a sequ�ncia anterior do job ONB01 � preservada, incluindo a verifica��o
de migrations. Build e predecessores usam arquivos originais.
Somente antes do R7 � aplicada uma substitui��o revers�vel do construtor de Pool
para a instrumenta��o e um import; reversibilidade � verificada byte a byte.
Nenhuma asser��o ou instru��o SQL de produto muda. Todas as prote��es e limites
originais permanecem, inclusive teste240s/comando300s e job14min para o par.

Instrumenta��o id�ntica: poolmax2, jitoff, statement45s, lock5s;
auto_explain apenas nas sess�es R7, par�metros desabilitados, an�lise/buffers
ligados, timing desligado e dura��o250ms; track_io_timing nas mesmas sess�es.
GUCs conferidas em cada conex�o nova e ap�s reabertura do pool.
Metadados/cat�logo/estat�sticas por conex�o, ap�s commit da fixture, ap�s remover
trigger sint�tico e antes de cada lote. Ordinal, tempos e SQLSTATE por lote.
O tempo dos snapshots � overhead expl�cito e pode mudar o timing de manuten��o;
n�o se afirma equival�ncia a desempenho sem instrumenta��o.

Observador: autocommit READ ONLY, no m�ximo300 amostras a1Hz/300s, queries900ms;
atividade/waits/locks/blockers, IO, estat�sticas, checkpointer e host/cgroup.
PIDs s�o exclusivamente processos do laborat�rio para correlacionar conex�es,
nunca identificadores de usu�rios. N�o exporta query text nem payloads.
Planos s�o sanitizados por allowlist estrutural; n�o exportam express�es,
constantes ou par�metros. Falta de plano cancelado continua NOT_PROVEN.
Os logs de comandos removem DSNs e valores de autentica��o sint�ticos.
O container/observador s�o encerrados em finally; falha mant�m exitcode.

Verifica��es pr�vias: node --check dos m�dulos e tr�s testes de guardas negativas,
sanitiza��o de planos e invariantes do runner. N�o s�o reprodu��o PG18.
O processo recusa ambiente fora de GitHub/Linux, attempt diferente de1,
Node diferente, diret�rio de evid�ncia j� existente e URLs fora do laborat�rio.
Nenhum comando produtivo, ANALYZE adicional, altera��o de planner ou rerun � autorizado.

