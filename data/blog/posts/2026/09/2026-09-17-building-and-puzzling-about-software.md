---
microblog_id: 6023599
url: "https://www.thingelstad.com/2026/09/17/building-and-puzzling-about-software.html"
title: "Building and Puzzling about Software"
published: "2026-09-18T01:00:00+00:00"
post_kind: post
categories: ["Crypto"]
---

_This originally started as a commentary on a link for the [Weekly Thing](https://weekly.thingelstad.com) and then got so long it became a blog post of its own. Many themes in this article start from my [Software is Liquid](https://www.thingelstad.com/2026/04/20/software-is-liquid.html) article from April._

The craft of building software is in the largest state of disruption I've experienced in my 30+ year career. AI is changing everything. All the inputs and outputs are in flux. And the fundamental patterns we've worked on are all being redefined.

This isn't the first time I've seen major disruption like this. My career starts with the web being born so I have no perspective before that, but I was part of the mobile and cloud transformations, and they profoundly impacted our craft. Releasing software thousands of times a month was an unlock to velocity that only the cloud could make happen.

Laurie Voss suggests that [we are all product engineers now](https://seldo.com/posts/we-are-all-product-engineers-now/). I think he is on the right path here, and one of his assertions landed hard with me. **The demand for software is infinite.** You may nitpick with infinite, but roll with it for a bit. As an industry we have gotten faster and faster, but the demand has always grown even faster than that. Now with AI our ability to build software has increased radically. Along with that, not surprising at all to me, the opportunities to build have increased even more.

With "agentification" of work, developers have the _potential_ to work on every function in a company. Every single part of it. 

Said another way, the [software is eating the world](https://a16z.com/why-software-is-eating-the-world/) meme introduced by [Marc Andreessen](https://en.wikipedia.org/wiki/Marc_Andreessen) is going to be accelerated by AI, with the lower cost and faster speed of software creation. 

> I've made this argument before: look at the website of your dentist, your insurance company, your kid's school, or literally any department of any government, and you're looking at software that is terrible not because nobody knows how to build better software, but because the people who need it can't afford to pay for better at current prices. Then think about all the things software hasn't touched at all, which is most things. Every small business runs on a spreadsheet and a group chat and a person who remembers stuff.
> 
> That means there isn't now and isn't going to be a glut of software developers, and anything that looks like one right now is a temporary transitional state. The demand for software, at least inside my 10 year horizon, is for practical purposes infinite, or software developers wouldn't be as highly paid as they are.
> 
> But the job of a "programmer" is about to get very, very different. So different that you might not even recognize it as "programming" anymore, while still being recognizably "software development".

I've been working with Claude Code and Codex for months now building software of all kinds. Building [my own agent](https://thingy.thingelstad.com), building [fun websites for hobbies](https://escape.thingelstad.com), building [data products](https://elixir.poapkings.com), building my own bespoke tools, building [tools for other agents](https://github.com/jthingelstad/mb), even [making a game](https://drop.poapkings.com/#/)!

Through that I've been learning what is still hard, what is now easy, what do we need more of, what are the pitfalls, where can you go off the rails? The craft is in flux. I think Voss captures what I've also come to believe our craft is becoming — **Product Engineering**.

I love the history he shared.

> Then software went commercial and, especially, consumer-facing, and the translation job changed shape. Consumers don't want to sit in requirements meetings: they just want to be handed a thing they like. So the person whose job was understanding what people wanted stopped being an analyst who interviewed the business and became a product manager who studied the market, a role [borrowed more or less directly](https://cacm.acm.org/practice/evolution-of-the-product-manager/) from Procter & Gamble's brand managers by way of Intuit and then Microsoft, where a programmer named Jabe Blumenthal invented "program manager" in the late 1980s because Excel for the Mac needed somebody to own what it should do.
> 
> The function moved into Product, and Product got separated from engineering as a career, and for the last twenty-five years we've had two professions where there used to be one and a half. I bring this up because it means the job I'm describing isn't a speculative new thing that we'd have to invent. It's a thing we've had for sixty years under two names. My speculation is that it's about to collapse back into one job.

In the beginning we built things. And then because of the limitations of the work we split that up into a bunch of different roles. Some people should talk to the users. Some people should create the interfaces. Some people shall write the code and work with the machines. Other people shall run it and deploy it. And yet others should test and validate it. I share those last two because they are roles that collapsed in many ways with the advent of DevOps. Role collapsing isn't new in our craft.

Honestly it makes me chuckle a bit to sit back and reflect. **My whole career has been undoing this fragmentation that started so long ago.**

- The web changed dramatically how user experience is created and understood. It needed to live in the product and be dynamic and move. You wanted to get signals from your users beyond formal feedback cycles. 
- DevOps and the cloud fundamentally changed the "over the wall" mentality of building and running software. Everyone runs the software. 
- Going back even more we used to have tons of specialization even on the build side. Much of that has collapsed as languages and infrastructure became more resilient, easier-to-use, and self-optimizing.

Now with coding agents we can create software at a pace that is reasonable for customers to engage with. We again have to collapse the walls. We can all engage in the product experience.

### So what about programming?

Let's look at this on a long scale. Go back to the 80's or 90's. Programming back then was about writing linked lists and managing memory. You were typically writing in low-level languages like C. Interpreted languages were ridiculously slow and lacked real power so we all lived by the law of the compiler. Memory was precious so you managed it precisely. Mind you, not as precisely as the machine language folks that preceded that era. 

If you got in a time machine and showed those programmers the code folks are writing today they would laugh and say "that's not programming!" You are just declaring a dictionary and shoving data in it? Where is that memory and how are you managing it? You don't know? They would scoff at your lack of `malloc`, `realloc`, and `free` discipline.

Now we are back at that same spot but with agents. You don't know how the functions are specifically implemented to make that feature work? You don't know the precise database schema and how the thread pool is managed? Nope, but instead that engineer should and must be able to answer how context is managed, how the architecture is structured, how the event model works, and the most important of all — **what is it we are trying to solve!**

Personally I find the paradigm shift refreshing and invigorating. I can build and create things while ignoring a lot of the "how" that used to be required. For me personally, a lot of that "how" I couldn't even do, so it wasn't that it slowed me down, it was impossible for me. This is why AI makes your "impossible list" possible. 

But for the folks doing the coding, I've seen different approaches based on two things people love to do: building and puzzling. All developers do both, but often identify their impact more strongly with one or the other.

The builders I know are loving AI and having a blast creating things. Builders have tended to be the folks that love to work on a specific domain and create something new. They love the act of building and creating something from nothing. Some builders (I fall in this camp) love to build so much that they really don't even care that anyone uses it. It is almost like art — you build because it is fundamentally rewarding to create new things. Builders have taken to AI fast because it allows you to build so much more. 

Puzzlers are the developers that we have always given the hardest problems to. Puzzlers can work on a problem for hours, days, weeks and can never put it down. These are the folks that achieve flow states where time stops and the only thing that exists is to find the next step in the puzzle. They feel rewarded because the puzzle was solved. These folks thrive on the hard, the complex, the esoteric. And technology teams need them badly because to get much of anything to scale you need puzzlers. The puzzlers I know are less excited about AI. It takes on work that is closer to what they love and value. 

The funny thing to me is that we've had builders and puzzlers working hand-in-hand on the same projects for decades and they may not even know themselves the difference. The craft is the same after all. The difference is the reward cycle.

I do think puzzlers will also find the AI transformation rewarding but it will come in solving massively bigger puzzles, or perhaps solving dozens of puzzles at the same time. Here the cycle is less about the fast build, and more about the expansive data analysis. I was doing work on a large data set and it was so amazing to have Claude build several models, run them all for real, and see the variances. Supercharged puzzling! I think the puzzlers may be the best folks we have to build software factories today. 

### Where does this leave us

Voss suggests that we have "ten years of turmoil" ahead and I think he is likely right but I might put a different flavor on it. 

Some things I think we'll see:

The entry-level path into software development or product engineering will need to be redefined. The reason senior developers are so highly sought after is that they have the expertise and experience to make this transition now. We will need to redefine how people get started in this career. This has happened many times in the past. Each major technology transformation has disrupted the career ladder and then it re-stabilizes on the other side.  That is cold comfort for someone hit by that transition now, but my main suggestion is to focus heavily on where the trend is going and get there as fast as possible.

I think a lot of people are going to build really terrible software, and the pain is going to be real. Just because you can use an agent to make software doesn't mean you should. Running software isn't a one-time job. And however you build it most software that starts life as a cute puppy eventually becomes a big smelly dog that you have to pick up after. Folks that are building their own systems with no expertise will not realize when they are already in a bad spot, and then something will fail or a security event will happen and it will hurt badly.

Lastly I do expect we will see an even greater unification of functions back to "creating products". The specialization that pace and complexity introduced has been a complicating and challenging issue for decades. Ask any product team and development team to talk about the other one. They have all sorts of opinions about how the other could do their job better. The reality is they are all doing the same job — attempting to build amazing solutions for people! We've gotten confused as an industry that these are two things not one. It will be great for everyone to see this fade away. 

All in it is an amazing time to be in this craft, and also one of the hardest times. I've never felt the need to learn so much, the fire to create so much, and the excitement of what we can make happen.
