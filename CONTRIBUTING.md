# Contributing

Thank you for considering a contribution.

## Development setup

```bash
npm ci
cp .env.example .env
npm run chain
npm run deploy:local
npm run dev
```

## Quality checks

Run before opening a pull request:

```bash
npm run format:check
npm run lint
npm run build
npm test
npm run test:e2e
npm audit --audit-level=critical --omit=dev
```

## Pull request expectations

A good PR should include:

- clear problem statement;
- focused code changes;
- tests for behavior changes;
- documentation updates when API or operations change;
- no generated local artifacts;
- no secrets or private keys.

## Commit style

Use clear conventional-style messages where practical:

```text
feat: add settlement report filters
fix: reject consumed withdrawal intents
docs: add server deployment guide
```

## Generated files

Do not commit:

- `node_modules/`
- `dist/`
- `artifacts/`
- `cache/`
- `backend/data/*.db`
- `.env`
- generated local `contracts.json`
