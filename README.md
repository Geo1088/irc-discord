# irc-discord-bridge

A script that allows you to chat on IRC without leaving Discord. Some setup required - this is not a public bot.

## Usage

```bash
$ git clone https://github.com/Geo1088/irc-discord.git
$ cd irc-discord
$ cp config_sample.json config.json
# Fill out your config.json
$ npm i
$ node index.js
```

The bot requires that your guild be set up in a specific way:
- There must be a `#notices` text channel that is not in any category
- There must be `Channels` and `Private Messages` categories
- Every IRC channel you connect to must already have a corresponding Discord channel in the `Channels` category, and the name must match up with the one the client expects
  - If you run the bot and a channel is missing, it will tell you what name it was expecting
