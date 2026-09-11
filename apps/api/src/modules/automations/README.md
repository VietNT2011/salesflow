## Automation and proactive care

**Feature:** F06

F06 implements declarative, allowlisted `WHEN / IF ALL|ANY / THEN` rules. Rule edits append immutable
versions; activation has an optimistic version and a transactionally enforced 20-rule tenant limit.

The HTTP surface supports list/create/read/version/enable/disable, non-mutating dry-run, execution
history, audited replay and in-app notifications. Only OWNER/ADMIN configure or replay rules. Runtime
effects are handled by the worker through the F00 transactional outbox.
