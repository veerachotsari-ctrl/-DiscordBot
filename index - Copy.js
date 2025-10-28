require('dotenv').config();
const { 
Client, 
GatewayIntentBits, 
Events,
ActionRowBuilder,
ButtonBuilder,
ButtonStyle
} = require('discord.js');
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
// 💡 นำเข้า http module เพื่อสร้าง Web Server (Keep Alive)
const http = require('http'); 

// ⚠️ ตรวจสอบให้แน่ใจว่าไฟล์ credentials.json อยู่ในโฟลเดอร์เดียวกัน
const credentials = require('./credentials.json'); 

// ===================================
// 🛠️ CONFIGURATION
// ===================================
const CONFIG = {
// ❗❗ ID ชีตของคุณ
SPREADSHEET_ID: '18Thz-4LBvkwn77gMEUDxL19sh0t1WXAOoh408UJ5BSY', 
SHEET_NAME: 'bot3',

// 🚩 รายการ Channel ID ที่ต้องการนับ (คอลัมน์ C, D, E, ...)
CHANNEL_IDS: [
'1426879119966339114', // Channel 1 -> คอลัมน์ C (Index 0)
'1426879191932211200', // Channel 2 -> คอลัมน์ D (Index 1)
'1426879230213357618'  // Channel 3 -> คอลัมน์ E (Index 2)
],
// ID ช่องสำหรับส่งปุ่มเริ่มนับสถิติย้อนหลัง (Historical Count)
COMMAND_CHANNEL_ID: '1432300750830309477', 

// 🚫 ID ผู้ใช้ที่ต้องการยกเว้นจากการนับทั้งหมด
EXCLUDED_USER_ID: '', 

// ตั้งค่าความหน่วง (ms) เพื่อหลีกเลี่ยง Rate Limit ของ Google Sheets API
BATCH_DELAY: 150, 
UPDATE_DELAY: 50,
};

const COUNT_BUTTON_ID = 'start_historical_count';

// ===================================
// 🤖 DISCORD BOT INITIALIZATION
// ===================================
const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent,
GatewayIntentBits.GuildMembers 
]
});

// ===================================
// 📊 GOOGLE SHEETS SETUP (JWT)
// ===================================
const auth = new JWT({
email: credentials.client_email,
key: credentials.private_key,
scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const gsapi = google.sheets({ version: 'v4', auth });


// ===================================
// 📚 CORE FUNCTIONS
// ===================================

/**
 * สร้างข้อความที่มีปุ่มสำหรับเริ่มนับสถิติย้อนหลัง
 */
function getStartCountMessage() {
const row = new ActionRowBuilder()
.addComponents(
new ButtonBuilder()
.setCustomId(COUNT_BUTTON_ID)
.setLabel('⭐ เริ่มนับสถิติข้อความเก่า')
.setStyle(ButtonStyle.Primary),
);

return {
components: [row]
};
}


/**
 * ฟังก์ชันหลักในการอัปเดตสถิติลง Google Sheets 
 */
async function batchUpdateMentions(batchMap, channelIndex) {
const range = `${CONFIG.SHEET_NAME}!A:E`; 
const response = await gsapi.spreadsheets.values.get({
spreadsheetId: CONFIG.SPREADSHEET_ID,
range
});

const rows = response.data.values || [];
const updates = [];
const colIndex = 2 + channelIndex; 

for (const [key, count] of batchMap.entries()) {
const [username, mentionText] = key.split('|');
let rowIndex = rows.findIndex(r => r[0] === username && r[1] === mentionText);

if (rowIndex >= 0) {
const current = parseInt(rows[rowIndex][colIndex] || '0');
const newCount = current + count;
updates.push({
range: `${CONFIG.SHEET_NAME}!${String.fromCharCode(65+colIndex)}${rowIndex+1}`, 
values: [[newCount]]
});
rows[rowIndex][colIndex] = newCount;
} else {
const appendRow = rows.length + 1; 
const newRow = [username, mentionText, 0, 0, 0];
newRow[colIndex] = count;
updates.push({
range: `${CONFIG.SHEET_NAME}!A${appendRow}:E${appendRow}`,
values: [newRow]
});
rows.push(newRow);
}
}

for (const u of updates) {
await gsapi.spreadsheets.values.update({
spreadsheetId: CONFIG.SPREADSHEET_ID,
range: u.range,
valueInputOption: 'RAW',
requestBody: { values: u.values }
});
await new Promise(r => setTimeout(r, CONFIG.UPDATE_DELAY));
}
}


/**
 * ประมวลผลข้อความเพื่อดึง Nickname และนับ Mention
 */
async function processMessagesBatch(messages, channelIndex) {

const EXCLUDED_USER_ID = CONFIG.EXCLUDED_USER_ID; 
const batchMap = new Map();

for (const message of messages) {
if (message.author.bot) continue;
if (message.mentions.users.size === 0) continue;
if (!message.guild) continue; 

for (const user of message.mentions.users.values()) {

if (EXCLUDED_USER_ID && user.id === EXCLUDED_USER_ID) continue; 

let member = message.guild.members.cache.get(user.id);
if (!member) {
try {
member = await message.guild.members.fetch(user.id);
} catch (e) {
continue; 
}
}

if (!member) continue; 

// 1. คอลัมน์แรก (Nickname): ใช้ DisplayName/Nickname (ถูกต้องแล้ว)
const username = member.displayName; 

// 2. คอลัมน์ที่สอง (Mention Text): ใช้ Username 
const mentionText = user.username; 

const regex = new RegExp(`<@!?${user.id}>`, 'g');
let match;
let mentionCount = 0;
// นับจำนวนครั้งที่มีการ Mention ในข้อความ
while ((match = regex.exec(message.content)) !== null) {
mentionCount++;
}

if (mentionCount > 0) {
// key จะเป็น 'Nickname|Username'
const key = `${username}|${mentionText}`; 
batchMap.set(key, (batchMap.get(key) || 0) + mentionCount);
}
}
}

if (batchMap.size > 0) {
await batchUpdateMentions(batchMap, channelIndex);
}
}


/**
 * ดึงและประมวลผลข้อความเก่าจาก Channel (Historical Count)
 */
async function processOldMessages(channelId, channelIndex) {
try {
const channel = await client.channels.fetch(channelId).catch(() => null);
if (!channel) return console.log(`Channel ${channelId} not found.`);

let lastId;
while (true) {
const options = { limit: 50 };
if (lastId) options.before = lastId;

const messages = await channel.messages.fetch(options);
if (messages.size === 0) break;

await Promise.all(messages.map(m => m.partial ? m.fetch() : m)); 

await processMessagesBatch(messages.values(), channelIndex);
lastId = messages.last().id;
await new Promise(r => setTimeout(r, CONFIG.BATCH_DELAY));
}
console.log(`Finished processing old messages for channel ${channelId}.`);
} catch (error) {
console.error(`Error processing channel ${channelId}:`, error);
}
}

// ===================================
// 🚦 DISCORD EVENTS
// ===================================

// ====== Bot Ready (ส่งปุ่มคำสั่ง) ======
client.once(Events.ClientReady, async () => {
console.log(`Logged in as ${client.user.tag}`);

try {
const commandChannel = await client.channels.fetch(CONFIG.COMMAND_CHANNEL_ID);
if (commandChannel && commandChannel.isTextBased()) {
// ส่งปุ่มเพื่อเรียกใช้ Historical Count
await commandChannel.send(getStartCountMessage());
console.log(`Sent start count button to channel ${CONFIG.COMMAND_CHANNEL_ID}`);
}
} catch (error) {
console.error('Error sending start count button:', error);
}
});

// ====== จัดการเมื่อมีการกดปุ่ม (Historical Count Trigger) ======
client.on(Events.InteractionCreate, async interaction => {
if (!interaction.isButton()) return;
if (interaction.customId !== COUNT_BUTTON_ID) return;

// ตอบกลับทันทีแบบชั่วคราว (Ephemeral)
await interaction.deferReply({ ephemeral: true }); 

try {
// 1. ข้อความแจ้งเริ่มต้นการทำงาน
await interaction.editReply({ content: '✅ กำลังเริ่มนับสถิติข้อความเก่า... (ขั้นตอนนี้อาจใช้เวลานาน)' });

// เริ่มกระบวนการนับสถิติข้อความเก่า
for (let i = 0; i < CONFIG.CHANNEL_IDS.length; i++) {
await processOldMessages(CONFIG.CHANNEL_IDS[i], i);
}

// 2. แจ้งผลลัพธ์และลบข้อความ
await interaction.editReply('🎉 การนับสถิติข้อความเก่าเสร็จสมบูรณ์แล้ว! ข้อความนี้จะถูกลบอัตโนมัติใน 5 วินาที');
await new Promise(r => setTimeout(r, 5000));
await interaction.deleteReply();

} catch (error) {
console.error('[Historical Count Error]:', error);
await interaction.editReply('❌ เกิดข้อผิดพลาดในการนับสถิติ โปรดตรวจสอบ Log ของบอท');
}
});

// ====== [เพิ่ม] จัดการเมื่อมีข้อความใหม่เข้ามา (Real-Time Count) ======
client.on(Events.MessageCreate, async message => {
// 1. กรองข้อความที่ไม่ต้องการนับ
if (message.author.bot) return;
if (message.mentions.users.size === 0) return;
if (!message.guild) return;
if (CONFIG.EXCLUDED_USER_ID && message.author.id === CONFIG.EXCLUDED_USER_ID) return;

// 2. ตรวจสอบว่า Channel ID อยู่ในรายการที่ต้องการนับหรือไม่
const channelId = message.channelId;
const channelIndex = CONFIG.CHANNEL_IDS.indexOf(channelId);

if (channelIndex === -1) return;

try {
// 3. ประมวลผลและอัปเดตสถิติ
await processMessagesBatch([message], channelIndex);

console.log(`[Real-Time] Updated mention count for message in channel ${channelId}.`);

} catch (error) {
console.error('[Real-Time Count Error]:', error);
}
});


// ===================================
// 🌐 WEB SERVER (Keep Alive / 24/7)
// ===================================
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('✅ Discord Bot is alive and running on Replit!');
  res.end();
}).listen(3000, () => {
  console.log('🌐 Web server running on port 3000 for UptimeRobot.');
});



// ===================================
// 🔑 LOGIN
// ===================================
// ใช้ DISCORD_TOKEN หรือ TOKEN ก็ได้ ถ้าใน .env มีตัวใดตัวหนึ่ง
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
client.login(DISCORD_TOKEN);