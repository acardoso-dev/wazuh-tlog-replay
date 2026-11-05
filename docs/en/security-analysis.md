# Session Replay security analysis

[Português](../analise-de-seguranca.md)

**Version analyzed:** 0.8.1. **Fixed version:** 0.8.3. **Date:** November 5, 2026.

This document explains how each problem worked, for anyone running an old version or reviewing the project. All fixes are in 0.8.3 and later versions. To report a new flaw, see the [security policy](security-policy.md).

## Summary

The analysis covered the server, the interface, the install script, `tlog-record-all` and the collection configuration. There were 19 security findings and 7 bugs. All were addressed, but **SR-06** is only partial and also depends on an action in each installation. Another 9 risks have no fix in the code: the decision made for each one is in [Remaining risks](#remaining-risks).

**The most serious problem:** a regular recorded user, without root, could freeze the dashboard for everyone just by printing text in their own terminal. In the lab, 28 KB of output left the dashboard unresponsive for 8 s.

No authentication bypass, remote code execution, XSS or query injection was found. The plugin still never returns user input (`in_txt`).

| Severity | Fixed | Status |
|---|---|---|
| Critical | 0 | None found |
| High | 5 | SR-01 to SR-05 |
| Medium | 8 | SR-06 to SR-12 and SR-19; SR-06 is partial and requires action in each installation |
| Low | 6 | SR-13 to SR-18 |
| Bugs | 7 | B-01 to B-07 |

### What to do in each installation

On an installation before 0.8.3:

1. **Update the plugin** to 0.8.3 or later. The loader did not change: F5 is enough after restarting the dashboard.
2. **Reduce the writer role** on each indexer (SR-06), with the permissions described in the [installation](installation.md#2-prepare-the-indexer). Without this, the credential can still delete recordings.
3. **Update the manager rules** with [`collector/wazuh-local_rules.xml`](../../collector/wazuh-local_rules.xml) (SR-19).
4. **On hosts already installed, run the new script.** Without this, the next `tlog` package update prevents all recorded users from logging in (SR-05). If the script warns that the agent reads the tlog log, remove that `<localfile>` from `ossec.conf`.

## How it was done

- Reading all the code in `src/`, `collector/` and `scripts/`, plus `npm audit` on the production dependencies (no vulnerabilities).
- Isolated proofs in Node, with limited memory, for attacks that could bring down the lab.
- End-to-end proofs in the Docker lab with the Wazuh platform 4.14.9: real recordings made by a regular user, documents forged with the real writer credential, and the `admin`, `analista` and `sem_acesso` profiles.
- The same attacks repeated after the fix, plus 23 new tests in `test/security.test.js`. The complete suite, with 125 tests at the time, passes.

Data and users created for the tests were removed from the lab.

## Fixed findings

### High severity

#### SR-01. Recorded user freezes the dashboard with terminal sequences

- **Where:** `terminalLines` in `src/lib/session_events.js`.
- **Cause:** the `ESC[2000@` sequence, which inserts spaces, made the line grow with no limit. Each insertion was more expensive than the previous one.
- **Who can exploit it:** any recorded user. The analysis runs by itself when an analyst opens the list.
- **Evidence:**

| Test | Before | After |
|---|---|---|
| Real 28 KB recording, with another route measured during the analysis | Dashboard unresponsive for 8.1 s | Not applicable |
| Real 280 KB recording, plus 20 thousand fake commands | Not tested, to avoid bringing down the lab | Analysis in 0.15 s; other route in 0.01 s |
| Isolated proof with 64 KB | 47 s and 438 MB | Not measured at this size |
| Isolated proof with 256 KB | Stopped after minutes, without finishing | Not measured at this size |
| Isolated proof with 1 MB | Never got to run | 29 ms and 51 MB |

- **Fix:** a line never exceeds 2,000 characters, and there is a ceiling on editing work per session. When it is reached, the analysis warns that it may have left commands out.

#### SR-02. Line breaks exhaust the server memory

- **Where:** `terminalLines` in `src/lib/session_events.js`.
- **Cause:** each line break became an object in memory before being analyzed.
- **Evidence:** 40 MB of line breaks overran a process limited to 512 MB (`heap out of memory`). This size fits within the recording limits. The attack was not run against the real dashboard.
- **Fix:** lines are now read one at a time. The same 40 MB take about 2.2 s, without running out of memory.

#### SR-03. Slow regular expression with prepared text

- **Where:** the `rm` rule in `src/lib/session_events.js`.
- **Cause:** `-\w*[rf]\w*` backtracks quadratically on a long option, and the text comes from whoever is being recorded.
- **Evidence:** 2,000 lines (4 MB) kept the process busy for **11.6 s**. They now take **132 ms**.
- **Fix:** the rule was rewritten with no ambiguous repetition. The new test covers this and other prepared lines.

#### SR-04. A single forged document brings down the list for everyone

- **Where:** `parseListResponse` in `src/lib/queries.js` and `buildActivity` in `src/lib/activity.js`.
- **Cause:** an absurd `time` field, such as `1e20`, made `toISOString` throw an error, and the whole route failed.
- **Who can exploit it:** anyone with the writer credential, which is on every host and readable by root on each one.
- **Evidence:** after indexing a single document, the list started answering **502 to admin and analyst**, hiding all sessions. It now answers 200.
- **Fix:** all time conversion goes through `src/lib/safe_time.js`, which returns empty instead of throwing an error.

#### SR-05. Updating the `tlog` package prevents recorded users from logging in

- **Where:** install script in `src/lib/install_script.js`.
- **Cause:** the setuid bit and the owner of `tlog-rec-session` were adjusted by hand, and `dpkg` undoes that when updating the package.
- **Evidence:** after reinstalling the package, the binary went back to `root:root 755`, and login failed with `Permission denied` and `exit=1`. An automatic security update would be enough to lock out all recorded users.
- **Fix:** the script registers the change with `dpkg-statoverride`. After another reinstallation, the binary stayed `_tlog:_tlog 6755` and login worked. The manual step in the README also changed.

### Medium severity

#### SR-06. The writer credential could delete and alter recordings

- **Where:** writer role described in the [installation](installation.md#2-prepare-the-indexer).
- **Cause:** the `indices:data/write/*` permission includes deleting and updating. With root on one host, an intruder gets the password and can delete recordings from others.
- **Evidence:** with the old role, deleting a document by id answered 200. The credential could not read or search, which limits the attack to known ids.
- **Fix:** a new role with `indices:admin/create`, `indices:admin/mapping/put`, `indices:data/write/bulk*` and `indices:data/write/index` on `tlog-*`. Deleting, deleting through `bulk` and updating now answer 403, and the real collection kept working.
- **Limit:** the indexer does not separate creating from overwriting, so overwriting a known id still answers 200. See R-02.

#### SR-07. Simple ways to evade critical command detection

- **Where:** rules and alternate screen in `src/lib/session_events.js`.
- **Evidence:** `printf '\033[?1049h'` made the analysis ignore the rest of the session. Also not recognized were `/bin/rm -rf`, `\rm -rf`, `rm --recursive --force`, `command rm`, `env rm`, `find -delete`, `| /bin/sh` and `/usr/bin/sudo`.
- **Fix:** all these cases are now recognized, as are `bash -c "rm -rf x"` and `eval "rm -rf x"`. What appears on the alternate screen is still analyzed, with a warning that it may only be text shown by a program, such as `less`. This can generate some false positives, a suitable choice for an investigation tool. See what remains out in R-04.

#### SR-08. Absurd numbers reached the player

- **Where:** `src/lib/tlog2asciicast.js`.
- **Cause:** `+999…9` became `Infinity`, written as `null` in the player file, and the window size had no ceiling.
- **Evidence:** a document forged with a 65535x65535 window was returned unchanged. The effect on the browser was not measured. The attempt to cause this with `stty` inside the session did not work: `tlog` reads the outer terminal.
- **Fix:** values above the limit invalidate the message, with a warning. The window is limited to 1000x500, and an invalid `pos` is ignored.

#### SR-09. No limit on size or simultaneous analyses

- **Where:** `fetchAllChunks` in `src/lib/queries.js` and routes in `src/server/index.js`.
- **Cause:** only the number of chunks was limited, and a forged document can be any size. Several open screens added up to tens of MB per analysis.
- **Fix:** a ceiling of 64 million characters per recording, with a warning. On the server, there are 6 simultaneous analyses and 200 in the queue, across all users. Beyond that, the answer is 429. The limit is covered by tests, but no load test was done.

#### SR-10. Fake commands generated a response with no limit

- **Where:** `detectCommands` in `src/lib/session_events.js`.
- **Cause:** with alerts off or no permission, the list of events had no ceiling. Printing millions of lines like `a@b:~$ sudo id` was enough to generate a huge response and overload the analyst's browser.
- **Fix:** the list stops at 200 events and says how many were left out. In the real test: 20 thousand lines, 200 events and a warning of 19,800 omitted. The replay still shows everything.
- **Limit:** an intruder can use this to push the real command out of the list, but the warning appears and the recording stays complete.

#### SR-11. No record of who watched each session

- **Where:** `src/server/index.js`.
- **Impact:** recordings can contain sensitive data, and there was no way to know who opened them through the plugin.
- **Fix:** each replay opened generates `Replay aberto: {"user","rec","host","recordedUser"}` in the dashboard log, with quotes and line breaks escaped. Reading the index directly does not go through here: see R-08.

#### SR-12. Fluent Bit repository key accepted without verification

- **Where:** install script.
- **Cause:** the key was downloaded and accepted directly, and it defines which packages the system trusts as root.
- **Fix:** the script compares the fingerprint `C3C0A28534B9293EAF51FABD9F9DDC083888C1CD`, the same one published in the [Fluent Bit documentation](https://docs.fluentbit.io/manual/installation/downloads/linux). With a tampered value, the script stopped before installing. If the project changes the key, the value will need updating.

#### SR-19. The start of sessions was copied to alerts

- **Where:** install script and [`collector/wazuh-local_rules.xml`](../../collector/wazuh-local_rules.xml).
- **Cause:** the agent read the tlog log, and rule `100501` generated an alert with the first chunk of the session in `data.out_txt` and `full_log`. Anyone who read alerts saw that part even without access to `tlog-*`.
- **Decision:** nothing in the plugin uses this alert, so sessions now go through Fluent Bit only. The script no longer configures the agent and warns if it already reads the log, and the rule stayed at level 0 to protect those hosts. The Wazuh platform no longer has its own alert for the start of a recorded session.
- **Evidence:** before the rule change, it generated alerts with the content. Afterward, on a real SSH login with the agent still reading the log: `100501` alerts stayed at 18, alerts with `out_txt` stayed at 17, and login alerts went from 14 to 15. The timeline kept linking the login to the session.
- **Limit:** alerts generated before the change stay in the index until retention deletes them, including the 17 in the lab.

### Low severity

| ID | Problem | Fix |
|---|---|---|
| SR-13 | An existing `tlog.env` kept its earlier mode when receiving the new password | The file is restricted before writing. Tested starting from `644`: it ended as `600 root` |
| SR-14 | The "Undo" steps left the writer password on the host | The command now also deletes `tlog.env` |
| SR-15 | According to the Fluent Bit documentation, a line larger than the buffer makes it stop reading the file. Not reproduced here | `Skip_Long_Lines On` |
| SR-16 | `/install/defaults` showed the internal indexer name to users without access | It now requires reading `tlog-*`: `sem_acesso` gets 403 |
| SR-17 | `tlog-record-all`: the dot in a name worked as a wildcard (`sec.a` and `secba`), the `no-sudo` group passed for `sudo`, the list of exceptions was readable by everyone, and consecutive shell changes could reach the `systemd` restart limit | Fixed and tested end to end. `status` also started showing system accounts with a shell, such as root |
| SR-18 | The form accepted invalid IPs, such as `999.1.1.1` and `abcd`, which would go to `/etc/hosts` | The validation was redone. There was no injection: the accepted characters were already safe |

## Fixed bugs

| ID | Problem | Fix |
|---|---|---|
| B-01 | Opening a session before the analysis ended and clicking an event tried to jump to a marker that did not exist. Found while reading the code, without reproducing it on 0.8.1 | The recording is reloaded with the markers. Tested in the simulated environment, with no console errors |
| B-02 | An alert earlier than the first recorded data was at a negative time, outside the timeline | Time starts at zero |
| B-03 | With more than 500 agents, the Install tab cut the list without warning | The screen says there are more agents |
| B-04 | The download link was revoked right after the click, which can fail in some browsers | Revoked after 60 s |
| B-05 | `out_bin` with the wrong type made the session route answer 502 | The invalid field is ignored |
| B-06 | A forged recording could generate one warning per message | At most 20 warnings, plus a count of the rest |
| B-07 | Without a terminal, `tlog` records a `0x0` window, which could become an invalid resize | The value is ignored |

## Remaining risks

These points have no safe fix in the plugin code. The decisions below were made at the request of the project owner, prioritizing security without risking access to the hosts. R-05 left the list: it became SR-19.

| ID | Risk | Evidence | Decision | What is missing in production |
|---|---|---|---|---|
| R-01 | **Sensitive data stays readable in the index.** Output can include passwords typed in commands, tokens and file content, and the plugin's search reaches that text. | By design | Accepted: masking on screen would not protect the index. Input stays off, and retention stays at 90 days | Limit `read` on `tlog-*` to few people, encrypt the indexer disk and tell users about the recording |
| R-02 | **Recordings are not proof of origin.** `host` and `user` are declared by the document itself. Anyone with the writer credential can forge sessions from another host and overwrite known ids. | Forged document accepted; overwrite answered 200 | Accepted as an indexer limit. The screen keeps the warnings about missing or repeated chunks. Treat a recording as an indication | Create one writer user per host and restrict port 9200 to the recorded hosts |
| R-03 | **The recorded user controls the configuration of a new `tlog` run.** The `TLOG_REC_SESSION_CONF_TEXT` variable is accepted by the setuid binary. | Created `/tmp/sec1.log` as `_tlog`. Default SSH does not pass the variable at login, and command line options were refused. The effect on the outer recording and the possible log volume were not measured | Do not include AppArmor or SELinux in the script: a profile without real testing could prevent logins. The script also does not change `sshd` | Keep `AcceptEnv` restricted and `PermitUserEnvironment no`. Evaluate a confinement profile in a staging environment |
| R-04 | **Detection reads what appears on screen, not what was executed.** It does not see scripts, aliases, obfuscated content or custom prompts, and it accepts printed fake commands. Also unrecorded: `ssh -N`, cron, `sftp` with `internal-sftp`, system accounts and LDAP/AD without SSSD. With per-user recording, the user can use `chsh` to leave it at the next login. | By analysis | "All users" stays as the default, because it reverts `chsh`. `status` now shows system accounts. `internal-sftp` is not enabled by default, to avoid opening another exception to recording | Use `PermitRootLogin no` and check `tlog-record-all status`. Use `auditd` where you need to prove what was executed |
| R-06 | **The plugin does not apply Wazuh platform RBAC per agent.** It uses the index permissions of the logged-in user. | By analysis | Keep index permissions: they also apply to anyone accessing the indexer directly | If you need to separate analysts by host, use document-level security (DLS) on `tlog-*`. Not tested with the plugin |
| R-07 | **The analysis runs on the main thread.** The ceilings limit the time, but the largest recording still keeps the server busy for a few seconds. | 40 MB take about 2 s | Do not move to `worker_threads` now: today it is not worth the complexity. Review if there are many large recordings | Nothing |
| R-08 | **The replay record does not cover everything.** Anyone reading the index directly, such as through Dev Tools, does not go through the plugin, and the dashboard log must be kept to serve as an audit trail. | By analysis | Keep the record in the dashboard log | Enable the indexer audit logs and send the logs to a place dashboard administrators cannot change |
| R-09 | **High volume can erase evidence.** The log keeps up to 3 rotations of 100 MB, and the Fluent Bit buffer has 500 MB. `copytruncate` can also lose what arrives during a rotation. | By configuration | Keep the limits: with a full disk, `tlog` interrupts sessions, which is worse | Monitor Fluent Bit and the Diagnostics tab, and adjust the limits to the disk |
| R-10 | **A lab is not production.** `test-env/` and the lab use test passwords and their own certificates, and its files stay in a temporary folder. | By design | Keep them separate. Moving the lab to a permanent folder stays postponed, as agreed | Do not reuse test credentials or configurations |

## What was verified and is correct

| Control | Result |
|---|---|
| Routes without login | 401 on all |
| Index permission | `sem_acesso` gets 403 on sessions and settings. On hosts and diagnostics it gets 200, with no data: the screen says what is missing |
| Changing settings | Analyst gets 403; without the `osd-xsrf` header, even admin gets 400 |
| Query injection | Filters use `term` and `match_phrase`; `user=*` does not work as a wildcard |
| Paths and identifiers | Invalid `rec` and file name get 400, including `../` |
| XSS | No `innerHTML`: the screen only inserts recording text as text content |
| User input | `in_txt` does not leave through the API, confirmed with a test document |
| Cache | `private, no-cache, no-store` on recordings |
| Install script | Fields validated, password out of the command line and TLS validated with the CA |
| Writer credential | No reading, no searching and no access to other indices |
| Dependencies | `npm audit` with no vulnerabilities |

## What was not tested

- The 0.8.3 screens on a real Wazuh installation: the certificate warning prevents the built-in browser from opening them. The routes were tested on a real Wazuh installation, and the screen in the simulated environment.
- The new script on Kali and Debian. It ran in full only on the lab's Ubuntu 24.04, and Kali arm64 was tested on the previous version.
- The effect of a huge window on the browser, real load at the analysis limit and `Skip_Long_Lines` with an actual long line.
- Multi-tenancy, LDAP/AD, SSSD with the new script and document-level security.
- Penetration testing by third parties: this analysis does not replace one.
