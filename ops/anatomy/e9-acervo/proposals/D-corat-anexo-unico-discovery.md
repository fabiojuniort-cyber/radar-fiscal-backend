# D. ADE Corat nº 33/2025: descoberta controlada do Anexo Único (plano; nada executado)

COORD, decisão D (tribusca-control#116): **preparar** a descoberta da URL oficial exata do Anexo Único da Agenda Tributária
de janeiro de 2026. Nenhuma requisição foi feita. O corpo do ato (`rfb:148516`) continua como **leitura parcial**, sem aceite integral.

## Vínculo normativo (material preservado, #303 @ `719352f`, `rfb-p2c/148516.json`)
- Ementa: "Divulga a Agenda Tributária do mês de janeiro de 2026."
- Art. 17 (segmento 49): "O Anexo Único deste Ato Declaratório Executivo será publicado na Internet, no endereço eletrônico da
  RFB <( https://www.gov.br/receitafederal )>."
- Art. 1º, § 3º (segmento 10): "A Agenda Tributária será disponibilizada na página da RFB na Internet, no endereço eletrônico
  < www.gov.br/receitafederal >."
- O JSON tem 0 segmentos `Anexo`. O ato só aponta para a **raiz** do portal; o caminho exato **não** está comprovado.

## Escopo da rota (sem acesso genérico ao gov.br)
- **Host:** exatamente `www.gov.br`, HTTPS, porta padrão, sem credenciais, sem query e sem fragmento.
- **Prefixo de caminho:** `/receitafederal/pt-br/assuntos/agenda-tributaria/`.
  - É uma **hipótese a confirmar** no 1º passo, não verificada offline.
  - Qualquer URL fora dele é recusada **antes** do envio, inclusive o restante do gov.br.
- **Redirect:** só dentro do mesmo host e prefixo, e cada salto é uma requisição debitada. Fora disso: registrado, não seguido, fim.
- **Somente HTML**, no máximo 2 MiB por resposta; nada de PDF/planilha nesta etapa, que fica para a captura.

## Orçamento e grant
- Grant próprio `E9-P2c-ANEXO-CORAT-G1`: **3 requisições** (2 páginas + 1 redirect), tipo "Ato Declaratório Executivo", suspenso,
  dono único, débito persistido antes do envio (RequestBudget). O saldo do G1 (ADE 2) **não** é usado.

## Passos (só depois da revisão da rota e da ativação)
1. **Índice:** GET `https://www.gov.br/receitafederal/pt-br/assuntos/agenda-tributaria`. Extrair só os links do mesmo prefixo
   cujo texto ou caminho contenha `2026` e `janeiro`. Nenhum outro link é seguido.
2. **Página do mês:** GET do link único achado. Se houver 0 ou mais de 1 link candidato, **para** e registra (não adivinha).
3. **Comprovação do vínculo (offline, depois da resposta):** a página precisa conter "Agenda Tributária" e "janeiro de 2026"
   (ou "Janeiro/2026"). A menção ao "Ato Declaratório Executivo Corat nº 33" é registrada como evidência forte quando existir.
   Mês ou ano divergente → recusa, nada gravado.
4. **Registro:** URL inicial e final, cadeia de saltos, Content-Type, SHA-256, bytes, data, `resourceId`
   `rfb:148516:anexo:externo`, e o vínculo com o Art. 17 (texto e segmento 49).

## Depois (fora desta etapa)
- **Captura do conteúdo do anexo** (tabela ou arquivos do calendário): só depois de comprovados a URL exata e o vínculo, e de
  revisado o escopo da rota. Nova autorização, com orçamento próprio, leitura como recurso separado (padrão do #300) e
  proveniência por byte.
- **Completude:** a norma integral só pode ser considerada com o anexo lido; até lá, `annexGap` (patch B) mantém o bloqueio de aceite.

## Testes previstos para a rota (transporte simulado)
- URL fora do host ou do prefixo, `http`, porta, credenciais, query e fragmento → recusados com 0 requisições.
- Redirect para fora do prefixo → 1 debitada, não seguido.
- Índice com 0 ou 2 links de janeiro/2026 → para.
- Página de outro mês/ano → recusada.
- Grant suspenso → 0 requisições.
- O saldo nunca passa de 3.
