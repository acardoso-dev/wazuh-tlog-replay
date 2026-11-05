# Solução de problemas

[English](en/troubleshooting.md)

Comece conferindo os serviços e os erros na máquina gravada:

```bash
systemctl is-active fluent-bit wazuh-agent
```

```bash
sudo journalctl -u fluent-bit -n 30 --no-pager
```

A aba **Diagnóstico** do plugin mostra as permissões do seu usuário, as gravações recebidas e a última gravação de cada máquina.

## Sintomas comuns

| Sintoma | Causa provável |
|---|---|
| `HTTP status=401` no log | Credenciais erradas, ou `tlog.env` não carregado |
| `HTTP status=403` no log | Papel `tlog_writer` sem as permissões da [preparação do indexador](instalacao.md#2-preparar-o-indexador) |
| Erro de certificado no log | CA errada, ou nome do indexador fora do certificado |
| `Failed removing lock file` ao sair | Binário com dono diferente do diretório `/run/tlog` |
| Lista vazia, sem erros no log | Usuário sem gravação ativa, ou `tlog.log` ainda vazio |
| Sessão cai com `Failed logging terminal data` | Disco cheio onde fica o `tlog.log` |

## Pontos que apareceram nos testes

- **Comandos e transferências:** `ssh host comando` é gravado como uma sessão separada. O `scp` também gera uma sessão, sem o conteúdo do arquivo.
- **Validar as regras antes de reiniciar:** uma regra inválida causa erro crítico no `analysisd`, que para de analisar eventos. Teste com `/var/ossec/bin/wazuh-logtest`, de preferência fora de produção.
- **Locale:** o `tlog-rec` falhou em contêiner sem TTY, locale UTF-8 e `utmp`, com a mensagem `Failed setting up the I/O tap`.
