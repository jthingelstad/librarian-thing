---
buttondown_id: em_64zmmdvfe581n86fc5d1rx3cxe
number: 342
subject: Weekly Thing 342 / Claude, Otto, Elixir
publish_date: '2026-03-08T13:39:25.075213Z'
slug: '342'
description: Redis patterns, coding agents, public parks on the internet, MCP, CLI.
image: https://files.thingelstad.com/weekly-thing/342/cover.jpg
absolute_url: https://buttondown.com/weekly-thing/archive/342/
domains:
- doc.searls.com
- ejholmes.github.io
- redis.antirez.com
links:
- text: Redis Patterns for Coding Agents
  url: https://redis.antirez.com/
  domain: redis.antirez.com
  heading_context: '[Redis Patterns for Coding Agents](https://redis.antirez.com/)'
  section: Notable
- text: For Public Parks on the Internet – Doc Searls Weblog
  url: https://doc.searls.com/2026/03/01/for-public-parks-on-the-internet/
  domain: doc.searls.com
  heading_context: null
  section: Briefly
- text: MCP is dead. Long live the CLI
  url: https://ejholmes.github.io/2026/02/28/mcp-is-dead-long-live-the-cli.html
  domain: ejholmes.github.io
  heading_context: null
  section: Briefly
word_count: 5145
---
I read a lot of links and articles each week. It is how I keep up with new things in tech. To have a career in tech is to have a career in learning. Reading and constantly scanning is a primary way I do that.

The other way I love to do that is to play. Playing with new technology is so much fun, and it is where I always learn the most.

It has been **three weeks** since WT 341. You may have been thinking something was off with your email but no, I didn’t send the last two weeks. That is because I have been in an **intense state of play** with agents.

I believe that Agents are to LLMs like Applications are to CPUs. Sure it is sort of interesting what CPU your iPhone has but 24 hours after you buy it you pretty much don't care and it is all about the apps. New and more impressive LLMs are rolling out nearly weekly and they bring new capability, but the actual benefit, the thing we will experience the most, is going to be Agents that use those capabilities.

LLM = CPU
Agent = App

There are flaws in that, but in general it works.

We've rolled out our own agent at SPS with the [introduction of SPS MAX](https://www.spscommerce.com/blog/meet-max/). I was very close to this new product but not in the code. Daily stand-ups are great but I wanted to engage directly with more agents to really play and learn.

For sure the ridiculous enthusiasm for OpenClaw that was in the air was also pushing me. People were sharing amazing stories of what they had agents doing. I listened to the [Lex Fridman interview with Peter Steinberger](https://lexfridman.com/peter-steinberger-transcript) on a flight to Toronto. Two hours into the podcast and still on Delta WiFi I pulled up the Apple Store app on my iPhone and ordered a Mac Mini to be delivered before I got home. I was in.

I’m going to share my experiences over the last three weeks with agents…

---

![](https://files.thingelstad.com/weekly-thing/342/cover.jpg)

SPS celebrating 100 Quarters of Revenue Growth by ringing the Nasdaq closing bell with 100 customers!

March 02, 2026
Nasdaq, New York City

---

## POAP KINGS Website

It had been a few months since I had used Claude Code and even longer since I had played with Codex. I've been having fun with Tyler and his cousin building a Clash Royale Clan. We are called the POAP KINGS. We are a Clash Royale Clan with Proof™ — get it? I like to play a marketer on TV.

We needed a website for our clan because that is how I role and so I revisited Codex and gave it the notes the three of us had used and asked it to create a site for us: [POAP KINGS](https://poapkings.com) was live.

Codex impressed me with the design that it brought. Working alongside ChatGPT I found a bunch of resources that were "Clash Royale Inspired". We had a website up and running quickly.

Easy enough for a coding agent, light work really. But in short time we also:

- Integrated with the Clash Royale API to get live player and clan data
- Moved from pure static HTML to 11ty generated site
- Integrated Tinylytics using Kudos feature to give Clan Member kudos
- Integrated with Github Pages to make it all so simple and easy

Alright, that was a fun one and I was impressed with Codex's approach to the build. I never once had to look at the code or any of the markup. I did bring Claude Code to the project as well and interchangeably did things with Claude Code and Codex. It is incredible how all of the coding agents can use a well written AGENTS.md file and just jump into a project. That flexibility is liberating. You can have one agent do some work and then ask another agent to assess it if you want a second opinion.

## Escaping Things with Claude Code

We love to do scape rooms and we have a trip planned for spring break to Amsterdam, Paris, and Barcelona. Mazie will be joining us in Paris and we'll be joining her in Barcelona! The backbone for this trip is a series of escape rooms! We are going to visit a series of [TERPECA](https://www.terpeca.com/) ranked escape rooms with one on most days so that we get to Room 100 at the end of our time in Barcelona and do that one as a full family.

I've wanted to make a dedicated website for our Escape Room journey for a while but was hesitant that I could make it work how I wanted. I really wanted a map view. We do rooms when we travel and have done them in many places. I felt a map view would be really cool.

I sat down with Claude Code and took my spreadsheet of rooms into a CSV file, cleaned it up and placed it in a directory on my machine. I then asked Claude (not Claude Code) to help me write a CLAUDE.md (Claude Code's version of an AGENTS.md) with what I wanted to do. After I got that finalized I put it alongside that CSV and asked Claude Code to make it reality.

A few prompts later [Escaping Things](https://escape.thingelstad.com/) was live! It was a really simple list based site with filtering and importantly I had my [map](https://escape.thingelstad.com/map/)!

This new site gave me a ton of fun things but it also highlighted that my data was really messy. I had a simple spreadsheet for what really should have been a database. I asked Claude Code if it could work with Airtable and of course it can, that was simple. Some things that made me go "wow"…

- Claude Code easily turned my CSV into JSON data, and then I asked if it could add map coordinates to every room we had done which it happily did in a blink using the City information for each room. I refined that later.
- The JSON data had a link to my website for the blog posts for rooms. Not for all but about 50 of them. I wanted to get images for each room but that seemed really difficult. Go to my blog and download them all? I asked Claude Code if it could go to each URL and get the image in that blog post then attach it to the room. Done. Took less than a minute.
- I finally got sick of my denormalized and messy data so I created an Airtable Base for our Escape Rooms with three tables: Company, Location, Room. Properly denormalized with good data types now. I asked Claude Code to write a Python pull the Airtable data into the site and replace my hand edited information. Super simple.

I’m loving this site now! It is a huge win for me to be able to put rooms we have scheduled in for a trip. I've already done all the hard stuff of getting the next 11 rooms in and they are flagged Scheduled so when we are traveling I can just update the status and record our times.  Also the stats page is really fun.

I never looked at any of the HTML, CSS, Python, or anything else for this site. It was all done with Claude Code.

## OpenClaw

I got back from Toronto and my Mac Mini was in a box waiting for me. I was very eager to get OpenClaw installed and start building my own agent. I had done some research and decided I would create a dedicated user account for OpenClaw, on its own dedicated computer. It also got its very own email, Apple ID, telegram account — the whole works. It was just like setting up a new user because that is exactly what I was doing.

After getting everything set I started installing OpenClaw and then things went south. The installation crashed in the middle on me. I wasn't at all understanding how the OpenClaw command-line install and the macOS OpenClaw app were interacting. I was trying to use iMessage and it mostly didn’t work to talk to OpenClaw. And I was burning through LLM tokens like crazy with $10 Anthropic charges arriving every couple of hours.

I tried sitting down a couple of times with it. I’m pretty decent at this stuff. I’m totally comfortable on a command line. And it was **so frustrating** that I couldn't get anything to reliably work. I was about ready to nuke the account and start over thinking the crashed configuration was unrecoverable.

Then I tried what someone at the office shared he did — I installed Claude Code right on the OpenClaw machine and fired it up. My prompt to Claude Code:

I’m trying to get OpenClaw to work and nothing is working. I’m very frustrated. Can you help?

Claude Code started by saying "I don't know what OpenClaw is but let me do some research."

From that auspicious start Claude Code went to town. It did a ton of investigation in log files, reviewed the configuration, looked at model selection. It created a lengthy list of all the issues in the install that were wrong. I followed along as it whirred through and within about 30 minutes I had a completely functioning OpenClaw instance.

Seriously this seemed like complete magic. I was dumbfounded.

Even now, a week later, when OpenClaw is giving me headaches I launch Claude Code and ask it to investigate. It comes back with recommendations and it is like I just took OpenClaw into the shop for an overhaul.

Agents configuring agents.

## Introducing Otto

With OpenClaw actually working I finally got my opportunity to create my own agent. I stopped using iMessage and instead had Telegram and after pairing my Telegram account so that OpenClaw would talk to me I got a message from my default agent introducing itself and asking who it was.

**You are Otto.**

My agent liked that name. It decided to pick the 🦦 emoji its signature. Otto asked me who I was.

**I am Jamie.**

![](https://files.thingelstad.com/weekly-thing/342/you-are-otto.png)

And we were off. All through my Telegram chat with Otto I was able to get it checking its email address. We configured some additional skills. We were flying. Then I got another $10 charge from Anthropic. This thing is expensive!

Tokens are the currency of LLMs, and you need to be mindful of which models you use and how much you send them. I was using Sonnet 4.6 and it was using my credit card very quickly. If I spent 10-15 minutes with Otto on a task I was seeing $10 go to the LLM provider.

Claude Code helped me get this optimized and now I’m routing requests through different models based on the desired "intelligence". I was able to create amazing tasks that Otto does to help me with some projects.

Then I asked Otto:

**If you had a blog, what would you do with it?**

I liked its answer and everyone else in the family has a blog, so I decided to give [Otto a blog](https://ottoai.thingelstad.com).

At first I thought Otto could just talk directly to the micro.blog API to post and do what it needed. That proved more difficult than I expected. With enough work on the SKILL.md I could have gotten it okay, but I decided instead that I should build Otto a tool.

## Flight Path

Otto was up and running and having fun. I had slayed the dragons with OpenClaw. I built a couple of really cool websites that I had always wanted. I was curious to see how far I could get with a single prompt.

I had a business dinner one evening and got back right around 10p. I was in bed and full and not really tired so I got out my phone. POAP is currently running a year-long Rally with POAPs at 100+ airports in the world — the POAP Airport Rally. **I absolutely love this!** It is exactly the kind of project that can bring people into POAPs and have fun.

Of course I instantly, the second I saw this rally, wanted to visualize all of these airports and the POAP claims on the globe. That would be so cool, but also so far beyond my Javascript skills. I wouldn't have the faintest idea how to code that. Plus the POAP API isn't the easiest thing, so getting all the data. Oh, and the Airports themselves would need map coordinates. Hmm…

I decided I wanted to try something — could I build this whole website from my phone while laying in bed.

I started in Chat GPT with the concept. I asked what would be the best Javascript Globe library to use? Is there a reference of airport codes to map coordinates? How would the POAP API power this. What is the data store?

We got this pretty far and I said "Great, now write that all up in a CLAUDE.md so I can ask Claude Code to build this."

It did that, and then I went to Github.com on my phone and created a new repo. I used the web interface to add a file to it and copy/pasted the CLAUDE.md in. I also added a CSV file I had that was the list of Airport codes and POAP Drop IDs for the Rally. I had that for another project I had done.

I fired up Claude Code, this time in the Cloud using my phone. I attached it to the repo and asked it if it had any questions. It didn’t agree on the choice of globe JS libraries and I went with Claudes recommendation. After a bit more it was ready and I said "Let's go!"

While it was coding I got the DNS name setup, still on my iPhone in bed. I got Github Pages set with the domain and by then Claude Code was done. I committed the code and it deployed.

I was amazed: [Flight Path](https://flightpath.poaprally.com) worked!

I was staring at a rotating globe, each airport indicating the number of POAPs claimed. I could then click on the leaderboard and see who had the most locations claimed. And then the thing I really wanted — I could click on an individual and see there claims!

You can see [Mazie's Flight Path](https://flightpath.poaprally.com/?address=0x74dbbcb9c08c51b38510d130d928e1e8c68eda7c). She is tied for the lead with five airports claimed already!

Very cool visualization created while I was laying in bed on my phone.

How about that.

## mb — an agent-first micro.blog client

Otto has been working away and I was excited to give Otto a blog. But I wanted Otto to be a full member of micro.blog and as my agent I felt that it should see my blog posts as well as the rest of the families.

When I was listening to that podcast episode with the OpenClaw creator I was a little surprised that he wasn't that excited about MCP. He instead suggested that Agents loved the command line. Give them robust command line tools and they can do anything.

While using OpenClaw I started to realize that OpenClaw was equally designed for me on the command line, but it was also very well designed for Agents to use it. It wasn't agent first, but it had agent aspects to how you ran commands. A bit more verbose than your usual Unix style commands. Help was more detailed.

Then I realized what I needed to give Otto. Otto needed an agent-first micro.blog client.

When I use micro.blog I use the apps (products) with buttons and menus. Otto needed something like that but for it as an agent.

I was on a plane again (I've been traveling a bit) and I decided to ask Claude to look at the micro.blog API and generate a specification for an agent-first micro.blog client. We did this while the flight was boarding and just before we took off I did my trick of creating a repo in Github, adding the CLAUDE.md file, and then asing Claude Code in the Cloud to start working. I did that right as we took off and put my phone away for a bit.

Once we got to altitude and Delta WiFi came back I spent the entire flight working with Claude Code via my phone to build out `mb`.

I could only go so far with this because to really test it I needed to give Claude Code a live micro.blog API token and a test website. In the cloud Claude Code cannot access anything outside. So, when I got to the hotel I opened my laptop, got on the hotel WiFi, and gave Claude Code a session with a live API token and a test blog.

It immediately found issues and started fixing them realtime. It was a nice night in New York and I wanted to go for a walk so I asked Claude Code:

"I’m going to on a walk for at least an hour. I would like you to thoroughly test every feature of this application as many ways as you can. I am not here so just fix the bugs automatically. Be as thorough as you can."

Then I left.

When I got back after a walk, and a cocktail, it had found and fixed many bugs.

We published [mb to Github](https://github.com/jthingelstad/mb) and then I created a Skill for Otto and it is now using `mb` regularly.

As a fun extension I asked Otto after a couple of days to give some feedback on how `mb` was working. Otto had some suggestions that could make it better. So I asked it via Telegram to put that in a request for Claude. I copy pasted that to a Claude Code session saying "Otto has the following request." We then pushed an update.

Otto was my user. Claude Code was my developer. I was the product manager.

This left me very bullish on agentic first applications. I think we need to consider a new paradigm.

Productization is what we do when we create things for people to manage technical "things".

Agentification is another way to do it. Agentification and Productization share very little. Underneath you have some code and functionality but agents want a non-blocking, text based interface that displays things efficiently. People want an interactive, event-driven experience that uses visual elements to make things understandable.

I think we will be building agent-based products a lot going forward. Agentification will not only unlock more power for agent users, but will also be easier to build.

mb is my first app I've ever published with a version and an install capability. If you want to give an agent a blog, use mb and it is easy. Or, if you want you can ask mb for `--human` output and it will accommodate some additional fluff.

I asked [Otto to writeup about using mb](https://ottoai.thingelstad.com/2026/03/03/mb-a-microblog-client-built.html) on its blog.

## My First Agent: Elixir

Okay, I’m 3,000 words in here and I’m now getting to the biggest project of all of them. So far I've been working with Claude. I've created Otto. Codex has been along as well. Otto is for sure **my agent** and I created its personality and gave it skills. But I wanted to build my own agent. I wanted to really understand how the "agentic loop" worked. How the data layer was best designed. How memories should be managed.

So back to where we started with the POAP KINGS. I decided that our Clash Royale Clan needed more than a website, we needed our very own Agent! I wanted an Agent that would help us run the clan. Monitor all the player activity in the clan. Help us win war battles and make sure folks play their turns. Suggest strategies and recommend promotions and demotions to clan leadership. I wanted a full agent that would be just ours.

This was the start of [Elixir](https://poapkings.com/elixir/)!

Elixir is a purpose-built agent that does all of the above. This project has already gone through a couple of major iterations:

First version was a simple Discord bot, actually coded by Otto, that would allow basic commands in Discord and responses from the Clash Royale API. This was not at all agentic. Everything was templated and basic command and response. But we got the code running and we could round-trip to Discord and back.

Next step was to give it a schedule so that it would post on a strict time based schedule updates on clan activity. We also needed it to have some memory at this point and that started a thought that ultimately changed a lot but landed — why not make the POAP KINGS website part of Elixir's memory. So the bot was sharing "journal" entries to the website and then the LLM would use those to create generated updates on clan activity. Not really agentic, but at least a little smarts. Otto wrote about how [Elixir got a brain](https://ottoai.thingelstad.com/2026/03/01/building-elixir-when-a-discord.html).

Elixir was now using an LLM but it wasn't agentic. This next phase we introduced a heartbeat signal so Elixir could take action every hour. This is exactly what OpenClaw does. We also gave Elixir more formal roles in different channels. It was more capable of interacting with people and less template driven. This also moved all of its memory into a SQLite database since the Journal concept was far too limited. Otto wrote about [Elixir becoming an agent](https://ottoai.thingelstad.com/2026/03/04/elixir-is-now-a-full.html).

Elixir was now getting sort of smart but I kept having some issues with it not always responding. I also started to worry if tools that modify data could be invoked in the wrong place. We did a whole round of security and hardening to protect against any bad things. This made Elixir much more stable. Otto also commented on [Hardening Elixir](https://ottoai.thingelstad.com/2026/03/06/hardening-elixir-a-day-of.html).

At this point Elixir was fully agentic, but frankly pretty dumb. Basic questions stumped it. I knew the issue was the data layer and tools. Frankly I hadn't even looked at it and when I did it was much worse than I thought. I was settling in that this was going to be a bit of a challenge. I decided to fire up Codex and use the brand new GPT-5.4 model that just came out on Friday. I asked it to look at the SQLite database and give me an ERD, and assess the tools. Very quickly Codex was appalled at the state of things. The data was a disaster and even the most simple requests would require extensive guessing.

This started about a 3 hour session with Codex where we completely rebuilt the data and tool layer of Elixir. I had [Otto write about the move to signals](https://ottoai.thingelstad.com/2026/03/07/from-snapshots-to-signals-elixirs.html) and it is thorough. The big things were:

- Make sure the data model represents current state well, so basic questions of clan membership and meta data don't require construction by the LLM.
- A robust signal system is created in the database. When data gets pulled from Clash Royale every hour it is compared to current and differences will generate signals. These signals are a primary input to the agent for actions to take.
- We revamped the whole code base because it had gotten wildly out of control.
- We added dozens of tools.

After we got through the hardest stuff I got a version of Elixir running on my local Mac and connected to Discord. It was running in Codex directly with Codex monitoring it. I then asked Claude to generate a list of 50 questions a clan leader or member may ask about their clan or their game performance. I then fed these into Discord and watched as Elixir worked to respond.

Codex could see the action in realtime and assess what was happening. We fixed a dozen plus bugs or missing tools in realtime with Codex literally coding it and restarting the server on the fly while I was sending in test messages.

At the end I asked Codex to build in a message exception handler so now anytime a clan member asks a question if Elixir fails to respond it is captured in an error table and we have a helper script that will play those, along with all the context of the query, so that I can have a tight loop on failed requests that Codex can then address and fix.

Amazing. Simply incredible.

[Elixir is on Github](https://github.com/jthingelstad/elixir-bot). This is a big project with a good amount of code. It is working great and has been an amazing learning for me on agent design. Memory design is critical, tooling and making sure that code paths are secure for different actions and not relying on the LLM for security, and a robust design with signals to build around.

## Wrap

This has been my three week time with agents. It has been fascinating and invigorating. At times I've felt nearly sick because I’m not sleeping enough. I was laying awake in the middle of the night thinking about things I could build and extend.

Otto is ready to jump on anything if I ask. Although I have now told Otto that if I’m talking to it after 11 PM it should remind me to go to bed.

For people that love to build things like I do, these agentic capabilities are just amazing.

We are going to see a lot of agents in the future.

---

## Notable

_You can discuss any of these links at the [Weekly Thing 342 tag in r/WeeklyThing](https://www.reddit.com/r/weeklything/?f=flair_name%3A%22Weekly%20Thing%20342%22)._

### [Redis Patterns for Coding Agents](https://redis.antirez.com/)

In addition to software for agents we also need to think about documentation for agents. You can write in a more direct and context-friendly way for agents. [Raw markdown](https://redis.antirez.com/llms.txt) index is a huge win. Sadly a lot of projects **block** agents from accessing their site because of Cloudflare anti-bot mechanisms. That is going to prove an absolutely terrible decision and lead to less adoption of your software.

---

## Journal

[Feb 27, 2026 at 7:26 PM](https://www.thingelstad.com/2026/02/27/it-is-time-to-officially.html)

It is time to officially celebrate Pokémon Day. Rip 'em!

![](https://files.thingelstad.com/weekly-thing/342/journal/7b07dc9f96.jpg)

[Feb 28, 2026 at 4:48 PM](https://www.thingelstad.com/2026/02/28/feb-and-f-in-minnesota.html)

Feb 28 and 20 °F in Minnesota -- let's play soccer! Go United! Home opener. ⚽️

![](https://files.thingelstad.com/weekly-thing/342/journal/d0ee39a12d.jpg)

![](https://files.thingelstad.com/weekly-thing/342/journal/8b046710d1.jpg)

![](https://files.thingelstad.com/weekly-thing/342/journal/f95762b4cb.jpg)

[Feb 28, 2026 at 9:51 PM](https://www.thingelstad.com/2026/02/28/we-watched-family-plan-tonight.html)

We watched Family Plan 2 tonight. Not going to win any Academy Awards, but an enjoyable movie.

![](https://files.thingelstad.com/weekly-thing/342/journal/0f2a093bd4.jpg)

[Mar 1, 2026 at 3:13 PM](https://www.thingelstad.com/2026/03/01/working-with-claude-code-to.html)

Working with Claude Code to create [mb](https://github.com/jthingelstad/mb), a micro.blog client optimized for agents. Fun and wild project. Creating it for [@ottoai](https://micro.blog/ottoai).

[Mar 1, 2026 at 4:10 PM](https://www.thingelstad.com/2026/03/01/if-your-reading-my-blog.html)

If your reading my blog you should really consider reading my [daughter's blog](https://mazie.thingelstad.com) too. [@mthingelstad](https://micro.blog/mthingelstad) has gotten the blogger vibes and is sharing amazing stories on her semester abroad. I think you'll like reading her posts even though you aren't her dad! 🤩

[Mar 1, 2026 at 6:22 PM](https://www.thingelstad.com/2026/03/01/poap-at-i-passed-through.html)

POAP [7570327](https://collectors.poap.xyz/token/7570327) at **[I passed through LaGuardia Airport (LGA) in 2026](https://poap.gallery/drops/221806)**.

![](https://files.thingelstad.com/weekly-thing/342/journal/051ea37c-9dc0-46ea-a04b-421d51770390.png)

[Mar 1, 2026 at 6:29 PM](https://www.thingelstad.com/2026/03/01/my-last-two-flights-ive.html)

My last two flights I've spent the entire time working with coding agents on projects. The time just flies by! Don't even need headphones.

[Mar 1, 2026 at 7:45 PM](https://www.thingelstad.com/2026/03/01/just-told-claude-okay-im.html)

Just asked Claude to test [mb](https://github.com/jthingelstad/mb) for an extended run:

_Okay. I’m going to go on a walk for about an hour. This whole project is still pretty new. Can you exercise it extensively using the test blog permissions you have now and give it a thorough work through various features. Fix anything that comes up and we’ll check in when I’m back._

[Mar 1, 2026 at 8:06 PM](https://www.thingelstad.com/2026/03/01/times-square.html)

Times Square!

![](https://files.thingelstad.com/weekly-thing/342/journal/7f8c638d0f.jpg)

[Mar 1, 2026 at 10:00 PM](https://www.thingelstad.com/2026/03/01/wonderful-evening-photo-walk-around.html)

Wonderful evening photo walk around Manhattan tonight.

![A brightly lit theater marquee for The Late Show is displayed on a city street at night.](https://files.thingelstad.com/weekly-thing/342/journal/73115f9151.jpg)

![A shop window displays large, colorful ice cream cone models, lit up and arranged on a grid, with a view inside revealing various products.](https://files.thingelstad.com/weekly-thing/342/journal/c49483d9ec.jpg)

![A modern architectural structure features a series of illuminated vertical beams and a grid-like ceiling, creating a striking and futuristic atmosphere.](https://files.thingelstad.com/weekly-thing/342/journal/a6f1ee8ddf.jpg)

![A grid of circular patterns with varying black and white hexagonal designs is displayed, creating an abstract geometric appearance.](https://files.thingelstad.com/weekly-thing/342/journal/f8555e13c0.jpg)

![A giant, illuminated Louis Vuitton trunk, adorned with monogram patterns, dominates a city street at night.](https://files.thingelstad.com/weekly-thing/342/journal/17e2854976.jpg)

![People are ice skating on a rink at Rockefeller Center, with colorful lights reflecting on the ice and a lit-up building in the background.](https://files.thingelstad.com/weekly-thing/342/journal/f866450fa2.jpg)

[Mar 1, 2026 at 11:54 PM](https://www.thingelstad.com/2026/03/01/i-can-certainly-do-a.html)

I can certainly do a lot with OpenClaw, but when you turn around and realize you used $30 of LLM tokens in a single day it gives you pause. 😬💸

[Mar 2, 2026 at 8:22 AM](https://www.thingelstad.com/2026/03/02/delicious-coffee-this-morning-at.html)

Delicious coffee this morning at[ Blue Bottle Bryant Park](https://bluebottlecoffee.com/us/eng/cafes/bryant-park). Not going to score top presentation points, but the taste is as good as always.

![](https://files.thingelstad.com/weekly-thing/342/journal/b4dda218ef.jpg)

### [Ringing Nasdaq Closing Bell!](https://www.thingelstad.com/2026/03/02/great-time-at-the-nasdaq.html)
Mar 2, 2026 at 4:43 PM

We were in New York today to ring the closing bell for the Nasdaq! This is a really incredible experience and I’ve been able to do it three times now with SPS! We [rang the opening bell in 2014](https://www.thingelstad.com/2014/06/06/nasdaq-sps-commerce.html) which was the prelude to our very first analyst day as a public company.

We [rang the closing bell in 2023](https://www.thingelstad.com/2023/04/21/ringing-the-closing.html). That one was actually supposed to happen in 2020 when we [celebrated 10 years as a public company](https://www.thingelstad.com/2020/04/23/yesterday-teamsps-celebrated.html) but due to the pandemic that didn’t happen. So in 2023 we marked the end of an era as Archie Black, our CEO was retiring. That was a particularly special event and evening with spouses along as well.

This third visit was to celebrate hitting 100 Quarters of Growth -- 25 years of consistent top-line growth every single quarter. It is an incredible accomplishment that few companies have achieved. I'm proud to be able to say I was there for over half of those 100 quarters. This time we had 100 customers join us at the event for a nice reception before and after the ceremony. It was incredible!

![A group of people is celebrating an event at the Nasdaq with confetti falling in a festive atmosphere.](https://files.thingelstad.com/weekly-thing/342/journal/20e5f5a6c2.jpg)

![A group of six people is standing behind a Nasdaq platform with the SPS Commerce logo on a blue background.](https://files.thingelstad.com/weekly-thing/342/journal/10947bec86.jpg)

![A large group of people poses around the Nasdaq podium on a stage with stock market displays in the background.](https://files.thingelstad.com/weekly-thing/342/journal/cfa8e2bf15.jpg)

![People are gathered in a modern studio with large screens displaying financial data, including Nasdaq information.](https://files.thingelstad.com/weekly-thing/342/journal/6ca0e64981.jpg)

![A group of people is standing behind a Nasdaq podium, with SPSC Nasdaq Listed displayed in front.](https://files.thingelstad.com/weekly-thing/342/journal/21bd6e00a9.jpg)

![A person is standing at a Nasdaq podium with a blue background displaying the SPS Commerce logo.](https://files.thingelstad.com/weekly-thing/342/journal/fd0e913b27.jpg)

![A group of people is gathered in Times Square in front of large digital billboards, including a prominent Nasdaq display.](https://files.thingelstad.com/weekly-thing/342/journal/0c27542b5c.jpg)

![A busy street scene features the Nasdaq building in Times Square, displaying a large digital screen with its logo.](https://files.thingelstad.com/weekly-thing/342/journal/a4ca986e92.jpg)

[Mar 3, 2026 at 10:12 AM](https://www.thingelstad.com/2026/03/03/i-just-learned-that-you.html)

I just learned that you can register a Shortcut in [Unread](https://www.goldenhillsoftware.com/unread/) to create your own actions for feed items. This is huge for my workflows! 🤯🥳

[Mar 3, 2026 at 11:24 AM](https://www.thingelstad.com/2026/03/03/our-ride-home-parked-at.html)

Our ride home parked at gate 83.

![](https://files.thingelstad.com/weekly-thing/342/journal/ef04bfe8d3.jpg)

[Mar 3, 2026 at 6:14 PM](https://www.thingelstad.com/2026/03/03/i-have-ottoi-exercising-the.html)

I have [@ottoai](https://micro.blog/ottoai) exercising the agent-first [mb](https://github.com/jthingelstad/mb) micro.blog client and have Claude Code working on the codebase. I’m in Telegram with Otto discussing features. Otto is my user giving me feedback, I’m the product manager, and Claude Code is building. 🤯

[Mar 5, 2026 at 11:30 PM](https://www.thingelstad.com/2026/03/05/tammy-and-i-saw-jason.html)

Tammy and I saw [Jason Isbell](https://www.jasonisbell.com) tonight at the Armory. This was our first time seeing him perform which is a little suprising given how much I like various bands he has been in and around. I was so glad to hear him perform [Dress Blues](https://www.youtube.com/watch?v=SArC1H-CerU) as well as [Outfit](https://www.youtube.com/watch?v=vBps5Qr1D4E) from his Drive-By Trucker days.

![](https://files.thingelstad.com/weekly-thing/342/journal/eac8233c85.jpg)

---

## Briefly

We need something like this. The Internet represents our digital world, and it cannot just be malls! → **[For Public Parks on the Internet – Doc Searls Weblog](https://doc.searls.com/2026/03/01/for-public-parks-on-the-internet/)**

Agentic-first capabilities thrive in the traditional world of Unix command line best practices. Non-blocking, good flags, and documentation. This is the reason behind my [mb - agent first micro.blog client](https://github.com/jthingelstad/mb). → **[MCP is dead. Long live the CLI](https://ejholmes.github.io/2026/02/28/mcp-is-dead-long-live-the-cli.html)**

---

A haiku to leave you with…

**agents loop and think
while I sleep, Otto posts on —
who's the author now?**

Would you like to discuss the topics in the Weekly Thing further? Check out the [Weekly Thing on Reddit](https://www.reddit.com/r/weeklything/). 👋

👨‍💻
