# Test status

[Português](../testes.md)

This table says what has been verified and what has not. Use it to decide what to validate before installing in production.

Tests were done in containers, on the Wazuh platform 4.14.9 single-node (OpenSearch Dashboards 2.19.6), with tlog 14, SSSD 2.13 and Fluent Bit 5.1, on arm64.

| Part | Status |
|---|---|
| tlog → asciicast converter | Tested with a real recording |
| Plugin installation, API, permissions and filters | Tested on a real Wazuh installation |
| Replay inside the real Wazuh dashboard | Confirmed manually |
| Tab and menu item on the agent page | Presence confirmed manually on a real Wazuh installation |
| Sidebar icon and home card | Presence confirmed manually on a real Wazuh installation |
| Agent filter | Tested on a real Wazuh installation, through the API and on screen |
| Activity timeline in each session | API tested on a real Wazuh installation; presence on screen confirmed manually |
| Critical commands and alerts per session | API tested on a real Wazuh installation, with and without permission on alerts, on a few sessions from a single host; presence on screen confirmed manually |
| Time links and responsive layout | Widths and jumps tested in the harness, at 1920, 1280, 900 and 375 px; operation confirmed manually on a real Wazuh installation |
| Settings and diagnostics routes, permissions, conflict between administrators, `.kibana` migration, plugin removal and reinstallation | Tested on a real Wazuh installation, with multi-tenancy off |
| Settings and Diagnostics screens | Flows and widths of 1280 and 375 px tested in the harness; operation confirmed manually on a real Wazuh installation |
| Install tab and generated script | Script tested on Kali arm64 in a container with `systemd`, with a Wazuh agent and no manager, including a wrong password, a second run and a real session reaching the index. Screen tested in the harness, at 1280 and 375 px. **Not tested** on a real VM or on Ubuntu/Debian |
| Record all users (`tlog-record-all`) | Tested on Kali arm64 in a container: safety refusals, `useradd`, `adduser`, shell change, restart, `ssh` with and without a terminal, session reaching the index and rollback. **Not tested** on a real VM or with LDAP/AD |
| Security fixes in 0.8.2 and 0.8.3 | Routes, real attacks and the minimal writer role tested on a real Wazuh installation; complete script tested on the lab's Ubuntu 24.04. Screens tested in the harness. Details in [security-analysis.md](security-analysis.md) |
| Language switch (0.9.0) | Screens and switching in both languages tested in the harness. Installed on a real Wazuh installation, where the routes answered according to the header, with English for unknown or missing values. English script run to the end on the lab's Ubuntu 24.04. **Not tested:** the selector on screen in the real dashboard |
| Installation with an agent | Script generator, roles, password read from a file, index count and rule validation tested in the lab. Mapping creation tested with a temporary role. **Not tested:** a complete run by an agent, and a package installation outside containers |
| Multi-tenancy with the settings | **Not tested** |
| zsh and macOS prompt formats | Tested with real zsh and bash on macOS, in a terminal captured without tlog; **not tested** on a real recording |
| `auditd` | Does not work in this container and was **not tested** end to end |
| Plugin update without clearing the cache | Confirmed manually on a real Wazuh installation, from 0.2.1 to 0.2.2 with F5 |
| Ubuntu 24.04 with SSH, `tlog-rec-session`, agent and Fluent Bit under `systemd` | Tested end to end in a container, from login to index and alert |
| SSSD with `tlog-rec-session` | Tested on Fedora, with `su` and a proxy domain; LDAP/AD and SSSD on Ubuntu were not tested |
| Rotation during an open session | Tested on Ubuntu: 8 forced rotations in 41 s, with no loss or repetition of the 6,000 lines in the replay |
| Rate limit, rotation by size, buffer limit and retention | Tested in a container, with reduced values for the buffer and retention |
| Full disk | Tested with `tlog-rec`, on a temporary 200 KB disk: the session is interrupted |
| High volume, many simultaneous sessions and weeks of use | **Not tested** |
| Physical or virtual machine, and amd64 architecture | **Not tested** |

The automated test routine is in the [contributing guide](contributing.md).
