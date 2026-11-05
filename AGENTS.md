# Instructions for coding agents

- **To install the plugin:** follow [docs/en/agent-installation.md](docs/en/agent-installation.md) from "Instructions for the agent" on. It has confirmation points and rules for secrets. Do not skip them.
- **To change the code:** follow [docs/en/contributing.md](docs/en/contributing.md).
- **Run the tests** with `npm test`, and build with `npm run build -- --osd-version=2.19.6`.
- **Do not change** `src/public/index.js` without a reason: browsers keep it for up to a year.
- **Interface text** goes in both catalogs in `src/lib/messages/`.
- **Never commit** real recordings, passwords, private certificates or internal names.
