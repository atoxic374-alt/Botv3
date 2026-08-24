# Nitro Boost research

Source: Discord Support, [Server Boosting FAQ](https://support.discord.com/hc/en-us/articles/360028038352-Server-Boosting-FAQ), accessed 2026-08-24.

The official FAQ states that Nitro subscribers receive two server boosts and that transferring a boost to another server requires waiting 7 days. The transfer flow is performed from User Settings > Server Boost, by selecting the current server and choosing Transfer Boost, then selecting the target server and confirming.

Implementation implication: the application must not guess a cooldown from local timestamps. It should request the account's current Nitro/boost state from Discord, display the server associated with each boost and the server-provided transfer availability timestamp when available, and refuse a transfer until the account data says the boost is available. If Discord does not expose a usable timestamp for a specific account, the UI must show the state as unknown rather than claiming that the boost is ready.


A review of the official Discord Guild API reference at https://docs.discord.com/developers/resources/guild found public bot-oriented Guild and Guild Member resources, but no documented user endpoint for Nitro boost slots or per-boost transfer cooldowns. Therefore, any implementation that depends on undocumented private user endpoints would be brittle and should not fabricate a remaining time when the account response does not provide one.


Additional non-official reference: Discord Userdoccers documents the following client-facing user-token routes: GET /users/@me/guilds/premium/subscription-slots, GET /users/@me/guilds/premium/subscriptions, and GET /users/@me/guilds/premium/subscriptions/cooldown. It describes slot fields including cooldown_ends_at and the cooldown response fields ends_at, limit, and remaining. These are not in the official Discord developer reference, so the implementation should treat them as best-effort private client routes: display exact values returned by the account, preserve an explicit unknown/error state on endpoint failure, and never calculate a fabricated cooldown.

Reference list from the reviewed non-official endpoint inventory: https://gist.github.com/hackermondev/5c928ca12b4f4e6320100b11f798c23b. It lists the client route /users/@me/guilds/premium/subscriptions/cooldown, but does not establish an official public API contract.


The reviewed subscription page does not expose a documented Apply/Transfer endpoint in its visible endpoint list; it documents the slot and cooldown reads but marks the user routes as client-facing/private. The current implementation plan therefore needs a read-first approach: fetch slots and cooldown from the selected account, expose the exact returned values, and avoid claiming that a boost was moved unless Discord confirms it. Any write endpoint for applying/transferring a boost must be feature-flagged or treated as an undocumented compatibility path, with the UI surfacing Discord's actual error response.


Reviewed developer examples: qoft/discord-server-booster/main.py on GitHub reads `/users/@me/guilds/premium/subscription-slots`, takes each slot `id`, and sends `PUT /guilds/{guildID}/premium/subscriptions` with JSON `{ user_premium_guild_subscription_slot_ids: [slotId] }`. Its status handling treats HTTP 201 as success and HTTP 400 as already used, but it does not read or calculate an account cooldown, so its cooldown logic is insufficient by itself.

Reviewed Reddit discussion https://www.reddit.com/r/discordapp/comments/115bnkv/nitro_question_it_says_i_get_two_server_boost_if/. Multiple commenters report that Nitro provides two boosts and that moving a boost requires a one-week cooldown. This supports the official Discord FAQ, but Reddit is anecdotal and is not used as the source of truth for the application.
