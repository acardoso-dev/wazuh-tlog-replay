# Análise de segurança do Session Replay

[English](en/security-analysis.md)

**Versão analisada:** 0.8.1. **Versão corrigida:** 0.8.3. **Data:** 05/11/2026.

Este documento explica como cada problema funcionava, para quem opera uma versão antiga ou revisa o projeto. Todas as correções estão na 0.8.3 e nas versões seguintes. Para relatar uma falha nova, veja [SECURITY.md](../SECURITY.md).

## Resumo

A análise cobriu o servidor, a interface, o script de instalação, o `tlog-record-all` e a configuração da coleta. Foram 19 achados de segurança e 7 bugs. Todos receberam correção, mas o **SR-06** é só parcial e também depende de uma ação em cada instalação. Outros 9 riscos não têm correção no código: a decisão tomada para cada um está em [Riscos que continuam](#riscos-que-continuam).

**O problema mais grave:** um usuário comum sendo gravado, sem root, conseguia travar o dashboard para todos só imprimindo texto no próprio terminal. No laboratório, 28 KB de saída deixaram o painel sem responder por 8 s.

Não foi encontrado desvio de autenticação, execução remota de código, XSS nem injeção de consulta. O plugin continua nunca devolvendo a entrada do usuário (`in_txt`).

| Severidade | Corrigidos | Situação |
|---|---|---|
| Crítica | 0 | Nenhum encontrado |
| Alta | 5 | SR-01 a SR-05 |
| Média | 8 | SR-06 a SR-12 e SR-19; o SR-06 é parcial e exige ação em cada instalação |
| Baixa | 6 | SR-13 a SR-18 |
| Bugs | 7 | B-01 a B-07 |

### O que fazer em cada instalação

Em uma instalação anterior à 0.8.3:

1. **Atualize o plugin** para a 0.8.3 ou mais recente. O carregador não mudou: um F5 basta depois de reiniciar o dashboard.
2. **Reduza o papel de escrita** em cada indexador (SR-06), com as permissões descritas na [instalação](instalacao.md#2-preparar-o-indexador). Sem isso, a credencial continua podendo apagar gravações.
3. **Atualize as regras do manager** com [`collector/wazuh-local_rules.xml`](../collector/wazuh-local_rules.xml) (SR-19).
4. **Em máquinas já instaladas, rode o script novo.** Sem isso, a próxima atualização do pacote `tlog` impede o login de todos os usuários gravados (SR-05). Se o script avisar que o agente lê o log do tlog, remova esse `<localfile>` do `ossec.conf`.

## Como foi feito

- Leitura de todo o código em `src/`, `collector/` e `scripts/`, além de `npm audit` nas dependências de produção (nenhuma vulnerabilidade).
- Provas isoladas em Node, com memória limitada, para os ataques que poderiam derrubar o laboratório.
- Provas de ponta a ponta no laboratório Docker com a plataforma Wazuh 4.14.9: gravações reais feitas por um usuário comum, documentos forjados com a credencial real de escrita e os perfis `admin`, `analista` e `sem_acesso`.
- Os mesmos ataques repetidos depois da correção, mais 23 testes novos em `test/security.test.js`. A suíte completa, com 125 testes, passa.

Dados e usuários criados para os testes foram removidos do laboratório.

## Achados corrigidos

### Severidade alta

#### SR-01. Usuário gravado trava o dashboard com sequências de terminal

- **Onde:** `terminalLines` em `src/lib/session_events.js`.
- **Causa:** a sequência `ESC[2000@`, de inserir espaços, fazia a linha crescer sem limite. Cada inserção ficava mais cara que a anterior.
- **Quem explora:** qualquer usuário gravado. A análise roda sozinha quando um analista abre a lista.
- **Evidência:**

| Teste | Antes | Depois |
|---|---|---|
| Gravação real de 28 KB, com outra rota medida durante a análise | Dashboard sem responder por 8,1 s | Não se aplica |
| Gravação real de 280 KB, somada a 20 mil falsos comandos | Não testado, para não derrubar o laboratório | Análise em 0,15 s; outra rota em 0,01 s |
| Prova isolada com 64 KB | 47 s e 438 MB | Não medido nesse tamanho |
| Prova isolada com 256 KB | Interrompida depois de minutos, sem terminar | Não medido nesse tamanho |
| Prova isolada com 1 MB | Não chegou a rodar | 29 ms e 51 MB |

- **Correção:** a linha nunca passa de 2.000 caracteres, e há um teto de trabalho de edição por sessão. Ao atingi-lo, a análise avisa que pode ter deixado comandos de fora.

#### SR-02. Quebras de linha esgotam a memória do servidor

- **Onde:** `terminalLines` em `src/lib/session_events.js`.
- **Causa:** cada quebra de linha virava um objeto em memória antes de ser analisada.
- **Evidência:** 40 MB de quebras de linha estouraram um processo limitado a 512 MB (`heap out of memory`). Esse tamanho cabe nos limites da gravação. O ataque não foi executado contra o dashboard real.
- **Correção:** as linhas agora são lidas uma por vez. Os mesmos 40 MB levam cerca de 2,2 s, sem estourar a memória.

#### SR-03. Expressão regular lenta com texto preparado

- **Onde:** regra de `rm` em `src/lib/session_events.js`.
- **Causa:** `-\w*[rf]\w*` faz retrocesso quadrático em uma opção longa, e o texto vem de quem está sendo gravado.
- **Evidência:** 2.000 linhas (4 MB) ocupavam o processo por **11,6 s**. Agora levam **132 ms**.
- **Correção:** a regra foi reescrita sem repetição ambígua. O novo teste cobre esta e outras linhas preparadas.

#### SR-04. Um único documento forjado derruba a lista para todos

- **Onde:** `parseListResponse` em `src/lib/queries.js` e `buildActivity` em `src/lib/activity.js`.
- **Causa:** um campo `time` absurdo, como `1e20`, fazia `toISOString` lançar erro, e a rota inteira falhava.
- **Quem explora:** quem tem a credencial de escrita, que fica em todas as máquinas e é legível pelo root de cada uma.
- **Evidência:** depois de indexar um único documento, a lista passou a responder **502 para admin e analista**, escondendo todas as sessões. Agora responde 200.
- **Correção:** toda conversão de hora passa por `src/lib/safe_time.js`, que devolve vazio em vez de lançar erro.

#### SR-05. Atualizar o pacote `tlog` impede o login dos usuários gravados

- **Onde:** script de instalação em `src/lib/install_script.js`.
- **Causa:** o setuid e o dono do `tlog-rec-session` eram ajustados à mão, e o `dpkg` os desfaz ao atualizar o pacote.
- **Evidência:** depois de reinstalar o pacote, o binário voltou a `root:root 755`, e o login falhou com `Permission denied` e `exit=1`. Uma atualização automática de segurança bastaria para bloquear todos os usuários gravados.
- **Correção:** o script registra o ajuste com `dpkg-statoverride`. Depois de uma nova reinstalação, o binário continuou `_tlog:_tlog 6755` e o login funcionou. O passo manual do README também mudou.

### Severidade média

#### SR-06. A credencial de escrita podia apagar e alterar gravações

- **Onde:** papel de escrita descrito na [instalação](instalacao.md#2-preparar-o-indexador).
- **Causa:** a permissão `indices:data/write/*` inclui apagar e atualizar. Com o root de uma máquina, um invasor obtém a senha e pode apagar gravações de outras.
- **Evidência:** com o papel antigo, apagar um documento pelo id respondeu 200. A credencial não conseguia ler nem buscar, o que limita o ataque a ids conhecidos.
- **Correção:** novo papel com `indices:admin/create`, `indices:admin/mapping/put`, `indices:data/write/bulk*` e `indices:data/write/index` em `tlog-*`. Apagar, apagar por `bulk` e atualizar passaram a responder 403, e a coleta real continuou funcionando.
- **Limite:** o indexador não separa criar de sobrescrever, então sobrescrever um id conhecido ainda responde 200. Veja R-02.

#### SR-07. Formas simples de escapar da detecção de comandos críticos

- **Onde:** regras e tela alternativa em `src/lib/session_events.js`.
- **Evidência:** `printf '\033[?1049h'` fazia a análise ignorar o resto da sessão. Também não eram reconhecidos `/bin/rm -rf`, `\rm -rf`, `rm --recursive --force`, `command rm`, `env rm`, `find -delete`, `| /bin/sh` e `/usr/bin/sudo`.
- **Correção:** todos esses casos agora são reconhecidos, assim como `bash -c "rm -rf x"` e `eval "rm -rf x"`. O que aparece na tela alternativa continua sendo analisado, com um aviso de que pode ser só texto exibido por um programa, como o `less`. Isso pode gerar alguns falsos positivos, escolha adequada para uma ferramenta de investigação. Veja o que continua de fora em R-04.

#### SR-08. Números absurdos chegavam até o player

- **Onde:** `src/lib/tlog2asciicast.js`.
- **Causa:** `+999…9` virava `Infinity`, gravado como `null` no arquivo do player, e o tamanho de janela não tinha teto.
- **Evidência:** um documento forjado com janela de 65535x65535 era devolvido sem alteração. O efeito no navegador não foi medido. A tentativa de provocar isso com `stty` dentro da sessão não funcionou: o `tlog` lê o terminal externo.
- **Correção:** valores acima do limite invalidam a mensagem, com aviso. A janela fica limitada a 1000x500 e `pos` inválido é ignorado.

#### SR-09. Sem limite de tamanho nem de análises simultâneas

- **Onde:** `fetchAllChunks` em `src/lib/queries.js` e rotas em `src/server/index.js`.
- **Causa:** só a quantidade de pedaços era limitada, e um documento forjado pode ter qualquer tamanho. Várias telas abertas somavam dezenas de MB por análise.
- **Correção:** teto de 64 milhões de caracteres por gravação, com aviso. No servidor, são 6 análises simultâneas e 200 na fila, somando todos os usuários. Além disso, a resposta é 429. O limite está coberto por testes, mas não foi feito teste de carga.

#### SR-10. Falsos comandos geravam uma resposta sem limite

- **Onde:** `detectCommands` em `src/lib/session_events.js`.
- **Causa:** com os alertas desligados ou sem permissão, a lista de eventos não tinha teto. Bastava imprimir milhões de linhas como `a@b:~$ sudo id` para gerar uma resposta enorme e sobrecarregar o navegador do analista.
- **Correção:** a lista para em 200 eventos e avisa quantos ficaram de fora. No teste real: 20 mil linhas, 200 eventos e o aviso de 19.800 omitidos. O replay continua mostrando tudo.
- **Limite:** um invasor pode usar isso para empurrar o comando real para fora da lista, mas o aviso aparece e a gravação continua completa.

#### SR-11. Sem registro de quem assistiu a cada sessão

- **Onde:** `src/server/index.js`.
- **Impacto:** gravações podem conter dados sensíveis, e não havia como saber quem as abriu pelo plugin.
- **Correção:** cada replay aberto gera `Replay aberto: {"user","rec","host","recordedUser"}` no log do dashboard, com aspas e quebras de linha escapadas. A leitura direta do índice não passa por aqui: veja R-08.

#### SR-12. Chave do repositório do Fluent Bit aceita sem conferência

- **Onde:** script de instalação.
- **Causa:** a chave era baixada e aceita direto, e ela define em quais pacotes o sistema confia como root.
- **Correção:** o script compara a impressão digital `C3C0A28534B9293EAF51FABD9F9DDC083888C1CD`, a mesma publicada na [documentação do Fluent Bit](https://docs.fluentbit.io/manual/installation/downloads/linux). Com um valor adulterado, o script parou antes de instalar. Se o projeto trocar a chave, será preciso atualizar o valor.

#### SR-19. O início das sessões era copiado para os alertas

- **Onde:** script de instalação e [`collector/wazuh-local_rules.xml`](../collector/wazuh-local_rules.xml).
- **Causa:** o agente lia o log do tlog, e a regra `100501` gerava um alerta com o primeiro pedaço da sessão em `data.out_txt` e `full_log`. Quem lia alertas via esse trecho mesmo sem acesso a `tlog-*`.
- **Decisão:** nada no plugin usa esse alerta, então as sessões agora vão só pelo Fluent Bit. O script deixa de configurar o agente e avisa se ele já lê o log, e a regra ficou em nível 0 para proteger essas máquinas. A plataforma Wazuh deixa de ter um alerta próprio de início de sessão gravada.
- **Evidência:** antes da mudança na regra, ela gerava alertas com o conteúdo. Depois, em um login SSH real com o agente ainda lendo o log: alertas `100501` ficaram em 18, alertas com `out_txt` ficaram em 17, e os de login foram de 14 para 15. A timeline continuou ligando o login à sessão.
- **Limite:** alertas gerados antes da mudança continuam no índice até a retenção apagá-los, inclusive os 17 do laboratório.

### Severidade baixa

| ID | Problema | Correção |
|---|---|---|
| SR-13 | `tlog.env` já existente mantinha a permissão anterior ao receber a senha nova | O arquivo é restringido antes da escrita. Testado partindo de `644`: terminou em `600 root` |
| SR-14 | Os passos de "Desfazer" deixavam a senha de escrita na máquina | O comando agora também apaga o `tlog.env` |
| SR-15 | Pela documentação do Fluent Bit, uma linha maior que o buffer faz ele parar de ler o arquivo. Não reproduzido aqui | `Skip_Long_Lines On` |
| SR-16 | `/install/defaults` mostrava o nome interno do indexador a usuários sem acesso | Agora exige leitura de `tlog-*`: `sem_acesso` recebe 403 |
| SR-17 | `tlog-record-all`: o ponto do nome funcionava como curinga (`sec.a` e `secba`), o grupo `no-sudo` passava por `sudo`, a lista de exceções era legível por todos, e trocas seguidas de shell poderiam atingir o limite de reinícios do `systemd` | Corrigidos e testados de ponta a ponta. O `status` também passou a mostrar contas de sistema com shell, como o root |
| SR-18 | O formulário aceitava IPs inválidos, como `999.1.1.1` e `abcd`, que iriam para o `/etc/hosts` | A validação foi refeita. Não havia injeção: os caracteres aceitos já eram seguros |

## Bugs corrigidos

| ID | Problema | Correção |
|---|---|---|
| B-01 | Abrir uma sessão antes do fim da análise e clicar em um evento tentava saltar para um marcador inexistente. Encontrado na leitura do código, sem reproduzir na 0.8.1 | A gravação é recarregada com os marcadores. Testado no ambiente simulado, sem erros no console |
| B-02 | Alerta anterior ao primeiro dado gravado ficava em tempo negativo, fora da timeline | O tempo começa em zero |
| B-03 | Com mais de 500 agentes, a aba Instalar cortava a lista sem avisar | A tela informa que há mais agentes |
| B-04 | O link do download era revogado logo depois do clique, o que pode falhar em alguns navegadores | Revogado depois de 60 s |
| B-05 | `out_bin` com tipo errado fazia a rota da sessão responder 502 | O campo inválido é ignorado |
| B-06 | Uma gravação forjada podia gerar um aviso por mensagem | No máximo 20 avisos, mais a contagem do restante |
| B-07 | Sem terminal, o `tlog` grava janela `0x0`, que podia virar um redimensionamento inválido | O valor é ignorado |

## Riscos que continuam

Estes pontos não têm correção segura no código do plugin. As decisões abaixo foram tomadas a pedido do responsável pelo projeto, priorizando segurança sem arriscar o acesso às máquinas. O R-05 saiu da lista: virou o SR-19.

| ID | Risco | Evidência | Decisão | O que falta em produção |
|---|---|---|---|---|
| R-01 | **Dados sensíveis ficam legíveis no índice.** A saída pode trazer senhas digitadas em comandos, tokens e conteúdo de arquivos, e a busca do plugin alcança esse texto. | Por projeto | Aceito: mascarar na tela não protegeria o índice. A entrada continua desligada, e a retenção segue em 90 dias | Limitar `read` em `tlog-*` a poucas pessoas, criptografar o disco do indexador e avisar os usuários sobre a gravação |
| R-02 | **Gravações não são prova de origem.** `host` e `user` são declarados pelo próprio documento. Quem tem a credencial de escrita pode forjar sessões de outra máquina e sobrescrever ids conhecidos. | Documento forjado aceito; sobrescrita respondeu 200 | Aceito como limite do indexador. A tela mantém os avisos de pedaços ausentes ou repetidos. Tratar a gravação como indício | Criar um usuário de escrita por máquina e restringir a porta 9200 às máquinas gravadas |
| R-03 | **O usuário gravado controla a configuração de uma nova execução do `tlog`.** A variável `TLOG_REC_SESSION_CONF_TEXT` é aceita pelo binário setuid. | Criou `/tmp/sec1.log` como `_tlog`. O SSH padrão não repassa a variável no login, e opções de linha de comando foram recusadas. O efeito sobre a gravação externa e o volume possível de log não foram medidos | Não incluir AppArmor ou SELinux no script: um perfil sem teste real poderia impedir logins. O script também não altera o `sshd` | Manter `AcceptEnv` restrito e `PermitUserEnvironment no`. Avaliar um perfil de confinamento em ambiente de homologação |
| R-04 | **A detecção lê o que aparece na tela, e não o que foi executado.** Ela não vê scripts, aliases, conteúdo ofuscado nem prompt personalizado, e aceita falsos comandos impressos. Também ficam sem gravação: `ssh -N`, cron, `sftp` com `internal-sftp`, contas de sistema e LDAP/AD sem SSSD. Com gravação por usuário, ele pode usar `chsh` para sair dela no próximo login. | Por análise | "Todos os usuários" segue como padrão, porque reverte o `chsh`. O `status` agora mostra contas de sistema. `internal-sftp` não é ativado por padrão, para não abrir mais uma exceção à gravação | Usar `PermitRootLogin no` e conferir o `tlog-record-all status`. Usar `auditd` onde for preciso provar o que foi executado |
| R-06 | **O plugin não aplica o RBAC da plataforma Wazuh por agente.** Ele usa as permissões de índice do usuário logado. | Por análise | Manter as permissões de índice: elas valem também para quem acessa o indexador direto | Se precisar separar analistas por máquina, usar segurança por documento (DLS) em `tlog-*`. Não testado com o plugin |
| R-07 | **A análise roda na thread principal.** Os tetos limitam o tempo, mas a gravação máxima ainda ocupa o servidor por alguns segundos. | 40 MB levam cerca de 2 s | Não mover para `worker_threads` agora: hoje não compensa a complexidade. Rever se houver muitas gravações grandes | Nada |
| R-08 | **O registro de replay não cobre tudo.** Quem lê o índice direto, como pelo Dev Tools, não passa pelo plugin, e o log do dashboard precisa ser guardado para servir de auditoria. | Por análise | Manter o registro no log do dashboard | Ativar os logs de auditoria do indexador e enviar os logs a um local que os administradores do dashboard não alterem |
| R-09 | **Volume alto pode apagar evidência.** O log guarda até 3 rotações de 100 MB, e o buffer do Fluent Bit tem 500 MB. O `copytruncate` também pode perder o que chega durante a rotação. | Por configuração | Manter os limites: com o disco cheio, o `tlog` interrompe as sessões, e isso é pior | Monitorar o Fluent Bit e a aba Diagnóstico, e ajustar os limites conforme o disco |
| R-10 | **Laboratório não é produção.** `test-env/` e o laboratório usam senhas de teste e certificados próprios, e os arquivos dele continuam em pasta temporária. | Por projeto | Manter separado. A mudança do laboratório para a pasta permanente segue adiada, como combinado | Não reaproveitar credenciais nem configurações de teste |

## O que foi verificado e está correto

| Controle | Resultado |
|---|---|
| Rotas sem login | 401 em todas |
| Permissão no índice | `sem_acesso` recebe 403 em sessões e configurações. Em máquinas e diagnóstico recebe 200, sem dados: a tela diz o que falta |
| Alterar configurações | Analista recebe 403; sem o cabeçalho `osd-xsrf`, até o admin recebe 400 |
| Injeção na consulta | Filtros usam `term` e `match_phrase`; `user=*` não funciona como curinga |
| Caminhos e identificadores | `rec` e nome de arquivo inválidos recebem 400, inclusive `../` |
| XSS | Sem `innerHTML`: a tela só insere texto da gravação como conteúdo de texto |
| Entrada do usuário | `in_txt` não sai pela API, confirmado com um documento de teste |
| Cache | `private, no-cache, no-store` nas gravações |
| Script de instalação | Campos validados, senha fora da linha de comando e TLS validado com a CA |
| Credencial de escrita | Sem leitura, sem busca e sem acesso a outros índices |
| Dependências | `npm audit` sem vulnerabilidades |

## O que não foi testado

- As telas da 0.8.3 em uma instalação Wazuh real: o aviso de certificado impede o navegador integrado de abri-las. As rotas foram testadas em uma instalação Wazuh real, e a tela, no ambiente simulado.
- O script novo em Kali e Debian. Ele rodou por inteiro só no Ubuntu 24.04 do laboratório, e o Kali arm64 foi testado na versão anterior.
- O efeito de uma janela enorme no navegador, carga real no limite de análises e o `Skip_Long_Lines` com uma linha de verdade.
- Multi-tenancy, LDAP/AD, SSSD com o script novo e segurança por documento.
- Teste de invasão por terceiros: esta análise não substitui um.
