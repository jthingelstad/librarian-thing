# Paid alarm retirement

Retire alarms/metric filters for rejected chat/origin/auth/OAuth traffic: these count refusals enforced by existing guards, not established service failures requiring intervention. Keep every auth/rate/entitlement guard and its structured logs, genuine upstream/handled/tool failures, the guest budget circuit breaker and the eval DLQ. The eval Lambda error alarm is retired because exhausted stream retries reach the retained DLQ alarm.

Authorized by Jamie on November 1, 2026: keep essential safety checks and retire redundant or non-actionable paid alarms. Restore the previous template by reverting this change. Diagnostics remaining in logs or standard metrics are not automatically healthy; missing samples do not prove success.
