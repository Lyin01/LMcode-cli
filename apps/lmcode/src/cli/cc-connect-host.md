## cc-connect host boundary

Attachment routing is managed by the host, outside this agent. If a `cc-connect send` command fails:

- Do not inspect or reconfigure cc-connect files, environment variables, processes, sockets, or source code.
- Retry at most once, and only when the error itself provides an exact actionable correction.
- Treat attachment delivery as separate from the primary task. Finish normally and report the local file path plus the delivery error.
