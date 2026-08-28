# Where the free tokens actually are

**What to sign up to, where, and in what order** — and what the headline number
on the gateway's *Free tiers* dashboard really counts.

Everything below was read from the running gateway on **2026-08-28**, not copied
from anyone's marketing. Reproduce it yourself:

```bash
omni-agent dashboard free
```

---

## The number

The dashboard's **Free-token budget** widget reports two figures. They come from
`GET /api/free-tier/summary`, and they are **per month, not per day**:

| | |
|---|---|
| **Steady, every month** | **1,526,225,000** (≈1.53 B) |
| **First month**, including one-time signup credits | **2,152,725,000** (≈2.15 B) |

That is the "1.6 billion". Its own tooltip describes the method as
*"pool-deduped, honest counting (no inflated rate-limit ceilings)"*, and that is
accurate — summing the per-model rows naively gives **6.86 B**, because Mistral
publishes one allowance shared across five models. Deduplicating by pool
reproduces their figure to the token: **1,526,225,000, delta 0.**

⚠️ **The catalogue behind it was last updated 2026-07-22** (`catalogUpdatedAt`),
and it has already rotted: **GitHub Models is in it for 18 M/month and was
retired on 2026-07-30** (its endpoint answers HTTP 410). So the real ceiling on
2026-08-28 is **at most 1,508,225,000**.

---

## Almost all of it is six signups

Pool-deduped, ranked, cumulative. **Mistral alone is two thirds of the total.**

| # | Provider | Tokens/month | Share | Running total | Add it with | Sign up at |
|---:|---|---:|---:|---:|---|---|
| 1 | Mistral | 1,000,000,000 | 65.5% | **65.5%** | `provider add mistral` | <https://console.mistral.ai/> |
| 2 | LLM7 | 150,000,000 | 9.8% | 75.3% | `provider add llm7` | <https://token.llm7.io/> |
| 3 | Nara | 150,000,000 | 9.8% | 85.2% | `provider add nara` | <https://bynara.id/> |
| 4 | Google Gemini | 60,000,000 | 3.9% | 89.1% | `provider add gemini` | <https://aistudio.google.com/apikey> |
| 5 | Cerebras | 30,000,000 | 2.0% | 91.1% | `provider add cerebras` | <https://cloud.cerebras.ai/> |
| 6 | Cloudflare Workers AI | 30,000,000 | 2.0% | **93.0%** | `provider add cloudflare-ai` | <https://dash.cloudflare.com/> |
| 7 | API Airforce | 24,000,000 | 1.6% | 94.6% | `provider add api-airforce` | <https://panel.api.airforce/> |
| 8 | Ollama Cloud | 20,000,000 | 1.3% | 95.9% | `provider add ollama-cloud` | <https://ollama.com/settings/keys> |
| — | ~~GitHub Models~~ | ~~18,000,000~~ | — | — | **retired 2026-07-30** | — |
| 9 | Groq | 15,000,000 | 1.0% | 97.1% | `provider add groq` | <https://console.groq.com/keys> |
| 10 | BluesMinds | 7,200,000 | 0.5% | 97.6% | `provider add bluesminds` | <https://www.bluesminds.com/> |
| 11 | SambaNova | 6,000,000 | 0.4% | 98.0% | `provider add sambanova` | <https://cloud.sambanova.ai/> |
| 12 | Arcee AI | 4,800,000 | 0.3% | 98.3% | `provider add arcee-ai` | <https://www.arcee.ai/> |
| 13 | Navy | 4,500,000 | 0.3% | 98.6% | `provider add navy` | <https://navy.ai/> |
| 14 | BazaarLink | 3,600,000 | 0.2% | 98.8% | `provider add bazaarlink` | <https://bazaarlink.ai/> |
| 15 | OpenRouter | 1,200,000 | 0.1% | 98.9% | `provider add openrouter` | <https://openrouter.ai/keys> |
| 16 | Cohere | 800,000 | 0.1% | 99.0% | `provider add cohere` | <https://dashboard.cohere.com/api-keys> |
| 17 | Morph | 400,000 | <0.1% | 99.0% | `provider add morph` | <https://morphllm.com/dashboard> |
| 18 | Hugging Face | 200,000 | <0.1% | 99.0% | `provider add huggingface` | <https://huggingface.co/settings/tokens> |
| 19 | Kiro | 25,000 | <0.1% | 99.0% | `provider add kiro` | <https://kiro.dev/> |

*(HuggingChat's 500 K/month is omitted: its page answered 503 when checked, so
there is no link here worth giving you.)*

**Six signups get you 93%. Ten get you 98%.** The remaining thirty-odd rows on
that dashboard page are rounding error, and each one is still a real account
with a real password to look after.

Every command above is the same shape:

```bash
omni-agent provider setup mistral        # the steps for one provider
omni-agent provider add mistral YOUR-KEY # store it, and test it with a real call
```

The key is tested immediately against the provider, and the models it unlocks
appear in the app's model picker under **From your keys**.

---

## First month only: one-time signup credits

These are the other **626,500,000** — the difference between the 1.53 B steady
figure and the 2.15 B first-month one. **They do not come back.**

| Provider | One-time | Add it with | Sign up at |
|---|---:|---|---|
| Google Vertex AI | 300,000,000 | `provider add vertex` | <https://console.cloud.google.com/vertex-ai> |
| AgentRouter | 200,000,000 | `provider add agentrouter` | agentrouter.org/register ⚠️ *its TLS did not negotiate from this machine — verify it yourself before trusting it* |
| Predibase | 25,000,000 | `provider add predibase` | predibase.com ⚠️ *now redirects to rubrik.com; the free trial may not exist any more* |
| Together AI | 25,000,000 | `provider add together` | <https://api.together.ai/settings/api-keys> |
| GLM (China) | 20,000,000 | `provider add glm-cn` | <https://open.bigmodel.cn/usercenter/apikeys> |
| Doubao / Volcengine | 15,000,000 | `provider add doubao` | <https://console.volcengine.com/ark> |
| AI21 | 10,000,000 | `provider add ai21` | <https://studio.ai21.com/> |
| LongCat | 10,000,000 | `provider add longcat` | <https://longcat.chat/platform> — *needs KYC verification* |
| DeepSeek | 5,000,000 | `provider add deepseek` | <https://platform.deepseek.com/api_keys> |
| Hyperbolic | 5,000,000 | `provider add hyperbolic` | <https://app.hyperbolic.ai/> |
| Nscale | 5,000,000 | `provider add nscale` | <https://console.nscale.com/> |
| Bytez | 1,000,000 | `provider add bytez` | <https://bytez.com/> — *refreshes every 4 weeks* |
| DeepInfra | 1,000,000 | `provider add deepinfra` | <https://deepinfra.com/dash/api_keys> |
| Fireworks | 1,000,000 | `provider add fireworks` | <https://app.fireworks.ai/> |
| Nebius | 1,000,000 | `provider add nebius` | <https://studio.nebius.com/> |
| Qoder | 1,000,000 | `provider add qoder` | <https://qoder.com/> |
| Scaleway | 1,000,000 | `provider add scaleway` | <https://console.scaleway.com/generative-api/models> |
| Novita | 500,000 | `provider add novita` | <https://novita.ai/settings/key-management> |

⚠️ **Vertex and AgentRouter are 500 M of the 626 M**, and Vertex wants a Google
Cloud project with billing attached, not an API key you paste. Weigh that before
treating "2.15 B in the first month" as a plan.

---

## Free with no signup at all

Thirteen providers are marked **uncapped** — *"permanently free, no published
cap (rate-limited) — real access, not counted in the headline"*: `agnes`,
`ainative`, `aion`, `baidu`, `glm`, `glm-cn`, `kilo-gateway`, `opencode-zen`,
`requesty`, `routeway`, `sealion`, `siliconflow`, `tencent`.

And nineteen need no credential whatsoever — this is the pool a fresh install
already runs on: `pollinations`, `duckduckgo-web`, `opencode`, `auggie`,
`felo-web`, `chipotle`, `mimocode`, `theoldllm`, `hackclub`, `aihorde`,
`ovhcloud`, `uncloseai`, `kilocode`, `veoaifree-web`, and the `g4f-*` bridges.

⚠️ **They are also mostly not answering.** Measured the same day, one short
completion per keyless upstream: **one of eight replied**, the rest returning
anti-abuse challenges, shared-egress-IP blocks and upstream faults. See
[providers.md](providers.md#about-that-16-billion-tokens-a-month). **That is the
actual reason to sign up for anything here** — not the headline number.

---

## Read this before you open forty accounts

- **The numbers are the providers' own claims**, restated by a catalogue that is
  five weeks old. Two were already wrong when checked on 2026-08-27 (Cerebras,
  Brave). The provider's own page is the only authority.
- **OmniRoute itself flags nearly every one of these as ToS `caution`** — its own
  label for *"personal-use / proxy clauses"*. Routing a free personal tier
  through a gateway can breach the terms you agreed to at signup. The dashboard
  surfaces the flag and leaves the decision to you; so does this. Read the terms
  for anything you intend to lean on.
- **A token allowance is not throughput.** Most of these are also capped per
  minute and per day. Mistral's billion a month is not a billion you can spend on
  a Tuesday.
- **Every account is a credential to look after.** Keys are stored encrypted
  locally ([security.md](security.md)), but the accounts are still yours to
  manage, rotate and cancel.
- **Diminishing returns are steep.** Six signups is 93% of the headline and — more
  usefully — enough different upstreams that one failing has somewhere to fall
  back to. That is the real benefit, and it arrives long before the fortieth
  account.
