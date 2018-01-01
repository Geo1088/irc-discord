const IRC = require('irc-framework')
const colors = require('irc-colors')
const Eris = require('eris')
const BiMap = require('bimap')
const moment = require('moment')
const config = require('./config')

const dc = new Eris.Client(config.eris.token)
const irc = new IRC.Client()

let guild // The guild the bot is connected to
let channelsCategoryId // The ID of the category representing IRC channels
let usersCategoryId // The ID of the category representing IRC private messages
let noticesChannelId // The ID of the channel for displaying notices/wallops
let channelMap = new BiMap()

dc.on('error', console.error)
dc.on('ready', () => {
	console.log('Discord client connected.')

	// We need the guild that we're going to be working with.
	guild = dc.guilds.get(config.guildId)
	if (!guild) {
		console.log('Guild not found. Is the ID valid?')
		process.exit(1)
	}

	// Once we have the guild, find the channel for notices and wallops.
	const noticesChannel = guild.channels.find(c => c.name === 'notices' && c.type === 0 && !c.parentID)
	if (!noticesChannel) {
		// TODO: Create these.
		console.log('Guild has no notices channel. Create a text channel called #notices under no category.')
		process.exit(1)
	}
	noticesChannelId = noticesChannel.id

	// The guild also needs to have categories set up to differentiate between
	// channels and users.
	const channelsCategory = guild.channels.find(c => c.name === 'Channels' && c.type === 4)
	const usersCategory = guild.channels.find(c => c.name === 'Private Messages' && c.type == 4)
	if (!channelsCategory || !usersCategory) {
		// TODO: Create these.
		console.log('Guild does not have the right categories. Create categories called "Channels" and "Private Messages".')
		process.exit(1)
	}
	channelsCategoryId = channelsCategory.id
	usersCategoryId = usersCategory.id

	// Now that we know the guild is all set, we can connect to IRC.
	irc.connect({
		host: config.irc.host,
		port: config.irc.port,
		nick: config.irc.nick
	})
})

irc.on('registered', () => {
	console.log('IRC client connected.')
	// If we have a nickserv password, use it immediately.
	if (config.irc.nickservPass) {
		irc.say('NickServ', `identify ${config.irc.nickservPass}`)
	}
	// Note: At this point if the user is registered they may not have the proper
	//       channel modes and stuff. If stuff happens that relies on that, we
	//       shouldn't continue until we hear back from NickServ.

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
		let discordChannel = guild.channels.find(c => c.name === discordName && c.parentID === channelsCategoryId)
		if (discordChannel) {
			channelMap.push(name, discordChannel.id)
		} else {
			// TODO: Refactor this code so we can create channels here. For now,
			//       just yell about it.
			console.log(`No Discord channel found for IRC channel ${name} (was expecting #${discordName}). If it's there, is it in the right category?`)
		}
	}

	// The channel map is now complete. We're ready to start bridging messages.
	console.log(channelMap.kv)
	console.log()
})

// Handle messages from Discord and send them to the correct IRC channel/user.
dc.on('messageCreate', msg => {
	// Ignore if this is a bot message.
	if (msg.author.id === dc.user.id) return
	// In here we do commands and stuff
	if (!msg.channel.guild) return handleCommand(msg)
	// Also ignore this if it's not in a channel we know.
	if (!channelMap.val(msg.channel.id)) return

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

	// Send the modified message to the IRC channel.
	irc.say(ircName, text)

	// If the configured to, delete the Discord message and replace it with one in
	// the proper format.
	// NOTE: This uses a timeout because otherwise the client was freaking out. We
	//       also create a fake message object here to keep the format consistent;
	//       however, this object is not complete, and only includes properties
	//       that change its text representation.
	if (config.replaceMessages) {
		msg.channel.deleteMessage(msg.id).then(() => setTimeout(() => {
			const message = {
				nick: irc.user.nick,
				message: msg.content
			}
			handleIrcThing('privmsg', message, msg.channel.id)
		}), 50)
	}
})

// Handle messages from IRC and send them to the correct Discord channel.
// TODO: Honestly, just refactor these to work with `irc.on('message', ...)`.
irc.on('notice', e => {
	handleIrcThing('notice', e, noticesChannelId)
})
irc.on('wallops', e => {
	handleIrcThing('wallops', e, noticesChannelId)
})
irc.on('privmsg', e => {
	let discordChannelId
	if (e.target.startsWith('#')) {
		discordChannelId = channelMap.key(e.target)
	} else {
		// TODO
		return
	}
	handleIrcThing('privmsg', e, discordChannelId)
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
	// TODO: Filter this so it only includes channels the user was actually in
	const discordChannelId = Object.keys(channelMap.vk)
	handleIrcThing ('nick', e, discordChannelId)
})
irc.on('join', e => {
	const discordChannelId = channelMap.key(e.channel)
	handleIrcThing('join', e, discordChannelId)
})
irc.on('part', e => {
	const discordChannelId = channelMap.key(e.channel)
	handleIrcThing('part', e, discordChannelId)
})
irc.on('quit', e => {
	// TODO: Filter this so it only includes channels the user was actually in
	const discordChannelIds = Object.keys(channelMap.vk)
	handleIrcThing ('quit', e, discordChannelIds)
})
irc.on('kick', e => {
	const discordChannelIds = channelMap.key(e.channel)
	handleIrcThing('kick', e, discordChannelIds)
})

function handleIrcThing (type, e, discordChannelIds) {
	let message = ''

	// Format the message acording to its type
	switch (type) {
		case 'privmsg':
			message = `**\`\`${e.nick}\`\`** ${e.message}`
			break

		case 'action':
			message = `\`\`* ${e.nick}\`\` ${e.message}`
			break

		case 'wallops':
			message = `\`[wallops]\` ${e.from_server ? '\`[server]\`' : `**\`\`${e.nick}\`\`**`} ${e.message}`
			break

		case 'notice':
			message = `\`[notice]\` ${e.from_server ? '\`[server]\`' : `**\`\`${e.nick}\`\`**`} ${e.message}`
			break

		case 'nick':
			message = `\\:left_right_arrow: \`\`${e.nick}\`\` is now **\`\`${e.new_nick}\`\`**`
			break

		case 'away':
			message = `⇠ **\`\`${e.nick}\`\`** went away${e.message ? ` (${e.message})` : ''}`
			break

		case 'back':
			message = `⇢ **\`\`${e.nick}\`\`** is back${e.message ? ` (${e.message})` : ''}`
			break

		case 'join':
			message = `→ **\`\`${e.nick}\`\`** has joined`
			break

		case 'part':
			message = `← \`\`${e.nick}\`\` has left (Part${e.message ? `: ${e.message}` : ''})`
			break

		case 'quit':
			message = `← \`\`${e.nick}\`\` has left (Quit${e.message ? `: ${e.message}` : ''})`
			break

		case 'kick':
			message = `← \`\`${e.kicked}\`\` has left (Kicked by **\`\`${e.nick}\`\`**${e.reason ? `: ${e.reason}` : ''})`
			break
	}

	// Strip IRC color codes from the message
	message = colors.stripColorsAndStyle(message)

	// If we were mentioned in a privmsg or action, ping us.
	if (['privmsg', 'action'].includes(type)) {
		if (e.message.toLowerCase().indexOf(irc.user.nick.toLowerCase()) >= 0) {
			// TODO: Dynamically use the ID of the bot's owner for this
			message += ' (<@122902150291390469>)'
		}
	}

	// Since this could be an array or not, convert it to an array and loop.
	if (!Array.isArray(discordChannelIds)) {
		discordChannelIds = [discordChannelIds]
	}
	discordChannelIds.forEach(id => {
		dc.createMessage(id, message).then(msg => {
			// Nothing else to do
		}, err => {
			console.log(err)
		})
	})
}


function handleCommand(msg) {
	console.log('== eval ==')
	if (msg.content.startsWith('```') && msg.content.endsWith('```')) {
		if (msg.content.startsWith('```js')) {
			msg.content = msg.content.substring(5, msg.content.length - 3)
		} else {
			msg.content = msg.content.substring(3, msg.content.length - 3)
		}
		let things
		try {
			things = new String(eval(msg.content)).toString()
		} catch (e) {
			things = e.toString()
		}
		console.log(things)
		msg.channel.createMessage(things)
	}
}

dc.connect()
