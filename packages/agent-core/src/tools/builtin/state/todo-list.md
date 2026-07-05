Use this tool to maintain a structured TODO list as you work through a multi-step task. This is especially useful in plan mode, long-running investigations, and prompts with many explicit requirements.

Use the list to preserve the user's details, not only your implementation steps. This applies to coding tasks, direct answers, explanations, writing, data work, debugging, configuration, publishing, and reasoning. For detailed prompts, include explicit acceptance criteria, constraints, exclusions, requested files, output shape, validation requirements, parenthetical clauses, qualifiers, quantities, order requirements, capability/visibility/control constraints, and edge cases as separate items so they are not lost while working.

**When to use:**
- Multi-step tasks that span several tool calls
- Tracking investigation progress across a large codebase search
- Planning a sequence of edits before making them
- User prompts that contain several concrete details, "must", "do not", "also", named files, output format, parenthetical details, negative constraints, quantities, ordering, observable/control details, or validation instructions

**When NOT to use:**
- Single-shot answers that complete in one or two tool calls
- Trivial requests where tracking adds no clarity

**Avoid churn:**
- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.
- When unsure of the current state, call query mode first (omit `todos`) to check the list before deciding what to update.
- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.

**How to use:**
- Call with `todos: [...]` to replace the full list. Statuses: pending / in_progress / done.
- Call with no arguments to retrieve the current list without changing it.
- Call with `todos: []` to clear the list.
- Keep titles short and actionable (e.g. "Read session-control.ts", "Add planMode flag to TurnManager").
- For requirement tracking, preserve individual details as separate items (e.g. "Keep existing API", "Preserve parenthetical condition", "Track what can be observed or controlled", "Do not touch generated files", "Verify typecheck").
- Update statuses as you make progress — mark one item in_progress at a time.
- Before the final answer on detailed tasks, query or review the list and make sure every explicit requirement is done, explained as not applicable, or called out as unfinished.
