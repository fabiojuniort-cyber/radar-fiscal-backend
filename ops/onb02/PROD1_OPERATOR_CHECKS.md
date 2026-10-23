# ONB-02 PROD-1.1 — bloco único para o Fábio

Objetivo: colher duas evidências pendentes. Este procedimento não executa restore,
backfill, migration, publicação ou exclusão real. Não clicar no botão de exclusão
de uma empresa existente. Não enviar tokens, CNPJ, nomes ou identificadores no chat.

## A. Conferir o PITR no Railway, sem restaurar

1. Abra https://railway.com/dashboard e clique no projeto **efficient-imagination**.
2. No seletor de ambiente no topo, confirme **production**.
3. Clique no cartão **Postgres**. Não abra um dos bancos de prova/restauração.
4. Na página desse serviço, clique na aba **Backups**.
5. Localize **Point-in-Time Recovery / PITR**. A lista de snapshots de volume não
   substitui a seção PITR. Se aparecer **Point-in-time recovery is off**, botão
   **Enable PITR**, erro de arquivamento ou ausência de intervalo disponível,
   registre essa mensagem e pare essa parte; não habilite ou reconfigure agora.
6. Se a seção oferecer escolha de histórico/cluster, selecione o histórico da
   instância produtiva atual. Confira o intervalo exibido antes de escolher.
   Não escolha um histórico antigo só por ter intervalo maior.
7. Leia o **available restore range** da seção PITR e seu seletor de data/hora:
   registre o limite inicial e, especialmente, o **limite final mais recente
   que a plataforma oferece para restauração**. Não registre apenas a hora
   selecionada manualmente, um snapshot ou um horário de WAL do log.
8. Registre o fuso exibido. Se a UI mostrar horário local BRT, mantenha esse
   horário e o fuso; a conversão para UTC será feita no registro. Capture apenas
   o painel PITR/status/intervalo, recortando informações privadas de outras áreas.
9. Confira eventual aviso de atraso, backup inicial incompleto, lacuna de arquivo
   ou erro. **Não clique em Restore to this moment, Restore, Enable ou Disable**.
   A consulta do intervalo é suficiente para esta etapa.
10. Se a UI não mostrar o limite final ou não oferecer informação suficiente de
    saúde, registre **não comprovado pela UI**. Como complemento, em terminal
    próprio com Railway CLI já autenticado, execute primeiro **railway link**,
    escolhendo efficient-imagination → production → Postgres, e então:
    ~~~bash
    railway postgres pitr status --service Postgres --environment production --json
    ~~~
    Esse comando é de leitura. Copie somente os campos de status, cobertura
    inicial/final e archiver health; não publique variáveis, URLs ou credenciais.
    Se a cobertura vier unavailable/erro, o PITR continua não comprovado.
11. Resultado a devolver:
    **PITR: habilitado [sim/não]; início [data/hora/fuso]; último ponto restaurável
    [data/hora/fuso]; avisos/saúde [texto]; observado em [data/hora/fuso].**
    Isso é saúde/cobertura relatada pela plataforma, não um teste efetivo de restore.

## B. Testar o 409 no site antigo, com alvo sintético

1. Abra o site normal do produto e entre com sua conta **OWNER/ADMIN** da conta
   selecionada. Não use a confirmação de exclusão de nenhuma empresa.
2. Pressione **F12** (ou Ctrl+Shift+I). Clique na aba **Network / Rede** e no
   filtro **Fetch/XHR**. Recarregue a página (Ctrl+R).
3. Encontre uma requisição **GET /api/v1/account** que terminou em **200**.
   Se necessário, abra a tela normal de empresas/perfil para ela ocorrer.
   Essa leitura já é usada pelo site; não copie nenhuma requisição DELETE.
4. Clique nessa GET → **Headers / Cabeçalhos** → **Request Headers**.
   Localize **Authorization** e **x-tenant-id**. Mantenha os valores só no seu
   computador. Não os envie no chat, Issue, PR ou captura de tela.
5. Clique na aba **Console**. Leia o código abaixo antes de executá-lo.
   Ele pede esses dois valores em caixas locais, faz uma leitura inicial,
   gera um alvo aleatório novo, envia um único DELETE **sem o header de intenção**
   e faz outra leitura. Não usa o identificador de empresa real.
6. Cole e execute este bloco no Console. No primeiro pedido, informe o valor
   completo de Authorization da GET, incluindo **Bearer** e o token; no segundo,
   informe o valor de x-tenant-id. Não acrescente nenhum outro header.
   ~~~javascript
   (async () => {
     const authorization = prompt('Authorization da GET, incluindo Bearer. Uso local; não envie no chat.');
     const tenant = prompt('x-tenant-id da mesma GET. Uso local; não envie no chat.');
     if (!authorization?.startsWith('Bearer ') || !tenant?.trim()) {
       throw new Error('Teste cancelado: sessão local não informada.');
     }
     const headers = { Authorization: authorization.trim(), 'x-tenant-id': tenant.trim() };
     const snapshot = async () => {
       const r = await fetch('/api/v1/account', { headers, cache: 'no-store' });
       if (r.status !== 200) throw new Error('Leitura da conta falhou: HTTP ' + r.status);
       const b = await r.json();
       if (!Array.isArray(b.companies) || b.companies.some(c => typeof c.id !== 'string')) {
         throw new Error('Resposta da conta não reconhecida; DELETE não é necessário.');
       }
       return { count: b.companies.length, ids: b.companies.map(c => c.id).sort().join(',') };
     };
     const before = await snapshot();
     const response = await fetch('/api/v1/companies/' + crypto.randomUUID(), {
       method: 'DELETE', headers, cache: 'no-store'
     });
     const body = await response.json().catch(() => null);
     const after = await snapshot();
     console.log({
       httpStatus: response.status,
       confirmationRequired: body?.error === 'permanent_delete_confirmation_required',
       companiesBefore: before.count,
       companiesAfter: after.count,
       sameCompanyIds: before.ids === after.ids,
       syntheticTarget: true
     });
   })().catch(e => console.error('Teste não comprovado:', e.message));
   ~~~
7. Resultado exigido: **httpStatus:409**, **confirmationRequired:true**,
   **sameCompanyIds:true**, contagens iguais e **syntheticTarget:true**.
   Pode copiar somente esse objeto final. Não copie Headers, token, resposta
   completa do account ou caminho do alvo.
8. 401: sessão/token expirado, entrar novamente e repetir a coleta da GET.
   403: conta sem papel administrativo/acesso ao tenant. 400: header inválido.
   Erro de rede: prova não concluída. 404/204/5xx ou qualquer outra resposta:
   registrar somente o status e parar; não testar em empresa existente.
   Não inserir X-Company-Delete-Intent para tentar fazer o teste passar.
9. O teste passa pelo mesmo proxy /api/v1 que o cliente web antigo usa.
   O backend rejeita a falta de intenção antes de chamar purgeCompany; o alvo
   aleatório e a comparação da lista evitam usar uma empresa real como cobaia.
   Se houver edição concorrente de empresas, a comparação pode falhar sem relação
   com o teste: registrar a divergência e não alegar preservação comprovada.
10. Feche o DevTools após guardar apenas o resultado sanitizado.

Devolva os dois resultados juntos. **Não executar --apply.** Os três tipos legados
ainda exigem revisão/merge autorizado da regra nova e um --plan posterior com
desconhecidos=0. O presente bloco não autoriza nenhuma dessas operações.
