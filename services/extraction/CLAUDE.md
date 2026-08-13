# services/extraction

`DocumentExtractor` implementations, the eval harness, and labelled-corpus tooling.

## The interface is the point

Textract is the committed primary (D20), bound behind `DocumentExtractor`. Below-threshold documents climb the **vision escalation ladder** — Sonnet-vision, then Opus-vision, then a human — so the cheapest capable model always gets the first attempt and nothing reaches a person until the models have genuinely failed.

**Fixture mode is not a test convenience — it is how every other lane stays green** when cloud access lags or the network is unavailable. It is the default in `.env.example`.

## Week 2 is calibration, not a bake-off

Thresholds are tuned on the labelled UK corpus (≥ 500 items, synthetic and team-collected, **zero customer data**, per-field ground truth). The Sonnet-vision middle rung earns its place there or is dropped.

## Evals are tests

Gold datasets for extraction (per field), addressee routing, NL rule parsing and chase validation. **The adversarial injection corpus must stay 100% blocked.** Thresholds fail the build — they do not warn. Any change to prompts, model IDs, the extraction vendor, thresholds or the component grammar must pass `pnpm test:eval` before merge.

## Never

- Gate execution on model self-reported confidence. Thresholds come from eval measurement.
- Put real customer data in an eval dataset. Synthetic or fully anonymised only.
- Train, fine-tune, or ship customer content to any provider training process (D19).
