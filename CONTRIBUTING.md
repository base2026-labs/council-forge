# Contributing

Use a focused branch and pull request. Run `npm ci --ignore-scripts`, `npm run lint`,
`npm run check`, `npm run format:check` and `npm run demo` on the exact candidate.
Policy changes require negative tests, not only happy-path examples. Provider integrations
must include recorded schemas with synthetic data, exact identity handling, explicit
cost semantics, cancellation and unknown-outcome tests.

Never commit customer evidence, credentials, auth files, private configuration or real
provider response bodies. Live tests require a separately approved budget and synthetic
inputs. Subscription pilots require explicit existing-access admission even when API
budgets are zero. Never repeat an uncertain operation. Keep observed capabilities separate
from planned work in documentation. Public code/docs/UI/issues are English; council
language fixtures and output may use the requested language. Separate review precedes
acceptance; no automatic merge or release.
