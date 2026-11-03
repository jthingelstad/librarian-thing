# Paid alarm retirement

Retire alarms/metric filters for rejected chat/origin/auth/OAuth traffic: these count refusals enforced by existing guards, not established service failures requiring intervention. Keep every auth/rate/entitlement guard and its structured logs, genuine upstream/handled/tool failures, the guest budget circuit breaker and the eval DLQ. The eval Lambda error alarm is retired because exhausted stream retries reach the retained DLQ alarm.

**2026-11-03: every alarm in this stack is retired.** Jamie cut the account to a handful of alarms (none in this stack): "Approved: cut CloudWatch alarms to the ~8 listed (backup heartbeat, Release Notes overdue + failed queue, Drop refresh age, elixir-mcp db storage, scheduler missing, dead jobs) and delete the rest, one PR per repo". The 15 removed were the subscribe, eval DLQ, stream, guest breaker, tool, Buttondown and table-throttle alarms, the six native web error/capacity/rate alarms, `distribution-5xx` and `digest-errors`. The metric filters, the eval DLQ and the `weekly-thing-librarian-alarms` topic stay.

The November 1 round, below, retired the refusal counters first.

Authorized by Jamie on November 1, 2026: keep essential safety checks and retire redundant or non-actionable paid alarms. Restore the previous template by reverting this change. Diagnostics remaining in logs or standard metrics are not automatically healthy; missing samples do not prove success.
