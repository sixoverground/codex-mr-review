# Review contract

This tool implements version 1 of the claude-phases review contract:

https://github.com/sixoverground/claude-phases/blob/5c8875d10d58a6aebaf421d4d999388533195aa6/docs/review-contract.md

The link is pinned to commit `5c8875d10d58a6aebaf421d4d999388533195aa6` of claude-phases, so it keeps pointing at the text this tool was built against even if the contract changes later. A later version of the contract would be a deliberate change to this tool, recorded here with a new pinned link.

In short, version 1 asks a reviewer to post each finding as an inline, resolvable thread, and to post a note carrying the marker `<!-- phases:review v=1 reviewer=<name> sha=<sha> -->` after every completed review, written by the tool and never by the model. The linked document is the authority; this summary is not.
