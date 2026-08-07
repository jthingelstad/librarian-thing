---
microblog_id: 5924180
url: "https://www.thingelstad.com/2026/06/22/elixirs-agentic-product-team.html"
title: "Elixir's Agentic Product Team"
published: "2026-06-23T02:30:00+00:00"
post_kind: post
categories: ["Crypto"]
---

I've been exploring and engaging in agentic software deeply for a couple of months now with a number of my own projects to learn with. Thus far, nearly all of what I've done has been driven by me often with an LLM assisting in the framing of the thing I'm looking to build. I decided to try using "agents" (of a sort) to create an entire execution loop to autonomously drive one of these projects. I decided to focus on [Elixir](https://poapkings.com/elixir/), the agent I've created to run [our Clash Royale clan](https://poapkings.com), and have now created six discrete automations for it.

<img src="https://www.thingelstad.com/uploads/2026/automations.png" width="600" height="373" alt="Claude desktop app Automations panel showing 7 scheduled automations for elixir-bot and rwbookclub.com projects, running daily or weekly">

Here is a brief overview of what each does, along with a link to the full instructions they use. I created the instructions for each using Claude Cowork and this is the AI-generated summary of each entity.

- **Data Analyst** — Watches the [Clash Royale API](https://developer.clashroyale.com/) data, raw payloads, event streams, detections, and battle telemetry to find new data patterns, game changes, schema drift, unused data, and capability that the Product Manager should consider. [Data Analyst definition](https://github.com/jthingelstad/elixir-bot/blob/main/scripts/product-team/data-analyst.md).
- **Product Manager** — Turns evidence into direction: reviews clan needs, leader feedback, quality reports, [Discord](https://discord.com) history, [RoyaleAPI](https://royaleapi.com) content for editorial context, and data briefs, then files proposed issues for improvements that drive Elixir’s mission and await approval before build work begins. [Product Manager definition](https://github.com/jthingelstad/elixir-bot/blob/main/scripts/product-team/product-manager.md)
- **Build Manager** — Converts approved, ready issues into small, tested code; owns feature and bug-fix implementation, respects issue scope, runs tests/evals, and hands deploy/restart needs to Operations. [Build Manager definition](https://github.com/jthingelstad/elixir-bot/blob/main/scripts/product-team/build-manager.md).
- **Quality Manager** — Judges whether Elixir is actually working: checks recommendation accuracy, silence/noise problems, routing failures, prompt failures, leader/member feedback, and regressions, then files actionable bugs, regressions, quality issues, or eval requests. [Quality Manager definition](https://github.com/jthingelstad/elixir-bot/blob/main/scripts/product-team/quality-manager.md).
- **Operations Manager** — Owns production health: monitors runtime status, logs, telemetry, Event Core health, costs, retries, scheduled jobs, and delivery systems; fixes operational/reliability issues and handles deploys or restarts when needed. [Operations Manager definition](https://github.com/jthingelstad/elixir-bot/blob/main/scripts/product-team/operations-manager.md).
- **Evaluator** — Owns measurement: builds and maintains eval harnesses, datasets, scoring rules, benchmarks, and regression tests so the team can tell whether changes improve or degrade Elixir with evidence instead of vibes. [Evaluator definition](https://github.com/jthingelstad/elixir-bot/blob/main/scripts/product-team/evaluator.md).

The common interface that all of this runs through are [Elixir's Github Issues](https://github.com/jthingelstad/elixir-bot/issues). All agents interface there and that is where "human in the loop" is happening before moving forward with changes. The automations are all setup in [Codex](https://openai.com/codex/), which is super simple and easy to engage with. I'm super curious to see where this goes!
