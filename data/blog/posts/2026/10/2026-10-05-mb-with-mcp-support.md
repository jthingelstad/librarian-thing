---
microblog_id: 6043236
url: "https://www.thingelstad.com/2026/10/05/mb-with-mcp-support.html"
title: "mb 2.0 with MCP support"
published: "2026-10-06T02:30:00+00:00"
post_kind: post
categories: []
---

[In March](https://www.thingelstad.com/2026/03/03/i-have-ottoi-exercising-the.html) I created [mb](https://github.com/jthingelstad/mb), a command-line micro.blog client that is specifically created for agents to use. This is what Otto uses to [publish on its blog](https://ottoai.thingelstad.com). It can also read the micro.blog timeline, follow people on micro.blog, and a variety of other features. 

Since I've been playing with MCP a lot I wanted to explore adding MCP support to mb which is now landed in mb 2.0! In addition to MCP support I also created a [Homebrew](https://brew.sh) "tap" for it to make it super easy to install, added support for an `mb --doctor` command to help with setup, and a bunch more. 

To try it the easiest thing is to use [Homebrew](https://brew.sh/):
    
`brew install jthingelstad/tap/mb`

Then sign in:

`mb auth`

`mb auth` walks you through signing in. It sends you to micro.blog's app token page (Account, then Edit Apps) and helps you set the token. It checks the token with micro.blog, and if your account has more than one blog it asks which one to use. Run `mb doctor` afterward to confirm everything is set up correctly.

From there:
    
```
mb heartbeat  # what changed since last time
mb inbox. # mentions that might deserve a reply
mb timeline --count 10
mb post new --draft "Hello from mb"  # saved as a draft, not published
```

The default output is compact plain text tuned for agents. Add `--human` for something easier to read, or `--format json` for scripts. Use `--draft` or `--dry-run` to check a post before it goes live. Every write gets a receipt, so if a request times out you can check whether it landed instead of posting twice.

mb now has an MCP server, so Claude, Codex and other AI tools can work with your micro.blog account directly. To add it to Claude Code in read-only mode:
    
`claude mcp add mb -- mb mcp --consumer claude-code --read-only`

Remove `--read-only` when you're ready to let it post, and keep the approval prompts on.

Homebrew installs a prebuilt version on Apple Macs running macOS 15 or later, and on Linux. Each release is tested against the real micro.blog API using a dedicated test account. If you'd rather skip Homebrew, the [README](https://github.com/jthingelstad/mb#install) covers installing with `uv`. Feedback and issues are welcome [on GitHub](https://github.com/jthingelstad/mb/issues).
