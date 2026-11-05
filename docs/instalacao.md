# Instalação

[English](en/installation.md)

São três partes: preparar o servidor, instalar o plugin no dashboard e configurar cada máquina que será gravada. Um agente como o Codex ou o Claude Code pode fazer isso seguindo a [instalação com um agente](instalacao-por-agente.md).

## Requisitos

- Wazuh dashboard baseado no OpenSearch Dashboards. Testado na plataforma Wazuh 4.14.9, com o OpenSearch Dashboards 2.19.6.
- Node.js e `npm`, em qualquer máquina, para compilar o pacote. Os testes usaram o Node.js 26.
- Máquinas Linux para gravar. O script automático atende Ubuntu 22.04 e 24.04, Debian 12 e 13 e Kali. Nas demais, siga a [instalação manual](instalacao-manual.md).

## 1. Compilar o pacote

A versão do build precisa ser igual à do OpenSearch Dashboards instalado, ou a instalação é recusada. Confira no servidor do dashboard:

```bash
grep -m1 '"version"' /usr/share/wazuh-dashboard/package.json
```

Depois, compile com esse número. A imagem da plataforma Wazuh 4.14.9 usa a 2.19.6:

```bash
npm run build -- --osd-version=2.19.6
```

## 2. Preparar o indexador

Aplique o modelo no Wazuh indexer. O comando pede a senha; use um usuário com permissão de administrar modelos:

```bash
curl -u admin --cacert root-ca.pem -X PUT "https://INDEXER:9200/_index_template/tlog" -H 'Content-Type: application/json' -d @collector/index-template.json
```

Crie também dois papéis no módulo de segurança do indexador. Os arquivos [collector/role-tlog-writer.json](../collector/role-tlog-writer.json) e [collector/role-tlog-reader.json](../collector/role-tlog-reader.json) trazem essas permissões:
- **Escrita (Fluent Bit):** a permissão de cluster `indices:data/write/bulk`, mais `indices:admin/create`, `indices:admin/mapping/put`, `indices:data/write/bulk*` e `indices:data/write/index` em `tlog-*`. Não use `indices:data/write/*`: ele permite apagar gravações, e a senha deste usuário fica em todas as máquinas.
- **Leitura (analistas):** `read` em `tlog-*`, em `wazuh-states-inventory-system-*` e em `wazuh-alerts-*`, somado ao papel `kibana_user` para entrar no dashboard. O plugin consulta os índices com as permissões do usuário logado. O inventário é necessário para abrir as sessões a partir de um agente. Sem `wazuh-alerts-*`, a lista continua funcionando, mas só mostra o que está na captura e exibe **Alertas indisponíveis**.

Defina por quanto tempo guardar as gravações. A política [collector/ism-policy.json](../collector/ism-policy.json) apaga cada índice diário `tlog-*` depois de 90 dias; ajuste `min_index_age` conforme a sua exigência de auditoria:

```bash
curl -u admin --cacert root-ca.pem -X PUT "https://INDEXER:9200/_plugins/_ism/policies/tlog-retention" -H 'Content-Type: application/json' -d @collector/ism-policy.json
```

A política vale automaticamente para os índices novos. Se já existirem índices `tlog-*`, associe-os a ela:

```bash
curl -u admin --cacert root-ca.pem -X POST "https://INDEXER:9200/_plugins/_ism/add/tlog-*" -H 'Content-Type: application/json' -d '{"policy_id":"tlog-retention"}'
```

Essa política não apaga os alertas em `wazuh-alerts-*`, que levam o primeiro trecho de cada sessão. Eles seguem a retenção configurada para os alertas Wazuh.

## 3. Instalar o plugin

Execute no servidor do dashboard e reinicie o serviço:

```bash
sudo -u wazuh-dashboard /usr/share/wazuh-dashboard/bin/opensearch-dashboards-plugin install file:///caminho/tlogReplay-VERSAO_osd-2.19.6.zip
```

```bash
sudo systemctl restart wazuh-dashboard
```

**Ao atualizar o plugin:** reinstale o `.zip` e reinicie o dashboard. Depois de recarregar a página, os usuários recebem a nova versão, sem limpar nada; a versão em uso aparece no rodapé do app. Mudanças no carregador são a exceção: quem usou uma versão anterior à 0.3.0 precisa limpar os dados desse site uma vez para ver o ícone da sidebar.

## 4. Configurar as regras do manager

Copie `collector/wazuh-local_rules.xml` para o `local_rules.xml` do manager. Ele impede alertas com o conteúdo das sessões em máquinas onde o agente lê o log do tlog. Os alertas de login e sudo usados na timeline já vêm da plataforma Wazuh manager, e o agente não precisa ler esse log. Se ele já lê, remova o `<localfile>` de `/var/log/tlog/tlog.log` do `ossec.conf`.

## 5. Configurar cada máquina

**Um coletor é obrigatório.** O plugin só lê o índice `tlog-*`: ele não coleta nada e não inclui o Fluent Bit. Sem coletor, o dashboard abre normalmente, mas a lista de sessões fica vazia. O Wazuh agent não substitui o coletor, porque só gera os alertas.

- **Ubuntu, Debian e Kali:** use a aba **Instalar** do plugin, que gera o script. Veja o [guia de uso](uso.md#instalar).
- **Outras distribuições, ou para conferir o que o script faz:** siga a [instalação manual](instalacao-manual.md).

Se algo não funcionar, veja a [solução de problemas](solucao-de-problemas.md).
