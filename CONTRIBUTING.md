# Contributing

Use a focused branch and pull request. Run `npm ci --ignore-scripts` and `npm run check`.
Policy changes require negative tests, not only happy-path examples. Provider integrations
must include recorded schemas with synthetic data, exact identity handling, explicit
cost semantics, cancellation and unknown-outcome tests.

Never commit customer evidence, credentials, auth files, private configuration or real
provider response bodies. Live tests require a separately approved budget and synthetic
inputs. Keep observed capabilities separate from planned work in documentation.
