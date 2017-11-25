const IRC = require('irc-framework')
const eris = require('eris')
const BiMap = require('bimap')
const moment = require('moment')

const config = require('./config')

const dc = new eris(config.eris.token)
const irc = new IRC.Client()
irc.connect({
	host: config.irc.host,
	port: config.irc.port,
	nick: config.irc.nick
})

dc.on('error', console.error)

irc.on('registered', () => {
	console.log('IRC client connected.')
	if (config.irc.pass) {
		irc.say('NickServ', `identify ${config.irc.pass}`)
	}
	// Note: At this point if the user is registered they may not have the proper
	//       channel modes and stuff. If stuff happens that relies on that, we
	//       shouldn't call dc.connect() until we hear back from NickServ.
	dc.connect()
})

// Both things are now ready.
let channelMap = new BiMap()
dc.on('ready', () => {
	console.log('Discord client connected.')

	// We need the guild that we're going to be working with.
	const guild = dc.guilds.get(config.guildId)
	if (!guild) {
		console.log('Guild not found. Is the ID valid?')
		process.exit(1)
	}

	// Set up the channel map - associate each IRC channel with a Discord channel.
	for (let channel of config.channels) {
		console.log('Handling channel:', channel)
		const {name, pass} = (typeof channel === 'string') ? {name: channel, pass: ''} : channel

		// IRC channels must have a name that starts with '#'.
		if (!name || !name.startsWith('#')) {
			console.log('Skipping channel with invalid or missing name', name)
			continue
		}

		// Join the channel on IRC.
		const ircChannel = irc.channel(name)
		ircChannel.join()

		// Get (or create) the Discord counterpart for this channel.
		// First, get a valid name for the Discord channel.
		const discordName = name
			// The # prefix is an IRC thing and isn't present in Discord's names.
			.replace(/^#/, '')
			// Discord text channel names are all lowercase.
			.toLowerCase()
			// They're also restricted to alphanumerics, dashes, and underscores.
			.replace(/[^a-z0-9-_]/g, '-')
			// First character must be alphanumeric, not a dash or space.
			.replace(/^[-_]/, '')

		// With this name, see if the channel exists.
		guild.channels.forEach((discordChannel, discordChannelId) => {
			// Must be a text channel.
			if (discordChannel.type !== 0) return
			// Must match our name.
			if (discordChannel.name !== discordName) return
			// TODO: Also make sure this Discord channel hasn't been used yet.

			channelMap.push(name, discordChannelId)
			// TODO: Stop the loop now.
		})
		if (!channelMap.key(name)) {
			// TODO: Refactor this code so we can create channels here. For now,
			//       just yell about it.
			console.log(`No Discord channel found for IRC channel ${name} (was expecting ${discordName}).`)
		}
	}

	// TODO: Also add a channel that can be used to display IRC notices.

	// The channel map is now complete.
	console.log(channelMap.kv)
	console.log()
})

// Handle messages from Discord and send them to the correct IRC channel/user.
dc.on('messageCreate', msg => {
	// Ignore if this is a bot message.
	if (msg.author.id === dc.user.id) return
	// Also ignore this if it's not in a channel we know.
	if (!channelMap.val(msg.channel.id)) return
	console.log(`[dsc] #${msg.channel.name}: <${msg.author.username}> ${msg.content}`)

	// Get the right IRC channel to send this message to.
	const ircName = channelMap.val(msg.channel.id)

	// Replace Discord mentions with plaintext.
	const guild = dc.guilds.get(config.guildId)
	const text = msg.content
		.replace(/<@(\d+)>/g, (match, id) => {
			const member = guild.members.get(id)
			return `@${member.username}`
		})
		.replace(/<#(\d+)>/g, (match, id) => {
			const channel = guild.channels.get(id)
			return `#${channel.name}`
		})
	
	console.log(msg.content, '\n', text)
	
	// Send the modified message to the IRC channel.
	irc.say(ircName, text)

	// Delete the Discord message and replace it with one in the proper format.
	// NOTE: This uses a timeout because otherwise the client was freaking out.
	msg.channel.deleteMessage(msg.id).then(setTimeout(() => {
		// NOTE: Getting the time here is slightly more accurate than using the
		//       Discord message's time, since the message will be displayed in IRC.
		const time = moment().format('HH:mm:ss')
		const text = `\`${time}\` **\`\`${irc.user.nick}\`\`** ${msg.content}`
		msg.channel.createMessage(text)
	}), 50)
})

// Handle message from IRC and send them to the correct Discord channel.
irc.on('notice', e => {
	console.log(`[irc][notice]${e.from_server ? '[server]' : ''} ${e.message}`)
})
irc.on('privmsg', e => {
	console.log(`[irc] ${e.target}: <${e.nick}> ${e.message}`)
	if (e.target.startsWith('#')) {
		const discordChannelId = channelMap.key(e.target)

		// If the message mentions us, add a ping.
		if (e.message.toLowerCase().indexOf(irc.user.nick.toLowerCase()) >= 0) {
			e.message += ` (<@${config.ownerId}>)`
		}

		// Format the message with the time, author, etc.
		// NOTE: Getting the time here is less accurate, but snoonet doesn't seem to
		//       send message times. /shrug
		const time = moment().format('HH:mm:ss')
		const text = `\`${time}\` **\`\`${e.nick}\`\`** ${e.message}`

		// Send the message.
		dc.createMessage(discordChannelId, text)
	} else {
		// TODO
		return
	}
	handleIrcThing()
})
irc.on('action', e => {
	let discordChannelId
	if (e.target.startsWith('#')) {
		discordChannelId = channelMap.key(e.target)
	} else {
		// TODO
		return
	}
	handleIrcThing('action', e, discordChannelId)
})
irc.on('nick', e => {
	// TODO: Don't send to all channels, just the ones that this user is in
	const discordChannelId = ''
	handleIrcThing ('nick', e, discordChannelId)
})

function handleIrcThing (type, e, discordChannelIds) {
	const time = `\`${moment().format('HH:mm:ss')}\``
	let message = ''

	// Format the message acording to its type
	switch (type) {
		case 'privmsg':
			console.log(`[irc] ${e.target}: <${e.nick}> ${e.message}`)
			// If we were mentioned, add a ping
			if (e.message.toLowerCase().indexOf(irc.user.nick.toLowerCase()) >= 0) {
				e.message += ' <@122902150291390469>'
			}
			message = `${time} **\`\`${e.nick}\`\`** ${e.message}`
			break
		
		case 'action':
			console.log(`[irc] ${e.target}: * ${e.nick} ${e.message}`)
			// If we were mentioned, add a ping
			if (e.message.toLowerCase().indexOf(irc.user.nick.toLowerCase()) >= 0) {
				e.message += ' <@122902150291390469>'
			}
			message = `${time} * *\`\`${e.nick}\`\`* ${e.message}`
			break

		case 'nick':
			console.log(`[irc] ${e.nick} --> ${e.new_nick}`)
			message = `${time} \`\`${e.nick} ->\`\` **\`\`${e.new_nick}\`\`**`
			break
	}

	if (!Array.isArray(discordChannelIds)) {
		discordChannelIds = [discordChannelIds]
	}
	discordChannelIds.forEach(id => {
		dc.createMessage(id, message)
		// TODO: .then, .catch
	})
}
