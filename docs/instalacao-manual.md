# Instalação manual em uma máquina gravada

A aba **Instalar** do plugin faz estes passos em Ubuntu, Debian e Kali, menos a preparação do servidor, descrita na [instalação](instalacao.md). Os passos abaixo valem para as demais distribuições e para conferir o que o script faz.

Os passos abaixo foram testados no Ubuntu 24.04. Em outras distribuições, os nomes mudam; veja a [instalação oficial do Fluent Bit](https://docs.fluentbit.io/manual/installation/getting-started-with-fluent-bit). O script [test-env/provision.sh](../test-env/provision.sh) reúne estes passos.

## Instalar e preparar o tlog

```bash
sudo apt-get install -y tlog
```

O pacote do Ubuntu não ativa o setuid, e o usuário dele se chama `_tlog` (no Fedora, `tlog`). Ajuste o binário e crie o log antes do primeiro login, o que evita erro no agente e a espera de cerca de 60 s do Fluent Bit:

```bash
sudo chown _tlog:_tlog /usr/bin/tlog-rec-session && sudo chmod 6755 /usr/bin/tlog-rec-session
```

Registre esse ajuste no `dpkg`. Sem isso, a próxima atualização do pacote o desfaz, e os usuários gravados deixam de conseguir entrar:

```bash
sudo dpkg-statoverride --add _tlog _tlog 6755 /usr/bin/tlog-rec-session
```

```bash
sudo install -d -o _tlog -g _tlog -m 750 /var/log/tlog && sudo install -o _tlog -g _tlog -m 600 /dev/null /var/log/tlog/tlog.log
```

Copie `collector/tlog-rec-session.conf` para `/etc/tlog/tlog-rec-session.conf` e escolha como ativar a gravação:
- **Por grupo, com SSSD:** copie `collector/sssd-session-recording.conf` para `/etc/sssd/conf.d/`, com permissão `600`. Testado no Fedora.
- **Por usuário:** defina o shell de login do usuário como o gravador. Testado no Ubuntu:

```bash
sudo usermod -s /usr/bin/tlog-rec-session USUARIO
```

Mantenha uma conta administrativa sem gravação até confirmar o login, pois um erro no shell pode impedir o acesso.

## Instalar o Fluent Bit

Baixe a chave do repositório e confira se a impressão digital é `C3C0 A285 34B9 293E AF51 FABD 9F9D DC08 3888 C1CD`, a publicada na [documentação do Fluent Bit](https://docs.fluentbit.io/manual/installation/downloads/linux). Só continue se for igual:

```bash
curl -fsS https://packages.fluentbit.io/fluentbit.key -o fluentbit.key && gpg --show-keys --fingerprint fluentbit.key
```

```bash
sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/fluentbit.gpg fluentbit.key
```

```bash
echo 'deb [signed-by=/usr/share/keyrings/fluentbit.gpg] https://packages.fluentbit.io/ubuntu/noble noble main' | sudo tee /etc/apt/sources.list.d/fluent-bit.list
```

```bash
sudo apt-get update && sudo apt-get install -y fluent-bit
```

## Configurar o Fluent Bit

1. Copie `collector/fluent-bit.conf` para `/etc/fluent-bit/fluent-bit.conf`.
2. Copie a CA do indexador para `/etc/fluent-bit/root-ca.pem`.
3. Crie `/etc/fluent-bit/tlog.env`, com dono root e permissão `600`, usando o usuário de escrita criado na [preparação do indexador](instalacao.md#2-preparar-o-indexador):

```ini
WAZUH_INDEXER_HOST=endereco-do-indexador
TLOG_WRITER_USER=tlog_writer
TLOG_WRITER_PASSWORD=senha-do-usuario
```

4. Crie `/etc/systemd/system/fluent-bit.service.d/tlog.conf` para o serviço ler esse arquivo:

```ini
[Service]
EnvironmentFile=/etc/fluent-bit/tlog.env
```

5. Crie o diretório de estado e inicie o serviço:

```bash
sudo install -d -m 750 /var/lib/fluent-bit && sudo systemctl daemon-reload && sudo systemctl enable --now fluent-bit
```

O nome em `WAZUH_INDEXER_HOST` precisa constar no certificado do indexador, porque a configuração valida o TLS. O serviço roda como root, o que permite ler o `tlog.log`, criado com permissão `600`.

## Configurar os alertas

Copie as regras para o manager, como descrito na [instalação](instalacao.md#4-configurar-as-regras-do-manager).

## Limitar o uso de disco

O tlog não apaga nem rotaciona o próprio log. **Com o disco cheio, ele interrompe a sessão gravada** (`Failed logging terminal data`), então o limite é necessário também para manter o acesso às máquinas.

Instale o logrotate e ative a rotação, que confere o log a cada 5 minutos:

```bash
sudo apt-get install -y logrotate
```

```bash
sudo cp collector/tlog-logrotate.conf /etc/tlog/logrotate.conf
```

```bash
sudo cp collector/tlog-logrotate.service collector/tlog-logrotate.timer /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now tlog-logrotate.timer
```

| Limite | Valor | Onde mudar |
|---|---|---|
| Rotação do `tlog.log` | A cada hora ou ao passar de 100 MB, com 3 arquivos antigos compactados | `collector/tlog-logrotate.conf` |
| Taxa de gravação | Cerca de 16 KiB/s por sessão, com `delay` | `limit` em `collector/tlog-rec-session.conf` |
| Buffer do Fluent Bit | 500 MB | `storage.total_limit_size` em `collector/fluent-bit.conf` |
| Índices no Wazuh indexer | 90 dias | `collector/ism-policy.json` |

Como esses limites afetam o uso:
- **Disco necessário:** reserve pelo menos 1 GB para `/var/log/tlog` e mais 500 MB para `/var/lib/fluent-bit`. Uma partição própria protege o resto do sistema, mas uma partição pequena demais encerra as sessões mais cedo.
- **Terminal mais lento:** com `delay`, comandos com muita saída demoram mais. Nos testes, 540 KB levaram 36 s. A opção `drop` não atrasa, mas descarta trechos, o que permite esconder atividade com muita saída.
- **Perda de gravações:** o que o Fluent Bit não leu é perdido depois de 3 rotações. Se ele ficar parado por cerca de 3 horas com atividade, ou menos em picos de volume, parte das gravações não chega ao Wazuh indexer indexer. Com o indexador fora do ar, o limite do buffer descarta os dados mais antigos.
- **Janela do `copytruncate`:** o que for gravado entre a cópia e o truncamento pode se perder. Isso não aconteceu nos testes, mas o risco existe.
- **Sessões já abertas:** o limite de taxa só vale para sessões iniciadas depois da mudança.

## Confirmar o funcionamento

Abra uma sessão com o usuário gravado e confira o serviço e os erros na máquina:

```bash
systemctl is-active fluent-bit wazuh-agent
```

```bash
sudo journalctl -u fluent-bit -n 30 --no-pager
```

Em seguida, a sessão deve aparecer no **Session Replay** em alguns segundos.
