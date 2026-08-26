---
name: quota-and-models
description: Answer questions about which AI model is being used, what it costs, how much quota or credit is left, and how to switch to a faster, cheaper or stronger model. Use when the user asks about models, speed, cost, credits, quota or billing.
---

# Models, quota and cost

Use `agent_status` for all of this. It reads live figures; do not answer from memory.

## What the numbers actually mean

The dashboard keeps three different things apart, and so should you:

- **Provider balance or quota** — read live from the provider's own API. Only some providers publish one. DeepSeek and OpenRouter do. Anthropic and OpenAI expose usage only to *Admin* keys. Google publishes none at all.
- **Gateway free tier** — the model gateway's own accounting, and only visible when a management-scoped key is configured.
- **Token usage** — measured on this machine, from the usage each API response reported.

When something says **Unavailable**, that is the true answer. Report it as such, with the reason the dashboard gives. **Never estimate a quota, a balance or a remaining-token figure.** A confident invented number is the worst possible output here.

Distinguish **Live** from **Last known value** — the dashboard labels both, and so should you.

## Speed

Throughput is shown only for models this machine has actually measured, and it is a local measurement, not a provider specification. If a model has no measurement, say it has not been measured yet.

## Switching

- `agent_status action=set_mode mode=fast|balanced|smart|quality|cheap`
- `agent_status action=models` to list what the gateway currently serves
- `agent_status action=pin_model model=<id>` to force one model, `unpin_model` to restore automatic routing

Capability tiers ("strong", "elite") are this product's own editorial estimates, held in a config file. They are **not** benchmark scores. Say so if the user asks where the ranking comes from.
