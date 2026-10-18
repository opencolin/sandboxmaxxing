# Repository Guidelines

## Project Structure

- `index.html` is the self-contained static front end; there is no front-end build step.
- `broker/` contains the Node.js ES module service. `broker/broker.js` serves the site and APIs; `broker/maxx.js` runs agent teams. `broker/teams/*.json` holds team rosters, and `broker/seat/` contains seat utilities.
- `skills/` contains reusable agent skills. `design-maxx/` holds design exports. `deploy/` contains deployment configuration.
- `README.md`, `PRD.md`, and `HANDOFF.md` describe the product, requirements, and deployment state.

## Build and Development

- `cd broker && npm install` installs the broker dependency.
- `cd broker && npm start` starts the service (port 8080 by default); configure required credentials and settings in `broker/.env` as documented in `broker.js`.
- Open `index.html` directly for static UI work.
- `node --check broker/broker.js` and `node --check broker/maxx.js` check JavaScript syntax. There is no configured test or lint command.

## Style and Data Conventions

Use plain JavaScript ES modules, two-space indentation, double-quoted strings, and semicolons, matching the existing broker files. Name JavaScript variables and functions in `camelCase`; use uppercase for constants. Keep team templates valid JSON in `broker/teams/`, following the existing seat schema. Keep the front end self-contained unless a change clearly requires new assets or tooling.

## Verification

For broker changes, run the syntax checks above and start the service when configuration is available. For UI changes, open `index.html` and inspect the affected desktop and mobile layouts. Validate edited team templates with a JSON parser. No automated test suite or coverage threshold is currently configured.

## Commits and Pull Requests

Recent commits use short, descriptive subjects, often with a component prefix such as `Broker:` or `Nav:`. Follow that pattern and keep each commit focused. PRs should explain the behavior change, list manual checks performed, link related issues when applicable, and include screenshots for visible UI changes.

## Security and Configuration

Never commit real API keys, relay tokens, or other credentials. Keep secrets in local broker configuration and preserve the broker's server-side credential handling and per-session token boundaries when changing relay or sandbox code.
