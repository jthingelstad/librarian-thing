---
buttondown_id: em_43ytjz96kp8g5stkbysm61b6yr
number: 279
subject: Weekly Thing 279 / Nushell, BlackCat, Daemons
publish_date: '2024-03-10T12:30:00Z'
slug: '279'
description: Endatabas, writing Unix daemons, Nushell, BlackCat ransomware implosion, missing data type, REST meaning, privacy and competition.
image: https://files.thingelstad.com/weekly-thing/279/cover.jpg
absolute_url: https://buttondown.com/weekly-thing/archive/279/
domains:
- blog.emojipedia.org
- blog.kagi.com
- htmx.org
- jamesg.blog
- krebsonsecurity.com
- lars.yencken.org
- simonwillison.net
- tratt.net
- webkit.org
- www.eff.org
- www.hillelwayne.com
- www.theverge.com
links:
- text: Endatabas
  url: https://simonwillison.net/2024/Mar/1/endatabas/
  domain: simonwillison.net
  heading_context: '[Endatabas](https://simonwillison.net/2024/Mar/1/endatabas/)'
  section: Notable
- text: Some Reflections on Writing Unix Daemons - Laurence Tratt
  url: https://tratt.net/laurie/blog/2024/some_reflections_on_writing_unix_daemons.html
  domain: tratt.net
  heading_context: '[Some Reflections on Writing Unix Daemons - Laurence Tratt](https://tratt.net/laurie/blog/2024/some_reflections_on_writing_unix_daemons.html)'
  section: Notable
- text: In praise of Nushell
  url: https://lars.yencken.org/in-praise-of-nushell
  domain: lars.yencken.org
  heading_context: '[In praise of Nushell](https://lars.yencken.org/in-praise-of-nushell)'
  section: Notable
- text: BlackCat Ransomware Group Implodes After Apparent $22M Payment by Change Healthcare – Krebs on Security
  url: https://krebsonsecurity.com/2024/03/blackcat-ransomware-group-implodes-after-apparent-22m-ransom-payment-by-change-healthcare/
  domain: krebsonsecurity.com
  heading_context: '[BlackCat Ransomware Group Implodes After Apparent $22M Payment by Change Healthcare – Krebs on Security](https://krebsonsecurity.com/2024/03/blackcat-ransomware-group-implodes-after-apparent-22m-ransom-payment-by-change-healthcare/)'
  section: Notable
- text: The Hunt for the Missing Data Type
  url: https://www.hillelwayne.com/post/graph-types/
  domain: www.hillelwayne.com
  heading_context: '[The Hunt for the Missing Data Type](https://www.hillelwayne.com/post/graph-types/)'
  section: Notable
- text: How Did REST Come To Mean The Opposite of REST?
  url: https://htmx.org/essays/how-did-rest-come-to-mean-the-opposite-of-rest/
  domain: htmx.org
  heading_context: '[How Did REST Come To Mean The Opposite of REST?](https://htmx.org/essays/how-did-rest-come-to-mean-the-opposite-of-rest/)'
  section: Notable
- text: Privacy First and Competition | Electronic Frontier Foundation
  url: https://www.eff.org/deeplinks/2024/03/privacy-first-and-competition
  domain: www.eff.org
  heading_context: '[Privacy First and Competition | Electronic Frontier Foundation](https://www.eff.org/deeplinks/2024/03/privacy-first-and-competition)'
  section: Notable
- text: 'TinyLetter: looking back on the humblest newsletter platform - The Verge'
  url: https://www.theverge.com/24085737/tinyletter-mailchimp-shut-down-email-newsletters
  domain: www.theverge.com
  heading_context: null
  section: Briefly
- text: Serving my blog posts as Linux manual pages | James' Coffee Blog
  url: https://jamesg.blog/2024/02/29/linux-manual-pages/
  domain: jamesg.blog
  heading_context: null
  section: Briefly
- text: An HTML Switch Control | WebKit
  url: https://webkit.org/blog/15054/an-html-switch-control/
  domain: webkit.org
  heading_context: null
  section: Briefly
- text: iOS 17.4 Emoji Changelog
  url: https://blog.emojipedia.org/ios-17-4-emoji-changelog/
  domain: blog.emojipedia.org
  heading_context: null
  section: Briefly
- text: Kagi + Wolfram | Kagi Blog
  url: https://blog.kagi.com/kagi-wolfram
  domain: blog.kagi.com
  heading_context: null
  section: Briefly
word_count: 2280
---
Good morning! 👋

I love that the days are getting longer. I don't mind the cold of winter but I do miss the sun and it is great to see more of it. It is one of the things I look forward to when we do this collective clock moving around dance in the spring. 🌞

Hope you have a great weekend and enjoy some interesting links! 👍

---

![](https://files.thingelstad.com/weekly-thing/279/cover.jpg)

Lake Superior moments after the sunset.

Feb 23, 2024
Grand Marais, Minnesota

---

## Notable

### [Endatabas](https://simonwillison.net/2024/Mar/1/endatabas/)

I hadn't heard of [Endatabas](https://www.endatabas.com) and this summary from Willison hits on some great highlights.

> It uses a variant of SQL which allows you to insert data into tables that don’t exist yet (they’ll be created automatically) then run standard select queries, joins etc. It maintains a full history of every record and supports the recent SQL standard “FOR SYSTEM_TIME AS OF” clause for retrieving historical records as they existed at a specified time (it defaults to the most recent versions).

Pretty cool stuff.

### [Some Reflections on Writing Unix Daemons - Laurence Tratt](https://tratt.net/laurie/blog/2024/some_reflections_on_writing_unix_daemons.html)

Tratt goes through three different daemons that he has created for Unix systems and discusses the approach. Concludes with suggestions on how best practices for designing daemons, why they should be considered for solutions, and how to implement them. I’m always blown away by how many daemons run on a modern macOS machine. I just did a quick `ps -e | grep 'd$'` on my laptop and it catches 191 instances. Not all of them are daemons, but most are.

### [In praise of Nushell](https://lars.yencken.org/in-praise-of-nushell)

I had not heard of [Nushell](https://www.nushell.sh) but I find it fun to read about new takes on foundational Unix tools. This one looks pretty cool. It is a significant break from the traditional look of a shell.

> Unlike bash or zsh, Nushell is built around the idea of structured data. It has a range of basic types including numeric types, strings, dictionaries and lists -- in short, the types a modern programming language is built on. It adds to them support for tables, which are built from any sequence of dictionaries.

Prett nifty! 🤓

### [BlackCat Ransomware Group Implodes After Apparent $22M Payment by Change Healthcare – Krebs on Security](https://krebsonsecurity.com/2024/03/blackcat-ransomware-group-implodes-after-apparent-22m-ransom-payment-by-change-healthcare/)

This ransomware attack is a big deal, and interesting that they seem to have actually paid the ransom.

> On March 1, a cryptocurrency address that security researchers had already mapped to BlackCat received a single transaction worth approximately $22 million. On March 3, a BlackCat affiliate posted a complaint to the exclusive Russian-language ransomware forum **Ramp** saying that Change Healthcare had paid a $22 million ransom for a decryption key, and to prevent four terabytes of stolen data from being published online.

After paying the mess just gets worse. ☠️

### [The Hunt for the Missing Data Type](https://www.hillelwayne.com/post/graph-types/)

Wayne writes about how common graph relationship problems show up in programming and wonders why we don't have much more robust support for graphs built-in to languages. Fundamentally he comes to a conclusion on why generic support for graphs is not suitable.

> So, the reasons we don't have widespread graph support:
>
> - There are many different kinds of graphs
> - There are many different representations of each kind of graph
> - There are many different graph algorithms
> - Graph algorithm performance is very sensitive to graph representation and implementation details
> - People run very expensive algorithms on very big graphs.

Hou then writes a great response that there is a great language for graphs in [The "missing" graph datatype already exists](https://tylerhou.com/posts/datalog-go-brrr/) — [Datalog](https://en.wikipedia.org/wiki/Datalog), a declarative logic programming language.

Both articles are a good read.

### [How Did REST Come To Mean The Opposite of REST?](https://htmx.org/essays/how-did-rest-come-to-mean-the-opposite-of-rest/)

Good writeup clarifying that REST interfaces are not just JSON over HTTP.

> From there, an API could be considered more "mature" as a REST API as it adopted the following ideas:
>
> - Level 1: Resources (e.g. a resource-aware URL layout, contrasted with an opaque URL layout as in XML-RPC)
> - Level 2: HTTP Verbs (using `GET`, `POST`, `DELETE`, etc. properly)
> - Level 3: Hypermedia Controls (e.g. links)
>
> Level 3 is where the uniform interface comes in, which is why this level is considered the most mature and truly "The Glory of REST"

Nearly everyone stops at level 2.

### [Privacy First and Competition | Electronic Frontier Foundation](https://www.eff.org/deeplinks/2024/03/privacy-first-and-competition)

EFF on all the many ways that privacy legislation could help us.

> [Privacy isn't dead](https://www.eff.org/deeplinks/2024/02/privacy-isnt-dead-far-it). Far from it. For a quarter of a century, would-be tech monopolists have been insisting that we have no privacy and telling us to "[get over it](https://www.wired.com/1999/01/sun-on-privacy-get-over-it/)." [The vast majority of the public wants privacy](https://www.eff.org/deeplinks/2022/06/facebook-says-apple-too-powerful-theyre-right) and will take it if offered, and [grab it if it's not](https://doc.searls.com/2023/11/11/how-is-the-worlds-biggest-boycott-doing/).

This is one of the most profound areas where our lawmakers are failing to do their job.

---

## Journal

### [Getting Tesla Model Y](https://www.thingelstad.com/2024/03/03/getting-tesla-model.html)
Mar 3, 2024 at 9:10 AM

Yesterday we purchased a **2024 Tesla Model Y**! This will be my primary car [replacing the Mazda CX-9](https://www.thingelstad.com/2021/07/24/mazda-cx-carbon.html). [Our Model 3](https://www.thingelstad.com/2018/10/01/picked-up-my-tesla-model.html) has become Tammy’s primary car since the pandemic when she started driving it more. Before then the Model 3 was always with me at the office. 😊

We test drove the Model Y, Model S, and Model X. I find the Model 3 to be uncomfortable to get in and out of and the Model S was nearly identical. We all loved the Model X but the price jump is huge -- you can buy two Model Y’s for the price. Additionally, with our small South Minneapolis garage I was very doubtful the Model X doors would work.

We did consider the idea of getting a non-Tesla EV, but the infrastructure upgrades to add another model of charger into our garage was going to be very difficult. We would have had to jump from 200A to 400A service for the house, install an additional main panel, have utility work done in the yard. The dollars add up quick on that stuff. The benefit of using the same charging setup at home was a big win. If we had a bigger garage and the power wasn’t an issue we would have looked hard at the [Rivian](https://rivian.com). ⚡️

I decided to get the Stealth Grey and the standard 19" wheels. I also went for the Black and White interior which is very white. It looks great, and I’m hoping I’ll still think it looks great after three or four years of wear. Fingers crossed on that. Dual Motor and long range battery. Tow hitch for bike rack. I also opted into Enhanced Autopilot so it has the same capability as the Model 3 does. I continue to view Full Self Driving as a better monthly “add on” for trips. The Model 3 computer would need an upgrade to use it, so the Model Y will be our first time to try it.

I continue to be blown away by Tesla’s purchasing process. It took 5 minutes at the dealership after I did the test drive to put down the deposit. Within seconds of that transaction completing I loaded the Tesla app on my phone and it already showed the second car in my profile. I completed the purchase process while I was brewing my coffee at home this morning. The comparison to the buying process for the Mazda where I sat at the dealership for 90 minutes is shocking.

The Model Y is on the way and I will pick it up next week! 🤩

![](https://files.thingelstad.com/weekly-thing/279/journal/818c2ec825.jpg)

### [Dune: Part Two](https://www.thingelstad.com/2024/03/03/dune-part-two.html)
Mar 3, 2024 at 9:27 AM

After multiple delays [Dune: Part Two](https://www.imdb.com/title/tt15239678/) arrived in theaters! Tammy got us all tickets for last night’s sold-out showing at [Edina 4](https://manntheatres.com/theatre/89/Edina-4). I’m the Dune fan in the family, but since we [saw the first one](https://www.thingelstad.com/2021/10/21/we-went-to.html) as a family we decided to all go again.

**I thought it was breathtaking.** It would be difficult for me to pull out one specific area to highlight. The movie was 2h 46m but I never once took note of the time. I was completely there, engaged in this epic story. I read all six books of the Dune series in college and just like that last movie this makes me want to read them all again. The complex world of Dune and all of the interconnections is incredible.

Now, the rest of the family? This will be their last Dune movie. Tammy just doesn’t vibe with this kind of epic sci-fi story. Tyler found it just too long and slow. The violence was much more than Mazie wanted. Overall the Harkonnen’s were super-creepy, dark, and violent for all of us really. I keep thinking that having read the book maybe I experience the movies different than the rest of the family. I also do think feel that Villeneuve’s interpretations of Dune have a lot more violence than the original story, but I would need to re-read the books to see if that is really the case.

[Dune: Part Three](https://www.imdb.com/title/tt31378509) is in development now. I can’t wait to see it!

![](https://files.thingelstad.com/weekly-thing/279/journal/40b781aa4d.jpg)

### [Home Electric Upgrade](https://www.thingelstad.com/2024/03/04/home-electric-upgrade.html)
Mar 4, 2024 at 5:27 PM

We’ve had a crew from [Advantage Electric](https://advantageelectricmn.com) at our house for the last couple days and hopefully we’ll be wrapped up tomorrow. A wide variety of improvements. They put a number of the Lutron Caseta switches in today and I’m already realizing how nice it is when **all the lighting** is in that system. I’m excited about all of these things. ⚡️
- Hang 7 replacement light fixtures.
- <strike>Replace halogen puck light with LED.</strike>
- Install recessed electric receptacle for TV.
- Replace 2 under-cabinet halogen lights with LED.
- Replace 4 under-cabinet halogen lights with LED.
- Replace 6 fluorescent lights with LED.
- Replace 3 fluorescent closet lights with LED.
- Replace 2 fluorescent utility lights with LED.
- Remediate 2 dangerous electric receptacles.
- Replace exhaust fan that doesn’t shut off.
- Install 5 electric receptacles with USB C power.
- Modernize electric receptacles on main floor and basement.
- Install [Lutron Caseta](https://www.casetawireless.com/us/en) light switches on main floor and basement.
- Remount electric meter to exterior wall, add emergency disconnect.
- Replace main electric panel, add whole home surge protection.

[Mar 4, 2024 at 10:19 PM](https://www.thingelstad.com/2024/03/04/bitcoin-near-or.html)

Bitcoin near or at new all-time highs today.

![](https://files.thingelstad.com/weekly-thing/279/journal/a7e70fe6d5.png)

[Mar 4, 2024 at 10:29 PM](https://www.thingelstad.com/2024/03/04/my-friend-jim.html)

My friend Jim and I had a great time watching the Timberwolves beat the Trail Blazers tonight! 119 - 114 🏀

![](https://files.thingelstad.com/weekly-thing/279/journal/e17c7425bf.jpg)

![](https://files.thingelstad.com/weekly-thing/279/journal/9205599bc7.jpg)

![](https://files.thingelstad.com/weekly-thing/279/journal/86483cf329.jpg)

[Mar 5, 2024 at 11:00 AM](https://www.thingelstad.com/2024/03/05/power-has-been.html)

Power has been shut off to the entire hose now for nearly an hour for the [electrical upgrades](https://www.thingelstad.com/2024/03/04/home-electric-upgrade.html). Happy to see that the combination of UPS batteries and PoE for infrastructure has left the network and fiber connection online! ⚡️

### [Bee Lab at University of Minnesota](https://www.thingelstad.com/2024/03/06/bee-lab-at.html)
Mar 6, 2024 at 6:30 PM

When Tammy’s [Dad passed away](https://www.thingelstad.com/2024/01/21/don-olson-obituary.html) one of the organizations that he supported was the [Bee Lab at the University of Minnesota](https://beelab.umn.edu/). As a thank you from the Bee Lab Tammy and I were able to visit today, meet [Dr. Marla Spivak](https://entomology.umn.edu/people/marla-spivak), and get a tour of the facility.

It was cool to see how Dr. Spivak had designed the lab and to see some of the work they are doing with the incredible variety of bee species in Minnesota and elsewhere.

For more about Dr. Spivak and her work with bees watch her TED Talk on [why bees are disappearing](https://www.ted.com/talks/marla_spivak_why_bees_are_disappearing) and an interview about her [research on Propolis and Honey Bees](https://www.youtube.com/watch?v=KBSdvBj_phk).

![](https://files.thingelstad.com/weekly-thing/279/journal/26b5f2905c.jpg)

![](https://files.thingelstad.com/weekly-thing/279/journal/26f7921d34.jpg)

![](https://files.thingelstad.com/weekly-thing/279/journal/4394048a21.jpg)

![](https://files.thingelstad.com/weekly-thing/279/journal/f5669cdac3.jpg)

![](https://files.thingelstad.com/weekly-thing/279/journal/1f3b04049d.jpg)

![](https://files.thingelstad.com/weekly-thing/279/journal/996ef44a5f.jpg)

[Mar 7, 2024 at 9:01 PM](https://www.thingelstad.com/2024/03/07/fun-night-out.html)

Fun night out seeing [Gaelic Storm](https://www.gaelicstorm.com) and [The High Kings](https://www.thehighkings.com) at the [Pantages](https://hennepintheatretrust.org/theatres/pantages-theatre/) with my cousin Josh and his wife Dawn. Dinner at [The Local](https://the-local.com) before. Full Irish experience. 🇮🇪

![](https://files.thingelstad.com/weekly-thing/279/journal/44e9d7381f.jpg)

---

### Weekly Thing Forum 🆕

Join Patrick Hambek, Barry Hess, Tom Mungavan, David O'Hara, Jim Cuene, and many other Weekly Thing readers in the [Weekly Thing Forum](http://ponder.weeklything.com). Recent topics include:

- [277 / Privacy, Scammed, OmniFocus](https://ponder.us/group/weeklything/discussions/521)
- [276 / Contextual, Copilot, Collections](https://ponder.us/group/weeklything/discussions/503)
- [275 / Vision, Sense, Magic](https://ponder.us/group/weeklything/discussions/476)
- [Blogging: A topic and an announcement](https://ponder.us/group/weeklything/discussions/475)
- [Archives now with comments](https://ponder.us/group/weeklything/discussions/473)

---

## Briefly

TinyLetter is the service I first used to publish the Weekly Thing. → **[TinyLetter: looking back on the humblest newsletter platform - The Verge](https://www.theverge.com/24085737/tinyletter-mailchimp-shut-down-email-newsletters)**

I love how geeky this is. → **[Serving my blog posts as Linux manual pages | James' Coffee Blog](https://jamesg.blog/2024/02/29/linux-manual-pages/)**

Is there any functional difference between a checkbox and a switch? I don't think so, but they are a very common and modern UI element. The suggestion is a switch is "on or off" and a checkbox is something to select. Makes sense. → **[An HTML Switch Control | WebKit](https://webkit.org/blog/15054/an-html-switch-control/)**

It is always interesting to see the continuous expansion and evolution of emoji. What did we do before emoji? 😬 → **[iOS 17.4 Emoji Changelog](https://blog.emojipedia.org/ios-17-4-emoji-changelog/)**

I’m a subscriber to Kagi and am excited to see this connection with [Wolfram Alpha](https://www.wolframalpha.com)! → **[Kagi + Wolfram | Kagi Blog](https://blog.kagi.com/kagi-wolfram)**

---

## Fortune

Here is your fortune…

**Keep emotionally active. Cater to your favorite neurosis.**

Thank you for subscribing to the [Weekly Thing](https://weekly.thingelstad.com/)!

---

## Want to support the Weekly Thing?

First — thank you for subscribing and reading. Here are some things you can do that would be great…

- **Share** [Weekly Thing 279 / Nushell, BlackCat, Daemons](https://buttondown.com/weekly-thing/archive/279/) with others you know!
- **Post** about the [Weekly Thing](https://weekly.thingelstad.com) and let others know about it.
- **Join** the [Weekly Thing Forum](https://ponder.us/join/9235b7db) and connect with others.
- **Send** [Bitcoin via Lightning](https://getalby.com/p/weeklything)! This will be used to support something good. ⚡️weeklything@getalby.com
- **[Email me](mailto:jamie@thingelstad.com)** comments, feedback, or just to say Hi!
