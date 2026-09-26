---
buttondown_id: em_1mkg0vd8kt86tthdtwh3bm6dpw
number: 35
subject: Weekly Thing for January 6, 2018
publish_date: '2018-01-07T01:28:21Z'
slug: weekly-thing-for-january-6-2018
description: Prometheus metrics and labels, Intel kernel memory flaw, password manager ad targeting, encryption lava lamps, best iOS apps 2017.
image: https://files.thingelstad.com/weekly-thing/35/cover.jpg
absolute_url: https://buttondown.com/weekly-thing/archive/weekly-thing-for-january-6-2018/
domains: []
links: []
word_count: 1570
---
😬 I hope you all had a great New Years and a fabulous start to 2018! For me the New Year has kicked off with a bang! 🚀 This week has been a blur of various activities on all fronts. I celebrated my birthday 🎂 with fun and presents. I’m eager to put my new sous vide cooker to work and make some delicious eats!

I also kicked off the new year by taking [Shawn Blanc's Focus Course](https://thefocuscourse.com) . 🧘‍♂️ There are a few things I’m thinking about working on in 2018 and establishing more focus is one of them. I decided to take it along with some friends that were also interested. I’m enjoying the course so far! 🤞

---

## Photog 📷

One of our New Years Eve traditions with the kids is a game of Clue. This year Mrs. Peacock did it with the Wrench in the Hall!

Dec 31, 2017 at 9:03 PM
Home, Minneapolis MN

---

## Links 📌

### [Prometheus Blog Series (Part 1): Metrics and Labels](https://pierrevincent.github.io/2017/12/prometheus-blog-series-part-1-metrics-and-labels/?__s=bsgqbmfxusxefqxs6as6)

Interesting series of blog posts with a solid introduction to [Prometheus. Multiple parts Metrics and Labels](https://pierrevincent.github.io/2017/12/prometheus-blog-series-part-1-metrics-and-labels/) [, Metric types](https://pierrevincent.github.io/2017/12/prometheus-blog-series-part-2-metric-types/) [, Exposing and collecting metrics](https://pierrevincent.github.io/2017/12/prometheus-blog-series-part-3-exposing-and-collecting-metrics/) , [Instrumenting code in Go and Java](https://pierrevincent.github.io/2017/12/prometheus-blog-series-part-4-instrumenting-code-in-go-and-java/) [and Alerting rules](https://pierrevincent.github.io/2017/12/prometheus-blog-series-part-5-alerting-rules/) .

### [Dan Harris Knows All Your Excuses for Not Meditating - Note to Self - WNYC](https://www.wnyc.org/story/dan-harris-meditation-skeptics/)

I enjoyed this podcast and it spoke to me as I’m one of those people that constantly thinks that meditation would be a good practice for me but I never make the time to do it. 🧘‍♂️

### ['Kernel memory leaking' Intel processor design flaw forces Linux, Windows redesign • The Register](https://www.theregister.co.uk/2018/01/02/intel_cpu_design_flaw/)

This reads like a detective novel and dives into some interesting things about how modern CPU's work and what they do in silicon to protect different memory spaces. This looks like a pretty nasty issue but we won't know the real extent of it until the embargo is removed. The aside on the name option for the fix made me chuckle: The fix is to separate the kernel's memory completely from user processes using what's called Kernel Page Table Isolation, or KPTI. At one point, Forcefully Unmap Complete Kernel With Interrupt Trampolines, aka FUCKWIT, was mulled by the Linux kernel team, giving you an idea of how annoying this has been for the developers.

### [Simulating Chutes & Ladders in Python | Pythonic Perambulations](https://jakevdp.github.io/blog/2017/12/18/simulating-chutes-and-ladders/)

Oh the fun you can have playing with some Python code and a simple game. If you've been subjected to many games of Chutes & Ladders this will give you some new ways to appreciate the game. 😅 With two players, this translates to a 1% chance that the game will go 72 moves without either of the players winning. Assuming roughly 20 seconds per round, that is about 24 minutes of play time, though from personal experience I can say it feels roughly twenty times that long.

### [How cloud speed helps SQL Server DBAs | Blog | Microsoft Azure](https://azure.microsoft.com/en-us/blog/how-cloud-speed-helps-sql-server-dbas/)

Nice article going into some depth on how Microsoft has had to completely rethink how they deliver SQL Server to make it work for a cloud platform. I like that this highlights the stuff that often isn't considered as you shift software to a cloud deployment strategy. Velocity and speed are highlighted in ways they never are in other models.

### [2017 in Numbers • Aaron Parecki](https://aaronparecki.com/2017/12/31/11/2017-in-numbers)

Another example of a personal annual report, this one on various metrics that Aaron Parecki has kept for the year. Transportation, beverages…

### [Ad targeters are pulling data from your browser’s password manager - The Verge](https://www.theverge.com/2017/12/30/16829804/browser-password-manager-adthink-princeton-research)

Ad this to the list of reasons for why you absolutely should be running protective software when browsing the web. I run 1Blocker, Ghostery and Better.

### [Spamnesty - Home](https://spa.mnesty.com/)

Lovely! 👏 I like how they show the transcripts of previous discussions. Spamnesty is a way to waste spammers' time. If you get a spam email, simply forward it to [sp@mnesty.com](mailto:sp@mnesty.com) , and Spamnesty will strip your email address, pretend it's a real person and reply to the email. Just remember to strip out any personal information from the body of the email, as it will be used so the reply looks more legitimate.

### [Sense: Track energy use in real time](https://sense.com/product.html)

I [shared my frustration with the reporting](https://www.thingelstad.com/2017/12/29/i-want-to.html) that my [power company provides and Luke Samaha](https://www.linkedin.com/in/lukesamaha/) [pointed me to](https://twitter.com/LukeSamaha/status/947135160323059712) Sense. This looks like a pretty amazing device and some great data. I like the premise of identifying the changes and then having the user annotate what happened. Wish it cost half as much though.

### [Encryption Lava Lamps – San Francisco, California - Atlas Obscura](https://www.atlasobscura.com/places/encryption-lava-lamps)

There are many many novel ways to generate true random numbers, versus pseudorandom numbers that almost all devices create. This one is a great read and a good photo but it leaves me feeling like it can be a very good answer. Look at the photo that the video is capturing, most of that frame is static. It would seem much better if there was more variety in the frame.

### [Best of 2017: iOS Apps - BrettTerpstra.com](http://brettterpstra.com/2018/01/01/best-of-2017-ios-apps/)

Terpstra is a developer and power-user and I always find I learn or discover something when I read the write-ups of apps that folks like this use.

### [To Serve Man, with Software](https://blog.codinghorror.com/to-serve-man-with-software/)

Great post and reflections from Jeff Atwood. His thoughts reflect many of the people building things in tech. I think it’s a good thing that people are becoming more introspective on the systems that they create, and asking questions about the value they are bringing. Software is easy to change, but people … aren't. So in the new year, as software developers, let's make a resolution to focus on the part we can change, and keep asking ourselves one very important question: how can our software help people become the best version of themselves? File this into that area of computer ethics that should become part of computer science curriculums.

### [Life Stack – AnomaLily.net](http://anomalily.net/life-stack/)

Thorough list of tools that this person uses to track and measure various aspects of their life.

### [Checklist-Checklist: 🌈 A Curated List of Checklists ✔︎✔︎](https://github.com/huyingjie/Checklist-Checklist)

Like seeing [Checklist Manifesto](https://en.wikipedia.org/wiki/The_Checklist_Manifesto) I started a wiki at CCChecklist.org. The idea of that project [was to be a Creative Commons](https://creativecommons.org) licensed collection of checklists to share. This project is similar just using Github instead of a wiki. I never launched that project, but the concept is still really good. Minor nitpick that [Github Flavored Markdown](https://github.github.com/gfm/) for the checklists and I think [Taskpaper](https://www.taskpaper.com) would be a more useful and interoperable format.

### [IKEA effect - Wikipedia](https://en.wikipedia.org/wiki/IKEA_effect)

I had no idea this was a known effect but it makes a lot of sense and the name is pretty awesome. 🤣

### [Monitoring Home Power Consumption for less than $25](https://blog.kroy.io/monitoring-home-power-consumption-for-less-than-25/)

This is super cool and I might have to try this. I know our house has a wireless meter system, the electric company installed it several years ago. I've never looked into how it works but if it’s this easy this could be a great way to get much more detail on our power usage. If you can get hourly, daily reports on power you should be able to connect your activities close enough to make changes to reduce usage.

---

## Promotion 🎁

https://minnestar.org

[Minnestar](https://minnestar.org/) is the technology community for Minnesota. If you are passionate about technology you need to go to Minnebar and Minnedemo. Did you know [that Minnebar is the largest BarCamp](https://en.wikipedia.org/wiki/BarCamp) in North America and one of the largest in the world? Its also been going on for over 10 years? Minnedemo is the best place to hear about innovative tech and fun projects in the Twin Cities area. I am on the Minnestar board and I focus on Minnestar as one of the driving forces improving and expanding the technology community in the area. Minnestar is a 501c3 [non-profit. Become a Community Supporter today!](https://minnestar.donortools.com/)

---

## Microblog updates 🎈

- Entering the world of sous vide cooking with my new Joule. Love that I even get to update firmware on this! Has WiFi and can [be controlled anywhere from iOS. 😁👍🏻](https://www.thingelstad.com/2018/01/05/entering-the-world.html)
- Just finished module 1 of The Focus Course. It is a slow start but I see it building some foundational things. Looking forward [to the rest of the modules.](https://www.thingelstad.com/2018/01/01/just-finished-module.html)
- This was a fun surprise on my Apple Watch this morning. Was [this only a Siri face feature?](https://www.thingelstad.com/2018/01/01/this-was-a.html)
- [Humbling game of Blokus! 😬](https://www.thingelstad.com/2017/12/31/humbling-game-of.html)
- It was Mrs. Peacock in [the Hall with a Wrench! 🔧](https://www.thingelstad.com/2017/12/31/it-was-mrs.html)
- Time for family New Years Eve. Game [of Clue is first up! 🎲](https://www.thingelstad.com/2017/12/31/time-for-family.html)
- Got a set of the Bodum demitasse for Christmas. Lighter than my typical Illy demitasse but I like that [you can see the espresso. ☕️](https://www.thingelstad.com/2017/12/31/got-a-set.html)
- Leveling up my coffee fussiness with [this new coffee distribution tool. ☕️](https://www.thingelstad.com/2017/12/31/leveling-up-my.html)
- Tyler and I played Super Mario Odyssey through a few levels today and had a blast. The game is filled with little hidden gems. And playing as other characters [with the hat is amazing. 👍🏻💯](https://www.thingelstad.com/2017/12/30/tyler-and-i.html)
- First time playing Ticket to Ride: Nordic Countries and liked it a lot. Limiting to only have 3 players, but fun routes and tunnels add challenges. Pairs well [with snow and hot cocoa. 😊](https://www.thingelstad.com/2017/12/30/first-time-playing.html)

## The end 🎬

Thank you for subscribing to the Weekly Thing! If you know of people that would like the Weekly Thing please forward it along!
