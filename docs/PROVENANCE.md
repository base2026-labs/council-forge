# Design provenance and primary sources

Reviewed 2026-10-07. These are dated engineering references, not guarantees of account
eligibility, long-term API stability, legal compliance or production readiness.

## Prior council projects

- https://github.com/rachittshah/llmcouncil — council/MCP orchestration reference.
- https://github.com/karpathy/llm-council — independent responses and peer-review pattern.
- https://github.com/pathbind/M-plus — Main/reviewer ownership pattern considered in the design discussion.

**No source code, prompt files, assets or license text from these repositories has been
imported. Council Forge is not a fork of them.** Independent implementation was chosen
because the billing kernel, Jev port, evidence contracts and plugin boundaries are core
requirements, not cosmetic changes to an existing chat UI. Any future code import must
record exact upstream revision, files and license notices before merging.

## Provider and host contracts

- [OpenRouter: What is Jev?](https://openrouter.ai/blog/insights/what-is-jev/) — published examples of the Decisions request, choice distribution, pinned response model and usage envelope. Jev is not a text generator.
- [OpenAI: Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) — account-specific model catalogue and streaming Responses through the documented public endpoint.
- [OpenAI: Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) — store/stream requirements, unsupported request fields and hosted tools.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) — stdio JSON-RPC, authentication modes, model/effort catalogue, thread/turn lifecycle, completion and rerouting events. Includes the local/open-source versus commercial/hosted boundary.
- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins) — portable root manifest, compatibility manifest, skills, MCP configuration and local marketplaces.
- [OpenAI: Submission](https://developers.openai.com/plugins/deploy/submission) — public directory submission is separate from GitHub publication.
- [MCP specification](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro) — host/tool boundary; having an MCP tool is not permission to inherit unrelated host connectors.

The bootstrap intentionally makes no research-backed accuracy or cost-saving claim.
It does not rely on unverified paper titles from exploratory chat discussion. Benchmarking
against a single strong model under equal budget is a required future acceptance gate.
