import { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events, ComponentType } from 'discord.js';
import fs from 'fs';

// ----- CONFIG -----
const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));

// ----- ROLES -----
const roles = {
  representative: "1448608539156152423",
  senator: "1448608654453510207",
  speaker: "1448608890911723633",
  majLeader: "1448608785588289587",
  potus: "1448609022394765354"
};

// ----- CHANNELS & THREADS -----
const channels = {
  billSubmission: "1448606450573381742",
  houseVoting: "1448608056991551538",
  senateVoting: "1448608082379935805",
  passedHouse: "1448608108728287385",
  passedSenate: "1448608135446007871",
  spkrThread: "1448964188969107496",
  majlThread: "1448964018734628946",
  passedLaws: "PASTE_PASSED_LAWS_CHANNEL_ID_HERE"
};

// ----- CLIENT -----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, () => {
  console.log('Congress RP Bot online!');
});

// ----- DATA STORAGE -----
let bills = [];
let sessions = [];
let currentSession = 1;
let billCounter = 3; // H.R. numbering starts at 003

// ----- HELPERS -----
function createBillEmbed(bill) {
  return new EmbedBuilder()
    .setTitle(`${bill.type.toUpperCase()} - ${bill.name}`)
    .addFields(
      { name: "Proposed By", value: `<@${bill.proposer}>` },
      { name: "Co-Sponsors", value: bill.cosponsors.length ? bill.cosponsors.map(id => `<@${id}>`).join(', ') : "None" },
      { name: "Status", value: bill.status },
      { name: "Chamber", value: bill.chamber },
      { name: "Content", value: bill.content },
      { name: "Original Message", value: `[Jump](${bill.messageLink})` }
    )
    .setColor(bill.color || 0xffffff);
}

function getApprover(bill) {
  return bill.chamber === 'House' ? roles.speaker : roles.majLeader;
}

function getApproverThread(bill) {
  return bill.chamber === 'House' ? channels.spkrThread : channels.majlThread;
}

function getVotingChannel(bill) {
  return bill.chamber === 'House' ? channels.houseVoting : channels.senateVoting;
}

function getPassedChannel(chamber) {
  return chamber === 'House' ? channels.passedHouse : channels.passedSenate;
}

// Voting button row
function voteButtons(isApprover=false) {
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder().setCustomId('vote_yea').setLabel('Yea').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('vote_nay').setLabel('Nay').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('vote_abs').setLabel('Abs').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vote_info').setLabel('Info').setStyle(ButtonStyle.Primary)
  );
  if (isApprover) row.addComponents(
    new ButtonBuilder().setCustomId('vote_end').setLabel('End').setStyle(ButtonStyle.Secondary)
  );
  return row;
}

// Eligible voters
function getEligibleVoters(bill) {
  return bill.chamber==='House' ? roles.representative : roles.senator;
}

// Count votes
function countVotes(votes) {
  const result = { yea:0, nay:0, abs:0 };
  Object.values(votes).forEach(v=>result[v]++);
  return result;
}

// ----- VOTING LOGIC -----
async function endVote(bill, reason='approver') {
  if(!bill.voting.live) return;
  bill.voting.live = false;

  const votes = countVotes(bill.voting.votes);
  const totalVoters = Object.keys(votes).length;
  let required = 0;

  if(bill.type==='Amendment') required = Math.ceil((2/3)*totalVoters);
  else required = Math.floor(totalVoters/2)+1;

  const passed = votes.yea>=required;
  bill.status = passed ? `Passed ${bill.chamber}` : `Failed ${bill.chamber}`;
  bill.color = passed ? 0x00ff00 : 0xff0000;

  const votingChannel = await client.channels.fetch(getVotingChannel(bill));
  await votingChannel.send({ embeds:[createBillEmbed(bill).setFooter({text:`Voting ended: ${reason==='time'?'Time expired':'Approver ended it'}`})] });

  // Cross-chamber notification
  if(passed && bill.bothChamber && !bill.nextChamberPending){
    bill.nextChamberPending = true;
    const otherThread = await client.channels.fetch(getApproverThread({chamber: bill.chamber==='House'?'Senate':'House'}));
    await otherThread.send({ content:`📢 Passed in ${bill.chamber}, awaiting your vote`, embeds:[createBillEmbed(bill).setColor(0xffff00)], components:[voteButtons(true)] });
  }

  // Passed both chambers → #passed-laws
  if(passed && bill.nextChamberPending && bill.bothChamber){
    const passedChannel = await client.channels.fetch(channels.passedLaws);
    await passedChannel.send({ content:`📜 ${bill.name} has passed both chambers ✅ <@${roles.potus}>` });
  }
}

// ----- COMMAND HANDLING -----
client.on(Events.InteractionCreate, async interaction => {
  if(!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if(commandName==='help'){
    const embed = new EmbedBuilder()
      .setTitle("Congress RP Bot Commands")
      .setDescription(`
/bill [name/content] - Propose a bill (House)
/res [name/content] - Resolution (one chamber)
/amm [name/content] - Amendment (both chambers)
/nom - Nomination (Senate)
/motion - Simple motion (one chamber)
/impeach - Articles of Impeachment (House, Rep only)
/cosponsor [bill number] - Add yourself as cosponsor
/sessioninfo - Show current session info
/mybills - Show bills you proposed
/billinfo [bill number] - Detailed bill info
/endvote [bill number] - Approver ends vote early
/passed - View passed bills
/failed - View failed bills
      `)
      .setColor(0x00ffff);
    await interaction.reply({ embeds: [embed] });
  }

  if(['bill','res','amm','motion'].includes(commandName)){
    const name = interaction.options.getString('name')||'Untitled';
    const content = interaction.options.getString('content')||'No content';
    const proposer = interaction.user.id;
    const billNumber = `H.R. ${String(billCounter).padStart(3,'0')}`;
    billCounter++;

    const typeMap = { bill:'Bill', res:'Resolution', amm:'Amendment', motion:'Motion' };
    const chamberMap = { bill:'House', res:'House', amm:'House', motion:'House' };
    const bothChamberRequired = ['bill','amm'].includes(commandName);

    const bill = {
      id: billNumber,
      name,
      content,
      proposer,
      cosponsors: [],
      type: typeMap[commandName],
      chamber: chamberMap[commandName],
      status: `Pending before ${getApprover(bill)===roles.speaker?'Speaker':'Approver'}`,
      messageLink: interaction.url||'N/A',
      color: 0xffff00,
      voting: { live:false, votes:{} },
      bothChamber: bothChamberRequired,
      nextChamberPending: false
    };
    bills.push(bill);

    await interaction.reply({ content: `✅ Your ${typeMap[commandName]} **${name}** has been submitted as **${billNumber}**.` });

    // Notify approver in thread
    const threadId = getApproverThread(bill);
    const approverThread = await client.channels.fetch(threadId);
    await approverThread.send({
      content: `📢 New ${typeMap[commandName]} - **${billNumber}**\nSubmitted by <@${proposer}>\nSession: ${currentSession}\nContent:\n${content}`,
      components:[voteButtons(true)]
    });
  }

  if(commandName==='cosponsor'){
    const billNum = interaction.options.getString('bill');
    const bill = bills.find(b=>b.id===billNum);
    if(!bill) return interaction.reply({content:`❌ Bill ${billNum} not found.`,ephemeral:true});
    if(bill.voting.live) return interaction.reply({content:`⚠ Voting started, cannot cosponsor.`,ephemeral:true});
    if(bill.cosponsors.includes(interaction.user.id)) return interaction.reply({content:`⚠ Already a cosponsor.`,ephemeral:true});
    bill.cosponsors.push(interaction.user.id);
    await interaction.reply({content:`✅ You are now a co-sponsor of ${billNum}.`,ephemeral:true});
  }

  if(commandName==='impeach'){
    if(!interaction.member.roles.cache.has(roles.representative))
      return interaction.reply({content:`❌ Only Representatives can submit Articles of Impeachment.`,ephemeral:true});
    const target = interaction.options.getString('person')||'Unknown';
    const desig = interaction.options.getString('designation')||'Unknown';
    const content = interaction.options.getString('content')||'No content';
    const billNumber = `ART. ${String(billCounter).padStart(3,'0')}`;
    billCounter++;

    const bill = {
      id: billNumber,
      name:`Impeachment of ${target}`,
      content:content,
      proposer:interaction.user.id,
      cosponsors:[],
      type:'Impeachment',
      chamber:'House',
      status:`Pending before Speaker`,
      messageLink:interaction.url||'N/A',
      color:0xffff00,
      voting:{live:false,votes:{}},
      bothChamber:true,
      nextChamberPending:false
    };
    bills.push(bill);
    await interaction.reply({content:`✅ Articles of Impeachment **${billNumber}** submitted.`});

    const spkrThread = await client.channels.fetch(channels.spkrThread);
    await spkrThread.send({ content:`📢 New Impeachment - **${billNumber}**\nTarget: ${target} (${desig})\nSubmitted by <@${interaction.user.id}>\nContent:\n${content}`, components:[voteButtons(true)] });
  }

});

// ----- BUTTON HANDLING -----
client.on(Events.InteractionCreate, async interaction=>{
  if(!interaction.isButton()) return;
  const [action] = interaction.customId.split('_');
  const bill = bills[bills.length-1]; // Simple example; in full deploy use customId to map

  if(action==='vote_yea') bill.voting.votes[interaction.user.id]='yea';
  if(action==='vote_nay') bill.voting.votes[interaction.user.id]='nay';
  if(action==='vote_abs') bill.voting.votes[interaction.user.id]='abs';
  if(action==='vote_info'){
    const info = Object.entries(bill.voting.votes).map(([id,v])=>`<@${id}>: ${v}`).join('\n')||'No votes yet';
    interaction.reply({content:info,ephemeral:true});
  }
  if(action==='vote_end'){
    if(interaction.user.id!==getApprover(bill)) return interaction.reply({content:`Only approver can end vote.`,ephemeral:true});
    endVote(bill, 'approver');
    interaction.reply({content:`Vote ended by approver.`});
  } else interaction.reply({content:`Vote recorded.`,ephemeral:true});
});

client.login(config.token);
