# Situação dos testes

Esta tabela diz o que já foi verificado e o que ainda não foi. Use-a para decidir o que validar antes de instalar em produção.

Testes feitos em contêineres, na plataforma Wazuh 4.14.9 single-node (OpenSearch Dashboards 2.19.6), com tlog 14, SSSD 2.13 e Fluent Bit 5.1, em arm64.

| Parte | Situação |
|---|---|
| Conversor tlog → asciicast | Testado com gravação real |
| Instalação do plugin, API, permissões e filtros | Testados em uma instalação Wazuh real |
| Replay dentro da plataforma Wazuh dashboard real | Confirmado manualmente |
| Aba e item do menu na tela do agente | Presença confirmada manualmente em uma instalação Wazuh real |
| Ícone na sidebar e card na home | Presença confirmada manualmente em uma instalação Wazuh real |
| Filtro por agente | Testado em uma instalação Wazuh real, pela API e na tela |
| Timeline de atividade em cada sessão | API testada em uma instalação Wazuh real; presença na tela confirmada manualmente |
| Comandos críticos e alertas por sessão | API testada em uma instalação Wazuh real, com e sem permissão nos alertas, em poucas sessões de uma única máquina; presença na tela confirmada manualmente |
| Links de horário e layout responsivo | Larguras e salto testados no harness, em 1920, 1280, 900 e 375 px; funcionamento confirmado manualmente em uma instalação Wazuh real |
| Rotas de configurações e diagnóstico, permissões, conflito entre administradores, migração do `.kibana`, remoção e reinstalação do plugin | Testados em uma instalação Wazuh real, com multi-tenancy desligado |
| Telas de Configurações e Diagnóstico | Fluxos e larguras de 1280 e 375 px testados no harness; funcionamento confirmado manualmente em uma instalação Wazuh real |
| Aba Instalar e script gerado | Script testado em Kali arm64 em contêiner com `systemd`, com Wazuh agent sem manager, incluindo senha errada, segunda execução e sessão real chegando ao índice. Tela testada no harness, em 1280 e 375 px. **Não testado** em VM real nem em Ubuntu/Debian |
| Gravar todos os usuários (`tlog-record-all`) | Testado em Kali arm64 em contêiner: recusas de segurança, `useradd`, `adduser`, troca de shell, reinício, `ssh` com e sem terminal, sessão chegando ao índice e reversão. **Não testado** em VM real nem com LDAP/AD |
| Correções de segurança da 0.8.2 e 0.8.3 | Rotas, ataques reais e papel mínimo de escrita testados em uma instalação Wazuh real; script completo testado no Ubuntu 24.04 do laboratório. Telas testadas no harness. Detalhes em [analise-de-seguranca.md](analise-de-seguranca.md) |
| Multi-tenancy com as configurações | **Não testado** |
| Formatos de prompt de zsh e macOS | Testados com zsh e bash reais do macOS, em um terminal capturado sem o tlog; **não testados** em uma gravação real |
| `auditd` | Não funciona neste contêiner e **não foi testado** de ponta a ponta |
| Atualização do plugin sem limpar o cache | Confirmada manualmente em uma instalação Wazuh real, de 0.2.1 para 0.2.2 com F5 |
| Ubuntu 24.04 com SSH, `tlog-rec-session`, agente e Fluent Bit em `systemd` | Testado de ponta a ponta em contêiner, do login ao índice e ao alerta |
| SSSD com `tlog-rec-session` | Testado no Fedora, com `su` e domínio proxy; LDAP/AD e SSSD no Ubuntu não foram testados |
| Rotação durante uma sessão aberta | Testada no Ubuntu: 8 rotações forçadas em 41 s, sem perda nem repetição das 6.000 linhas no replay |
| Limite de taxa, rotação por tamanho, limite do buffer e retenção | Testados em contêiner, com valores reduzidos no buffer e na retenção |
| Disco cheio | Testado com `tlog-rec`, em um disco temporário de 200 KB: a sessão é interrompida |
| Volume alto, muitas sessões simultâneas e semanas de uso | **Não testados** |
| Máquina física ou virtual, e arquitetura amd64 | **Não testadas** |

A versão 0.8.4 só mudou textos, o logo do cabeçalho e os avisos de licença do pacote. A rotina de testes automatizados está em [CONTRIBUTING.md](../CONTRIBUTING.md).
