**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Isolate polling failures to the affected pull request**

When watching multiple PRs, a failed request for one PR suppresses change notifications for every healthy PR: the loop breaks, and this condition discards the accumulated `lines`. Snapshots for earlier PRs have already been advanced, while later PRs are never polled. Once the initial error notification has been emitted, subsequent CI completions or merges in healthy repos therefore produce no wake until the fallback check-in, potentially 45–60 minutes later. This is reproducible with a mocked two-PR watcher where the second PR consistently returns 403. Continue polling healthy PRs and emit their changes independently of failures elsewhere.

Useful? React with 👍 / 👎.

<!-- codex-code-review-finding:v1 -->