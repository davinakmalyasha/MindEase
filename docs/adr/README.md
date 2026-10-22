# Architecture decision records

Each record states the decision, the context that forced it, the consequences,
and the alternatives that were rejected. They are historical: a later record may
supersede an earlier one, and the code is the final authority on what is true
today.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-realtime-transport.md) | A hand-written Go websocket service, not SSE, not a managed broker | accepted |
| [0002](0002-ai-provenance.md) | AI provenance is contractual, and crisis triage never leaves the server | accepted |
| [0003](0003-payment-abstraction.md) | A payment abstraction with a simulator | accepted |
| [0004](0004-scaling-model.md) | One pooled MySQL primary now; replicas before shards | accepted |

The template for a new record is [`0000-template.md`](0000-template.md).
