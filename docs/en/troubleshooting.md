# Troubleshooting

[Português](../solucao-de-problemas.md)

Start by checking the services and the errors on the recorded host:

```bash
systemctl is-active fluent-bit wazuh-agent
```

```bash
sudo journalctl -u fluent-bit -n 30 --no-pager
```

The plugin's **Diagnostics** tab shows your user's permissions, the recordings received and the last recording of each host.

## Common symptoms

| Symptom | Likely cause |
|---|---|
| `HTTP status=401` in the log | Wrong credentials, or `tlog.env` not loaded |
| `HTTP status=403` in the log | `tlog_writer` role without the permissions from [Prepare the indexer](installation.md#2-prepare-the-indexer) |
| Certificate error in the log | Wrong CA, or the indexer name is not in the certificate |
| `Failed removing lock file` on exit | Binary with a different owner from the `/run/tlog` directory |
| Empty list, no errors in the log | User without recording enabled, or `tlog.log` still empty |
| Session drops with `Failed logging terminal data` | Full disk where `tlog.log` is stored |

## Points that came up in the tests

- **Commands and transfers:** `ssh host command` is recorded as a separate session. `scp` also generates a session, without the file content.
- **Validate the rules before restarting:** an invalid rule causes a critical error in `analysisd`, which stops analyzing events. Test with `/var/ossec/bin/wazuh-logtest`, preferably outside production.
- **Locale:** `tlog-rec` failed in a container without a TTY, a UTF-8 locale and `utmp`, with the message `Failed setting up the I/O tap`.
