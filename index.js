require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const chalk = require('chalk');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = socketIo(server);

// ✅ Middleware รองรับ JSON และฟอร์ม
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let latestData = { temperature: 0, humidity: 0, time: new Date() };

const { log, banner } = require('./logger');

banner(); // แสดงโลโก้สวย ๆ

log('เซิร์ฟเวอร์กำลังเริ่มต้น...', 'info');
log('เชื่อมต่อฐานข้อมูลสำเร็จ', 'success');



// โหลด config.json หรือใช้ค่าเริ่มต้น


const loadConfig =  () => {
  try {
    const rawConfig = fs.readFileSync('config.json');
    const config = JSON.parse(rawConfig);
    log('โหลด config.json สำเร็จ', 'success');
    return config
  } catch (e) {
    log('ไม่พบ config.json หรืออ่านไม่ได้, ใช้ค่าเริ่มต้น', 'warn');
  }
}

// API: ดึง config
app.get('/api/config', (req, res) => {
  log('API /api/config ถูกเรียก', 'info');
  const config = loadConfig();
  res.json(config);
});

// API: บันทึก config
app.post('/api/config', (req, res) => {
  config = req.body;
  try {
    fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
    log('บันทึก config.json สำเร็จ', 'success');
    res.sendStatus(200);
  } catch (e) {
    log('บันทึก config.json ผิดพลาด: ' + e.message, 'error');
    res.status(500).json({ error: 'บันทึก config ผิดพลาด' });
  }
});

app.get('/api/data', (req, res) => {
  try {
    const rawData = fs.readFileSync('data.json');
    const data = JSON.parse(rawData);
    res.json(data); // ✅ ส่งเป็น JSON
  } catch (err) {
    console.error('อ่านไฟล์ผิดพลาด:', err.message);
    res.status(500).json({ error: 'ไม่สามารถโหลดข้อมูลได้' });
  }
});

// กำหนดค่าเริ่มต้นสำหรับ config
// let config = {
//   temperatureThreshold: null,
//   humidityThreshold: null,
//   smoke: null,
//   notify: {
//     discord: true,
//     telegram: true,
//     line: true
//   }
// };
let lastAlertTime = 0;
const ALERT_COOLDOWN = 60 * 1000; // 1 minute

app.post('/data', async (req, res) => {
  const { temperature, humidity, smoke } = req.body;

  if (
    typeof temperature !== 'number' ||
    typeof humidity !== 'number' ||
    typeof smoke !== 'number'
  ) {
    log('ข้อมูลอุณหภูมิ ความชื้น หรือควัน ไม่ถูกต้อง', 'error');
    return res.status(400).json({ error: 'ข้อมูลอุณหภูมิ ความชื้น หรือควัน ไม่ถูกต้อง' });
  }

  latestData = { temperature, humidity, smoke, time: new Date() };
  io.emit('sensorData', latestData);
  log(`รับข้อมูล Temperature: ${temperature}°C, Humidity: ${humidity}%, Smoke: ${smoke}`, 'info');

  const config = loadConfig();

  const isHumidityAlert = humidity > config.humidityThreshold;
  const isTemperatureAlert = temperature > config.temperatureThreshold;
  const isSmokeAlert = smoke > config.smokeThreshold;

  const now = Date.now();

  if ((isHumidityAlert || isTemperatureAlert || isSmokeAlert) && (now - lastAlertTime >= ALERT_COOLDOWN)) {
    lastAlertTime = now;
    const discordPayload = formatAlertEmbed(humidity, temperature, smoke, config);

    try {
      if (config.notify.discord) {
        await sendDiscord(discordPayload);
        log('ส่งแจ้งเตือน Discord สำเร็จ', 'success');
      }

      if (config.notify.telegram) {
        let text = `⚠️ *แจ้งเตือน! ตรวจพบค่าที่เกินกำหนด:*\n`;
        if (isHumidityAlert)
          text += `💧 ความชื้น: ${humidity}% (เกิน ${config.humidityThreshold}%)\n`;
        if (isTemperatureAlert)
          text += `🌡️ อุณหภูมิ: ${temperature}°C (เกิน ${config.temperatureThreshold}°C)\n`;
        if (isSmokeAlert)
          text += `🔥 ควัน: ${smoke} (เกิน ${config.smokeThreshold})\n`;
        text += `\n🕒 เวลา: ${new Date().toLocaleString()}`;
        await sendTelegram(text);
        log('ส่งแจ้งเตือน Telegram สำเร็จ', 'success');
      }

      if (config.notify.line) {
        let msg = `⚠️ แจ้งเตือน:\n`;
        if (isHumidityAlert)
          msg += `💧 ความชื้น: ${humidity}% (เกิน ${config.humidityThreshold}%)\n`;
        if (isTemperatureAlert)
          msg += `🌡️ อุณหภูมิ: ${temperature}°C (เกิน ${config.temperatureThreshold}°C)\n`;
        if (isSmokeAlert)
          msg += `🔥 ควัน: ${smoke} (เกิน ${config.smokeThreshold})\n`;
        msg += `🕒 เวลา: ${new Date().toLocaleString()}`;
        await sendLineNotify(msg);
        log('ส่งแจ้งเตือน LINE Notify สำเร็จ', 'success');
      }
    } catch (error) {
      log(`ส่งแจ้งเตือนผิดพลาด: ${error.message}`, 'error');
    }
  } else if (isHumidityAlert || isTemperatureAlert || isSmokeAlert) {
    log('ข้ามการส่งแจ้งเตือน เพราะยังอยู่ในช่วงหน่วงเวลา', 'warn');
  }

  fs.writeFileSync('data.json', JSON.stringify(latestData, null, 2), "utf8", err => {
    if (err) {
      log('บันทึกข้อมูลล่าสุดผิดพลาด: ' + err.message, 'error');
      return res.status(500).json({ error: 'บันทึกข้อมูลล่าสุดผิดพลาด' });
    }
    log('บันทึกข้อมูลล่าสุดสำเร็จ', 'success');
  });

  res.sendStatus(200);
});

function formatAlertEmbed(humidity, temperature, smoke, config) {
  const fields = [];

  if (humidity > config.humidityThreshold) {
    fields.push({
      name: "💧 ความชื้น",
      value: `${humidity}% (เกิน ${config.humidityThreshold}%)`,
      inline: true
    });
  }

  if (temperature > config.temperatureThreshold) {
    fields.push({
      name: "🌡️ อุณหภูมิ",
      value: `${temperature}°C (เกิน ${config.temperatureThreshold}°C)` ,
      inline: true
    });
  }

  if (smoke > config.smokeThreshold) {
    fields.push({
      name: "🔥 ควัน",
      value: `${smoke} (เกิน ${config.smokeThreshold})`,
      inline: true
    });
  }

  return {
    content: "@everyone",
    embeds: [{
      title: "⚠️ ค่าตรวจจับเกินกำหนด",
      description: "ตรวจพบค่าที่เกินกำหนดจาก ESP32",
      color: 0xff0000,
      fields: fields,
      footer: {
        text: `เวลาที่ตรวจพบ: ${new Date().toLocaleString()}`
      }
    }]
  };
}

// แจ้งเตือน Discord
async function sendDiscord(payload) {
  if (!process.env.DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(process.env.DISCORD_WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    throw new Error('ส่งแจ้งเตือน Discord ผิดพลาด: ' + error.message);
  }
}
// แจ้งเตือน Discord
async function sendDiscord(payload) {
  if (!process.env.DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(process.env.DISCORD_WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    throw new Error('ส่งแจ้งเตือน Discord ผิดพลาด: ' + error.message);
  }
}
async function sendTelegram(message) {
  const botToken = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    log('ไม่พบค่า TELEGRAM_TOKEN หรือ TELEGRAM_CHAT_ID', 'error');
    return;
  }
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: chatId,
      text: message,
    });
  } catch (error) {
    log('ส่งแจ้งเตือน Telegram ผิดพลาด: ' + error.message, 'error');
    if (error.response && error.response.data) {
      log('รายละเอียดจาก Telegram: ' + JSON.stringify(error.response.data), 'error');
    }
  }
}

async function sendLineNotify(message) {
  const lineToken = process.env.LINE_NOTIFY_TOKEN;
  const lineApi = process.env.LINE_NOTIFY_API || 'https://notify-api.line.me/api/notify';
  if (!lineToken) {
    log('ไม่พบค่า LINE_NOTIFY_TOKEN', 'error');
    return;
  }
  try {
    await axios.post(
      lineApi,
      new URLSearchParams({ message }),
      { headers: { Authorization: `Bearer ${lineToken}` } }
    );
  } catch (error) {
    log('ส่งแจ้งเตือน LINE Notify ผิดพลาด: ' + error.message, 'error');
    if (error.response && error.response.data) {
      log('รายละเอียดจาก LINE: ' + JSON.stringify(error.response.data), 'error');
    }
  }
}
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`✅ Server รันที่ http://localhost:${PORT}`, 'success');
});
