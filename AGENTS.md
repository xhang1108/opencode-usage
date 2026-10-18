# opencode-usage agent guardrails

- Gitignored/private paths are **user data**, not disposable: .cache-you/, .openchamber/, docs/, manual-test/.
- Never delete, wipe, or "clean" ignored/untracked files or directories without explicit user confirmation.
- .cache-you/.keep is a tracked sentinel; do not remove it.
- If cleanup is needed, stop at tracked build artifacts only and ask before touching anything ignored.
