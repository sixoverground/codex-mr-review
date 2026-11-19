# Review contract

This tool implements version 1.1 of the claude-phases review contract:

https://github.com/sixoverground/claude-phases/blob/4d44490987f75b7d0e7e068fb08d6e1cc844c1e7/docs/review-contract.md

The link is pinned to commit `4d44490987f75b7d0e7e068fb08d6e1cc844c1e7` of claude-phases, so it keeps pointing at the text this tool was built against even if the contract changes later. A later version of the contract would be a deliberate change to this tool, recorded here with a new pinned link. Version 0.1.0 of this tool implemented version 1, pinned at commit `5c8875d10d58a6aebaf421d4d999388533195aa6`.

In short, version 1 asks a reviewer to post each finding as an inline, resolvable thread, and to post a note carrying the marker `<!-- phases:review v=1 reviewer=<name> sha=<sha> -->` after every completed review, written by the tool and never by the model.

Version 1.1 keeps the marker as it was and adds what lets a reviewer share an account with the people and tools that read the merge request:

- every note the reviewer posts carries the reviewer stamp `<!-- phases:reviewer v=1 reviewer=<name> -->` on a line of its own, written by the tool;
- model text is scrubbed of the whole reserved prefix `<!-- phases:`, not only the marker's;
- `<!-- phases:driver v=1 -->` is the contract's reserved consumer stamp. The tool never writes it, and never counts a note carrying it as one of its own, whatever account posted it.

The linked document is the authority; this summary is not.
