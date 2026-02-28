import discord
from discord.ext import commands
from discord import app_commands
import os
import json
import time

TOKEN = os.environ["TOKEN"]

intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)

DATA_FILE = "data.json"


# ---------------- STORAGE ---------------- #

def load_data():
    try:
        with open(DATA_FILE, "r") as f:
            return json.load(f)
    except:
        return {}

def save_data(data):
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=4)

def get_guild(guild_id):
    data = load_data()
    if str(guild_id) not in data:
        data[str(guild_id)] = {
            "twitter_open": True,
            "twitter_channel_id": None,
            "profiles": {},
            "tweets": {},
            "muted_users": [],
            "muted_usernames": []
        }
        save_data(data)
    return data[str(guild_id)]

def update_guild(guild_id, guild_data):
    data = load_data()
    data[str(guild_id)] = guild_data
    save_data(data)


# ---------------- UTIL ---------------- #

def format_count(n):
    if n >= 1_000_000:
        return f"{round(n/1_000_000,1)}M"
    if n >= 1_000:
        return f"{round(n/1_000,1)}K"
    return str(n)


# ---------------- BUTTONS ---------------- #

class TweetView(discord.ui.View):
    def __init__(self, message_id, guild_id):
        super().__init__(timeout=None)
        self.message_id = str(message_id)
        self.guild_id = str(guild_id)

    @discord.ui.button(label="Like", style=discord.ButtonStyle.secondary, emoji="❤️")
    async def like(self, interaction: discord.Interaction, button: discord.ui.Button):
        data = load_data()
        tweet = data[self.guild_id]["tweets"][self.message_id]

        user_id = str(interaction.user.id)

        if user_id in tweet["likes"]:
            tweet["likes"].remove(user_id)
        else:
            tweet["likes"].append(user_id)

        save_data(data)
        await update_embed(interaction, data, self.guild_id, self.message_id)

    @discord.ui.button(label="Retweet", style=discord.ButtonStyle.secondary, emoji="🔁")
    async def retweet(self, interaction: discord.Interaction, button: discord.ui.Button):
        data = load_data()
        tweet = data[self.guild_id]["tweets"][self.message_id]

        user_id = str(interaction.user.id)

        if user_id in tweet["retweets"]:
            tweet["retweets"].remove(user_id)
        else:
            tweet["retweets"].append(user_id)

        save_data(data)
        await update_embed(interaction, data, self.guild_id, self.message_id)


async def update_embed(interaction, data, guild_id, message_id):
    tweet = data[guild_id]["tweets"][message_id]
    message = await interaction.channel.fetch_message(int(message_id))

    embed = message.embeds[0]
    like_count = len(tweet["likes"])
    rt_count = len(tweet["retweets"])

    embed.set_field_at(
        0,
        name="",
        value=f"❤️ {format_count(like_count)}   🔁 {format_count(rt_count)}",
        inline=False
    )

    await message.edit(embed=embed)
    await interaction.response.defer()


# ---------------- EVENTS ---------------- #

@bot.event
async def on_ready():
    await bot.tree.sync()
    print(f"Logged in as {bot.user}")

@bot.event
async def on_message(message):
    if message.author.bot:
        return

    guild_data = get_guild(message.guild.id)

    if guild_data["twitter_channel_id"] != message.channel.id:
        return

    if not guild_data["twitter_open"]:
        return await message.reply("🔒 Twitter is closed.")

    if str(message.author.id) in guild_data["muted_users"]:
        return await message.reply("🔇 You are muted.")

    username = message.author.name

    if username in guild_data["muted_usernames"]:
        return await message.reply("🔕 This username is muted.")

    profile = guild_data["profiles"].get(str(message.author.id), {})

    profile_name = profile.get("profile_name") or message.author.display_name
    profile_username = profile.get("username") or message.author.name
    avatar = profile.get("profile_pic") or message.author.display_avatar.url

    embed = discord.Embed(description=f"@{profile_username}\n\n{message.content}", color=0x000000)
    embed.set_author(name=profile_name, icon_url=avatar)
    embed.add_field(name="", value="❤️ 0   🔁 0", inline=False)
    embed.set_footer(text=f"X.com • <t:{int(time.time())}:t>")

    await message.delete()
    sent = await message.channel.send(embed=embed)

    guild_data["tweets"][str(sent.id)] = {
        "author_id": str(message.author.id),
        "likes": [],
        "retweets": []
    }

    update_guild(message.guild.id, guild_data)

    await sent.edit(view=TweetView(sent.id, message.guild.id))


# ---------------- SLASH COMMANDS ---------------- #

@bot.tree.command(name="default")
@app_commands.describe(channel="Set Twitter channel")
async def default_channel(interaction: discord.Interaction, channel: discord.TextChannel):
    if not interaction.user.guild_permissions.administrator:
        return await interaction.response.send_message("Admin only.", ephemeral=True)

    guild_data = get_guild(interaction.guild.id)
    guild_data["twitter_channel_id"] = channel.id
    update_guild(interaction.guild.id, guild_data)

    await interaction.response.send_message("✅ Default Twitter channel set.")


@bot.tree.command(name="close")
async def close(interaction: discord.Interaction):
    if not interaction.user.guild_permissions.administrator:
        return await interaction.response.send_message("Admin only.", ephemeral=True)

    guild_data = get_guild(interaction.guild.id)
    guild_data["twitter_open"] = False
    update_guild(interaction.guild.id, guild_data)

    await interaction.response.send_message("🔒 Twitter closed.")


@bot.tree.command(name="open")
async def open_cmd(interaction: discord.Interaction):
    if not interaction.user.guild_permissions.administrator:
        return await interaction.response.send_message("Admin only.", ephemeral=True)

    guild_data = get_guild(interaction.guild.id)
    guild_data["twitter_open"] = True
    update_guild(interaction.guild.id, guild_data)

    await interaction.response.send_message("🔓 Twitter opened.")


@bot.tree.command(name="profile_setname")
async def profile_setname(interaction: discord.Interaction, name: str):
    guild_data = get_guild(interaction.guild.id)
    profile = guild_data["profiles"].setdefault(str(interaction.user.id), {})
    profile["profile_name"] = name
    update_guild(interaction.guild.id, guild_data)

    await interaction.response.send_message("✅ Profile name updated.", ephemeral=True)


@bot.tree.command(name="profile_setuser")
async def profile_setuser(interaction: discord.Interaction, username: str):
    guild_data = get_guild(interaction.guild.id)
    profile = guild_data["profiles"].setdefault(str(interaction.user.id), {})
    profile["username"] = username
    update_guild(interaction.guild.id, guild_data)

    await interaction.response.send_message("✅ Username updated.", ephemeral=True)


@bot.tree.command(name="profile_setpic")
async def profile_setpic(interaction: discord.Interaction, image: discord.Attachment):
    guild_data = get_guild(interaction.guild.id)
    profile = guild_data["profiles"].setdefault(str(interaction.user.id), {})
    profile["profile_pic"] = image.url
    update_guild(interaction.guild.id, guild_data)

    await interaction.response.send_message("✅ Profile picture updated.", ephemeral=True)


@bot.tree.command(name="profile_reset")
async def profile_reset(interaction: discord.Interaction):
    guild_data = get_guild(interaction.guild.id)
    guild_data["profiles"].pop(str(interaction.user.id), None)
    update_guild(interaction.guild.id, guild_data)

    await interaction.response.send_message("✅ Profile reset.", ephemeral=True)


@bot.tree.command(name="mute_user")
async def mute_user(interaction: discord.Interaction, user: discord.Member):
    if not interaction.user.guild_permissions.administrator:
        return await interaction.response.send_message("Admin only.", ephemeral=True)

    guild_data = get_guild(interaction.guild.id)
    guild_data["muted_users"].append(str(user.id))
    update_guild(interaction.guild.id, guild_data)

    await interaction.response.send_message("🔇 User muted.")


@bot.tree.command(name="unmute_user")
async def unmute_user(interaction: discord.Interaction, user: discord.Member):
    guild_data = get_guild(interaction.guild.id)
    guild_data["muted_users"].remove(str(user.id))
    update_guild(interaction.guild.id, guild_data)

    await interaction.response.send_message("🔊 User unmuted.")


bot.run(MTQ3NzI0NjAxNTg4MTg3NTQ1Ng.GzkyO_.MVXosE4yMWVNiT5kXb0XiRMsqzl0ye8tPROrA8)
