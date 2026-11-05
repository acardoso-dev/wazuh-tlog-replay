# How to contribute

[Português](../../CONTRIBUTING.md)

Thanks for your interest. Issues and pull requests can be written in English or Portuguese.

## Before you start

- **Security flaw:** do not open a public issue. Follow the [security policy](security-policy.md).
- **Bug:** confirm that you are on the latest version and see [troubleshooting](troubleshooting.md) and the [limitations](limitations.md). In the issue, give the versions and the steps to reproduce.
- **Large change:** open an issue first, to agree on the approach.

By contributing, you state that you have the rights to the submitted content and agree to make it available under the [Apache-2.0 license](../../LICENSE).

## Environment

The project's tests use Node.js 26.

```bash
npm ci
```

```bash
npm test
```

To build, give the target OpenSearch Dashboards version. The Wazuh platform 4.14.9 uses 2.19.6:

```bash
npm run build -- --osd-version=2.19.6
```

To open the simulated environment at `http://localhost:5687`, after building:

```bash
npm run harness
```

It needs no real server, and the data stays in memory. With `HARNESS_READONLY=1`, it simulates a user without permission to change the settings.

The [test-env/](../../test-env/) folder has an Ubuntu test machine, with `systemd` and SSH, that connects to a Wazuh installation in Docker. It runs with `--privileged`, so it is for local tests only.

## Pull requests

- Add or adjust tests for the change, and run `npm test`.
- Update the documentation, in both languages, and the [changelog](changelog.md).
- Put new interface text in both catalogs in `src/lib/messages/`, with stable IDs. Do not build messages from fragments. Script messages cannot have apostrophes, because they stay inside single quotes in the shell.
- Check the screen in the simulated environment, at widths of 1280 and 375 px, in both languages, if it changed. Update the images with `npm run screenshots`.
- Avoid changing `src/public/index.js`. Browsers keep this file for up to a year. See the [architecture](architecture.md#loader-and-updates-without-clearing-the-cache).
- Treat host, user and commands as untrusted data, because they come from the recorded hosts. Do not use `innerHTML`.
- Do not submit real recordings, passwords, private certificates or internal names. Use only fictional data in `samples/` and in the tests.

## Commits

We follow the rule of the [Wazuh plugins](https://github.com/wazuh/wazuh-dashboard-plugins/blob/main/CONTRIBUTING.md): in English, with an imperative title of up to 50 characters, no final period, and a body separated by a blank line.

## Style

Follow the existing code and the [style guide of the Wazuh plugins](https://github.com/wazuh/wazuh-dashboard-plugins/blob/main/STYLEGUIDE.md) where it applies. The current differences are in [best practices](best-practices.md).
