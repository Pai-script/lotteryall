const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKEN = '8298525238:AAGIfiB1yXQBpkcR01kWIBzi7ImCWoVv7Qw';
const bot = new TelegramBot(TOKEN, { polling: true });

const SLOT_SECONDS = 30;
const FIREBASE_URL = "https://admin-panel-17295-default-rtdb.firebaseio.com/users";

// Create axios instance with better timeout settings
const axiosInstance = axios.create({
  timeout: 15000,
  maxRedirects: 5,
});

// ===== USER SYSTEM =====
const verifiedUsers = new Set();
const users = new Map();
const userStats = new Map();
const predictionHistory = new Map();
const keyExpiryTimers = new Map();
const awaitingKeyRenewal = new Set();
const userNames = new Map();
const awaitingFeedback = new Set();
const userPredictionHistory = new Map();
const reversePredictionMode = new Map(); // Track reverse prediction mode for users

// Feedback file path
const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');

// Load existing feedback
let feedbackData = [];
try {
  if (fs.existsSync(FEEDBACK_FILE)) {
    const data = fs.readFileSync(FEEDBACK_FILE, 'utf8');
    feedbackData = JSON.parse(data);
  }
} catch (err) {
  console.error('Error loading feedback data:', err.message);
}

// ===== API CONFIGURATIONS =====
const SITE_CONFIGS = {
  BIGWIN: {
    name: "BIGWIN",
    issueUrl: "https://api.bigwinqaz.com/api/webapi/GetGameIssue",
    resultsUrl: "https://api.bigwinqaz.com/api/webapi/GetNoaverageEmerdList",
    issueParams: {
      typeId: 30, 
      language: 7,
      random: "261a65ff89cf41b0aa6d41d9d90325b0",
      signature: "8F29D6BBF728613DD4BB349D5175AD15"
    },
    resultsParams: {
      pageSize: 10, 
      pageNo: 1, 
      typeId: 30, 
      language: 7,
      random: "248642421cd847fbbf3d33630ee82d5e",
      signature: "FE3C4A5BD61772C9B727C1553CA60ACC"
    }
  },
  CKLOTTERY: {
    name: "CK Lottery",
    issueUrl: "https://ckygjf6r.com/api/webapi/GetGameIssue",
    resultsUrl: "https://ckygjf6r.com/api/webapi/GetNoaverageEmerdList",
    issueParams: {
      typeId: 30, 
      language: 0,
      random: "774d25089b1343f5ba429338c40ea392",
      signature: "B71A92AF0C016602E261D1B9841E8512"
    },
    resultsParams: {
      pageSize: 10, 
      pageNo: 1, 
      typeId: 30, 
      language: 0,
      random: "02665bc135314581bbed5871dbcafd76",
      signature: "E378DD1066AF70E7F50A081F2937A4D4"
    }
  },
  '6LOTTERY': {
    name: "6 Lottery",
    issueUrl: "https://6lotteryapi.com/api/webapi/GetGameIssue",
    resultsUrl: "https://6lotteryapi.com/api/webapi/GetNoaverageEmerdList",
    issueParams: {
      typeId: 30, 
      language: 7,
      random: "ca5c3278bf9a4f03a3d697739ff651d3",
      signature: "A75B4144E68340E4B5CB0942BC0DC6AD"
    },
    resultsParams: {
      pageSize: 10, 
      pageNo: 1, 
      typeId: 30, 
      language: 7,
      random: "78ec91eeaea24c7989f0ee62c18c32f4",
      signature: "9CBCA8B97F6ABE8FCAE8C0BF66126C30"
    }
  }
};

// ===== FIREBASE KEY CHECK =====
async function checkKeyValidity(key, chatId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const userName = userNames.get(chatId) || 'Unknown User';
      console.log(`🔑 Checking key validity for user: ${userName} (Attempt ${i+1}/${retries})`);
      
      const res = await axiosInstance.get(`${FIREBASE_URL}/${key}.json`, {
        timeout: 10000
      });
      
      const data = res.data;
      if (!data) {
        console.log(`❌ Invalid key format for user: ${userName}`);
        return { valid: false, reason: "Invalid Key\nContact Developer @leostrike223 for key" };
      }
      
      if (Date.now() > data.expiresAt) {
        console.log(`❌ Expired key for user: ${userName}`);
        return { valid: false, reason: "Expired Key\nContact Developer @leostrike223 for renewal" };
      }
      
      keyExpiryTimers.set(chatId, data.expiresAt);

      const devices = data.devices ? Object.keys(data.devices).length : 0;
      if (devices >= (data.deviceLimit || 1)) {
        console.log(`❌ Device limit reached for user: ${userName}`);
        return { valid: false, reason: "Device Limit Reached\nContact Developer @leostrike223" };
      }
      
      console.log(`✅ Valid key for user: ${userName}, expires: ${new Date(data.expiresAt).toLocaleString()}`);
      return { valid: true, reason: "Valid" };
      
    } catch (err) {
      const userName = userNames.get(chatId) || 'Unknown User';
      console.error(`❌ Firebase REST Error (Attempt ${i+1}/${retries}) for user ${userName}:`, err.message);
      
      if (i === retries - 1) {
        if (err.code === 'ECONNRESET') {
          return { valid: false, reason: "Connection Error: Please try again" };
        } else if (err.code === 'ETIMEDOUT') {
          return { valid: false, reason: "Connection Timeout: Please try again" };
        } else if (err.response && err.response.status === 404) {
          return { valid: false, reason: "Invalid Key\nContact Developer @leostrike223 for key" };
        } else {
          return { valid: false, reason: "Server Error: Please try again later" };
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
}

// ===== API FUNCTIONS =====
async function fetchCurrentIssue(site) {
  const config = SITE_CONFIGS[site];
  try {
    const res = await axiosInstance.post(
      config.issueUrl,
      {
        ...config.issueParams,
        timestamp: Math.floor(Date.now() / 1000)
      }, 
      { 
        headers: { 
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
        },
        timeout: 10000 
      }
    );
    return res.data;
  } catch (err) { 
    console.error(`❌ Error fetching ${site} issue:`, err.message); 
    return null; 
  }
}

async function fetchLastResults(site) {
  const config = SITE_CONFIGS[site];
  try {
    const res = await axiosInstance.post(
      config.resultsUrl,
      {
        ...config.resultsParams,
        timestamp: Math.floor(Date.now() / 1000)
      }, 
      { 
        headers: { 
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
        },
        timeout: 10000 
      }
    );

    if (!res.data?.data?.list) return [];
    
    return res.data.data.list.map(r => {
      const num = parseInt(r.result || r.number);
      if (isNaN(num)) return { result: "UNKNOWN", issueNumber: r.issue || r.issueNumber || "UNKNOWN" };
      return { 
        result: num <= 4 ? "SMALL" : "BIG", 
        issueNumber: r.issue || r.issueNumber || "UNKNOWN",
        actualNumber: num
      };
    }).filter(r => r.result !== "UNKNOWN");
  } catch (err) { 
    console.error(`❌ Error fetching ${site} results:`, err.message); 
    return []; 
  }
}

// ===== STRATEGIES =====
function countStrategy(results) {
  let bigCount = 0;
  let smallCount = 0;
  
  results.forEach(r => {
    if (r === "BIG") bigCount++;
    if (r === "SMALL") smallCount++;
  });
  
  const difference = Math.abs(bigCount - smallCount);
  
  if (difference >= 1 && difference <= 5) {
    return { prediction: "SMALL", formulaName: "KoZaw's Strategy", confidence: "Medium", calculation: `${bigCount}B-${smallCount}S=${difference} Small` };
  } else if (difference >= 6 || difference === 0) {
    return { prediction: "BIG", formulaName: "KoZaw's Strategy", confidence: "Medium", calculation: `${bigCount}B-${smallCount}S=${difference} Big` };
  }
  
  return null;
}

// ===== WIN/LOSE TRACKING =====
function updateUserStats(chatId, prediction, actualResult, site) {
  if (!userStats.has(chatId)) {
    userStats.set(chatId, { 
      [SITE_CONFIGS.BIGWIN.name]: { wins: 0, losses: 0, streak: 0, maxStreak: 0 },
      [SITE_CONFIGS.CKLOTTERY.name]: { wins: 0, losses: 0, streak: 0, maxStreak: 0 },
      [SITE_CONFIGS['6LOTTERY'].name]: { wins: 0, losses: 0, streak: 0, maxStreak: 0 }
    });
  }
  
  const userStatsObj = userStats.get(chatId);
  
  if (!userStatsObj[site]) {
    userStatsObj[site] = { wins: 0, losses: 0, streak: 0, maxStreak: 0 };
  }
  
  const stats = userStatsObj[site];
  if (prediction === actualResult) { 
    stats.wins++; 
    stats.streak++; 
    if (stats.streak > stats.maxStreak) stats.maxStreak = stats.streak; 
    
    // Reset reverse prediction mode after a win
    if (reversePredictionMode.has(chatId)) {
      reversePredictionMode.delete(chatId);
    }
    
    return "WIN"; 
  } else { 
    stats.losses++; 
    stats.streak = 0; 
    
    // Enable reverse prediction mode after a loss (only if not already in reverse mode)
    if (!reversePredictionMode.has(chatId)) {
      reversePredictionMode.set(chatId, true);
    } else {
      // If already in reverse mode and loses again, disable reverse mode
      reversePredictionMode.delete(chatId);
    }
    
    return "LOSE"; 
  }
}

function getUserStats(chatId, site) {
  if (!userStats.has(chatId)) {
    return { wins: 0, losses: 0, streak: 0, maxStreak: 0 };
  }
  
  const userStatsObj = userStats.get(chatId);
  
  if (!userStatsObj[site]) {
    userStatsObj[site] = { wins: 0, losses: 0, streak: 0, maxStreak: 0 };
  }
  
  const stats = userStatsObj[site];
  return { ...stats };
}

// ===== PREDICTION SYSTEM =====
async function getPredictionForUser(chatId, site) {
  const results = (await fetchLastResults(site)).map(r => r.result);
  if (!results.length) return { prediction: "UNKNOWN" };
  
  const strategy = countStrategy(results);
  if (strategy) {
    // Check if we should reverse the prediction due to previous loss
    if (reversePredictionMode.has(chatId)) {
      const reversedPrediction = strategy.prediction === "BIG" ? "SMALL" : "BIG";
      
      return {
        prediction: reversedPrediction,
        formulaName: "Reverse Strategy (After Loss)",
        confidence: "Medium",
        calculation: `Reversed: ${strategy.prediction} → ${reversedPrediction}`
      };
    }
    return strategy;
  }
  
  // Default prediction
  return { prediction: "BIG", formulaName: "KoZaw's Strategy", confidence: "Low", calculation: "No clear pattern detected" };
}

async function getPredictionMessage(chatId, site) {
  const issue = await fetchCurrentIssue(site);
  const period = issue?.data?.issueNumber || "Unknown";
  const now = new Date(); 
  const clock = now.toLocaleTimeString('en-US', { hour12: true });
  const result = await getPredictionForUser(chatId, site);
  
  let message = `🎰 *${site} Predictor Pro*\n📅 Period: \`${period}\`\n🕒 ${clock}\n\n`;
  
  if (result.prediction !== "UNKNOWN") {
    message += `🔮 *Prediction: ${result.prediction}*\n📊 Confidence: ${result.confidence}\n🧠 Strategy: ${result.formulaName}\n\n`;
    message += `⚠️ လိုက်ဆပြင်ဆင်ပြီးဆော့ပါ ဆတက်�နိုင်ပါတယ်\n\n`;
    message += `⚠️ အရင်းရဲ့ 20% နိုင်ရင်နားပါ`;
  } else {
    message += "⚠️ Unable to generate prediction right now.";
  }
  
  return message;
}

// ===== KEY DURATION FUNCTION =====
function getKeyDuration(chatId) {
  const expiry = keyExpiryTimers.get(chatId);
  if (!expiry) return "No active key";
  
  const remainingMs = expiry - Date.now();
  if (remainingMs <= 0) return "Key expired";
  
  const days = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
  
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ===== USER STATISTICS FUNCTION =====
function showUserStats() {
  console.log('\n===== USER STATISTICS =====');
  console.log(`Total users: ${users.size}`);
  console.log(`Verified users: ${verifiedUsers.size}`);
  console.log(`Active subscribers: ${Array.from(users.values()).filter(u => u.subscribed).length}`);
  console.log(`Users in reverse mode: ${reversePredictionMode.size}`);
  
  console.log('\nUser details:');
  users.forEach((user, chatId) => {
    const userName = userNames.get(chatId) || 'Unknown User';
    const status = verifiedUsers.has(chatId) ? '✅ Verified' : '❌ Unverified';
    const subscribed = user.subscribed ? '✅ Subscribed' : '❌ Not subscribed';
    const reverseMode = reversePredictionMode.has(chatId) ? '🔄 Reverse' : '➡️ Normal';
    console.log(`${userName}: ${status}, ${subscribed}, ${reverseMode}, Site: ${user.selectedSite}`);
  });
  
  console.log('==========================\n');
}

// ===== FEEDBACK SYSTEM =====
function saveFeedback(feedback) {
  feedbackData.push(feedback);
  
  try {
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbackData, null, 2));
    console.log('✅ Feedback saved successfully');
  } catch (err) {
    console.error('❌ Error saving feedback:', err.message);
  }
}

// ===== PREDICTION HISTORY SYSTEM =====
function addToPredictionHistory(chatId, predictionData) {
  if (!userPredictionHistory.has(chatId)) {
    userPredictionHistory.set(chatId, {
      BIGWIN: [],
      CKLOTTERY: [],
      '6LOTTERY': []
    });
  }
  
  const historyObj = userPredictionHistory.get(chatId);
  const siteHistory = historyObj[predictionData.site] || [];
  siteHistory.unshift(predictionData);
  
  if (siteHistory.length > 20) {
    siteHistory.pop();
  }
  
  historyObj[predictionData.site] = siteHistory;
  userPredictionHistory.set(chatId, historyObj);
}

function getLastPredictions(chatId, site, count = 20) {
  if (!userPredictionHistory.has(chatId)) {
    return [];
  }
  
  const historyObj = userPredictionHistory.get(chatId);
  const siteHistory = historyObj[site] || [];
  return siteHistory.slice(0, count);
}

// ===== TELEGRAM BOT =====
function getMainKeyboard(selectedSite) {
  if (selectedSite === "BIGWIN") {
    return {
      keyboard: [
        [{ text: "▶️ START" }, { text: "⏹️ STOP" }],
        [{ text: "🎲 CK LOTTERY" }, { text: "🎯 6 LOTTERY" }],
        [{ text: "⏰ KEY DURATION" }, { text: "🔑 KEYရယူရန်" }],
        [{ text: "📊 PREDICTION HISTORY" }, { text: "📝 FEEDBACK" }]
      ], 
      resize_keyboard: true
    };
  } else if (selectedSite === "CKLOTTERY") {
    return {
      keyboard: [
        [{ text: "▶️ START" }, { text: "⏹️ STOP" }],
        [{ text: "🎰 BIGWIN" }, { text: "🎯 6 LOTTERY" }],
        [{ text: "⏰ KEY DURATION" }, { text: "🔑 KEYရယူရန်" }],
        [{ text: "📊 PREDICTION HISTORY" }, { text: "📝 FEEDBACK" }]
      ], 
      resize_keyboard: true
    };
  } else {
    return {
      keyboard: [
        [{ text: "▶️ START" }, { text: "⏹️ STOP" }],
        [{ text: "🎰 BIGWIN" }, { text: "🎲 CK LOTTERY" }],
        [{ text: "⏰ KEY DURATION" }, { text: "🔑 KEYရယူရန်" }],
        [{ text: "📊 PREDICTION HISTORY" }, { text: "📝 FEEDBACK" }]
      ], 
      resize_keyboard: true
    };
  }
}

function getSiteSelectionKeyboard() {
  return {
    keyboard: [
      [{ text: "🎰 BIGWIN" }, { text: "🎲 CK LOTTERY" }, { text: "🎯 6 LOTTERY" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

// ===== KEY EXPIRY CHECK =====
function checkKeyExpiry() {
  const now = Date.now();
  
  for (const [chatId, expiry] of keyExpiryTimers.entries()) {
    if (now > expiry) {
      if (verifiedUsers.has(chatId)) {
        verifiedUsers.delete(chatId);
        awaitingKeyRenewal.add(chatId);
        
        // Clear reverse prediction mode when key expires
        if (reversePredictionMode.has(chatId)) {
          reversePredictionMode.delete(chatId);
        }
        
        try {
          bot.sendMessage(chatId, "⛔ KEY IS EXPIRED. Please enter a new key to continue.", {
            reply_markup: { remove_keyboard: true }
          });
        } catch (err) {
          const userName = userNames.get(chatId) || 'Unknown User';
          console.error(`Error sending expiry message to ${userName}:`, err.message);
        }
      }
    }
  }
}

// ===== BOT COMMANDS =====
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || msg.from.username || 'Unknown User';
  userNames.set(chatId, userName);
  
  console.log(`🚀 /start command from user: ${userName}`);
  
  if (verifiedUsers.has(chatId)) {
    const expiry = keyExpiryTimers.get(chatId);
    if (expiry) {
      const remainingSec = Math.floor((expiry - Date.now()) / 1000);
      if (remainingSec > 0) {
        const user = users.get(chatId) || { selectedSite: "BIGWIN" };
        bot.sendMessage(chatId, `🎁 Your key is valid for another ${remainingSec} seconds.\nPredictions will start soon.`, { 
          reply_markup: getMainKeyboard(user.selectedSite) 
        });
      } else {
        verifiedUsers.delete(chatId);
        awaitingKeyRenewal.add(chatId);
        bot.sendMessage(chatId, "⛔ Your key has expired! Please enter your *new access key* to continue:", { 
          parse_mode: "Markdown" 
        });
      }
    }
  } else {
    bot.sendMessage(chatId, "🔑 Please enter your *access key* to activate:", { 
      parse_mode: "Markdown" 
    });
  }
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = userNames.get(chatId) || 'Unknown User';
  console.log(`⏹️ /stop command from user: ${userName}`);
  
  if (users.has(chatId)) {
    const user = users.get(chatId);
    user.subscribed = false;
    users.set(chatId, user);
  } else {
    users.set(chatId, { subscribed: false, selectedSite: "BIGWIN" });
  }
  
  bot.sendMessage(chatId, "🛑 Stopped predictions. Use /start or the START button to begin again.", {
    reply_markup: { remove_keyboard: true }
  });
});

bot.onText(/\/feedback/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = userNames.get(chatId) || 'Unknown User';
  console.log(`📝 Feedback request from user: ${userName}`);
  
  awaitingFeedback.add(chatId);
  bot.sendMessage(chatId, "📝 Feedbackလေးရေးသွားလို့ရပါတယ်ဗျ");
});

bot.onText(/\/history/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = userNames.get(chatId) || 'Unknown User';
  console.log(`📊 History request from user: ${userName}`);
  
  if (!verifiedUsers.has(chatId)) {
    bot.sendMessage(chatId, "🔒 Please activate your key first using /start");
    return;
  }
  
  const user = users.get(chatId) || { selectedSite: "BIGWIN" };
  const predictions = getLastPredictions(chatId, user.selectedSite, 20);
  
  if (predictions.length === 0) {
    bot.sendMessage(chatId, "📊 No prediction history available yet.", {
      reply_markup: getMainKeyboard(user.selectedSite)
    });
    return;
  }
  
  let message = `📊 *Last ${predictions.length} Predictions for ${SITE_CONFIGS[user.selectedSite].name}*\n\n`;
  
  predictions.forEach((pred, index) => {
    const outcome = pred.outcome ? (pred.outcome === "WIN" ? "✅" : "❌") : "⏳";
    message += `${index + 1}. Period: ${pred.issueNumber} - ${outcome}\n`;
  });
  
  bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: getMainKeyboard(user.selectedSite)
  });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id; 
  const text = msg.text?.trim() || '';
  const userName = msg.from.first_name || msg.from.username || 'Unknown User';
  
  userNames.set(chatId, userName);
  
  if (text.startsWith('/') || !text) return;
  
  console.log(`📩 Message from ${userName}: ${text}`);

  if (awaitingFeedback.has(chatId)) {
    awaitingFeedback.delete(chatId);
    
    const feedback = {
      userId: chatId,
      userName: userName,
      message: text,
      timestamp: new Date().toISOString()
    };
    
    saveFeedback(feedback);
    console.log(`📝 Feedback from ${userName}: ${text}`);
    
    bot.sendMessage(chatId, "ကျေးဇူးတင်ပါသည် 🙏", {
      reply_markup: getMainKeyboard(users.get(chatId)?.selectedSite || "BIGWIN")
    });
    return;
  }

  if (text === "🎰 BIGWIN" || text === "🎲 CK LOTTERY" || text === "🎯 6 LOTTERY") {
    let selectedSite;
    if (text === "🎰 BIGWIN") selectedSite = "BIGWIN";
    else if (text === "🎲 CK LOTTERY") selectedSite = "CKLOTTERY";
    else selectedSite = "6LOTTERY";
    
    if (!users.has(chatId)) {
      users.set(chatId, { subscribed: false, selectedSite });
    } else {
      const user = users.get(chatId);
      user.selectedSite = selectedSite;
      users.set(chatId, user);
    }
    
    bot.sendMessage(chatId, `✅ Selected: ${SITE_CONFIGS[selectedSite].name}`, {
      reply_markup: getMainKeyboard(selectedSite)
    });
    return;
  }

  if (awaitingKeyRenewal.has(chatId) || !verifiedUsers.has(chatId)) {
    const checkingMsg = await bot.sendMessage(chatId, "🔑 Key မှန်မမှန်စစ်နေပါသည် ခဏစောင့်ပါ......");
    
    const result = await checkKeyValidity(text, chatId);
    
    try {
      await bot.deleteMessage(chatId, checkingMsg.message_id);
    } catch (err) {
      console.error("Error deleting checking message:", err.message);
    }
    
    if (result.valid) {
      verifiedUsers.add(chatId);
      awaitingKeyRenewal.delete(chatId);
      
      if (!users.has(chatId)) {
        users.set(chatId, { subscribed: true, selectedSite: "BIGWIN" });
      } else {
        const user = users.get(chatId);
        user.subscribed = true;
        users.set(chatId, user);
      }
      
      const expiry = keyExpiryTimers.get(chatId);
      const remainingSec = Math.floor((expiry - Date.now()) / 1000);
      
      bot.sendMessage(chatId, `✅ Key Activated!\n⏳ Valid for another ${remainingSec} seconds.\n\nPlease select your prediction site:`, { 
        reply_markup: getSiteSelectionKeyboard() 
      });
    } else {
      bot.sendMessage(chatId, `❌ Access Denied: ${result.reason}\n\nEnter a valid key or contact @leostrike223 for assistance:`);
    }
    return;
  }

  const user = users.get(chatId) || { selectedSite: "BIGWIN" };
  const selectedSite = user.selectedSite;

  if (text.toUpperCase().includes('START')) {
    user.subscribed = true;
    users.set(chatId, user);
    bot.sendMessage(chatId, `✅ Subscribed to ${SITE_CONFIGS[selectedSite].name} live predictions.`, { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text.toUpperCase().includes('STOP')) {
    user.subscribed = false;
    users.set(chatId, user);
    bot.sendMessage(chatId, "🛑 Stopped predictions. Use START button to begin again.", { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text.toUpperCase().includes('KEY DURATION') || text.toUpperCase().includes('DURATION')) { 
    const duration = getKeyDuration(chatId);
    bot.sendMessage(chatId, `⏰ Key Duration: ${duration}`, { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }
  
  if (text.toUpperCase().includes('KEYရယူရန်') || text.toUpperCase().includes('KEY')) {
    bot.sendMessage(chatId, "👤 Developer: @leostrike223", { 
      reply_markup: getMainKeyboard(selectedSite) 
    }); 
    return;
  }

  if (text.toUpperCase().includes('FEEDBACK')) {
    awaitingFeedback.add(chatId);
    bot.sendMessage(chatId, "📝 Feedbackလေးရေးသွားလို့ရပါတယ်ဗျ");
    return;
  }

  if (text.toUpperCase().includes('PREDICTION HISTORY') || text.toUpperCase().includes('HISTORY')) {
    if (!verifiedUsers.has(chatId)) {
      bot.sendMessage(chatId, "🔒 Please activate your key first using /start");
      return;
    }
    
    const predictions = getLastPredictions(chatId, selectedSite, 20);
    
    if (predictions.length === 0) {
      bot.sendMessage(chatId, "📊 No prediction history available yet.", {
        reply_markup: getMainKeyboard(selectedSite)
      });
      return;
    }
    
    let message = `📊 *Last ${predictions.length} Predictions for ${SITE_CONFIGS[selectedSite].name}*\n\n`;
    
    predictions.forEach((pred, index) => {
      const outcome = pred.outcome ? (pred.outcome === "WIN" ? "✅" : "❌") : "⏳";
      message += `${index + 1}. Period: ${pred.issueNumber} - ${outcome}\n`;
    });
    
    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: getMainKeyboard(selectedSite)
    });
    return;
  }

  if (text.includes("BIGWIN") || text.includes("CK LOTTERY") || text.includes("6 LOTTERY")) {
    let newSite;
    if (text.includes("BIGWIN")) newSite = "BIGWIN";
    else if (text.includes("CK LOTTERY")) newSite = "CKLOTTERY";
    else newSite = "6LOTTERY";
    
    user.selectedSite = newSite;
    users.set(chatId, user);
    
    bot.sendMessage(chatId, `✅ Switched to ${SITE_CONFIGS[newSite].name} predictions`, { 
      reply_markup: getMainKeyboard(newSite) 
    });
    return;
  }

  const expiry = keyExpiryTimers.get(chatId);
  if (!expiry || Date.now() > expiry) {
    verifiedUsers.delete(chatId);
    awaitingKeyRenewal.add(chatId);
    bot.sendMessage(chatId, "⛔ KEY IS EXPIRED. Please enter your *new access key* to continue:", { 
      parse_mode: "Markdown",
      reply_markup: { remove_keyboard: true }
    });
    return;
  }

  const message = await getPredictionMessage(chatId, selectedSite);
  bot.sendMessage(chatId, message, { 
    parse_mode: 'Markdown', 
    reply_markup: getMainKeyboard(selectedSite) 
  });
});

// ===== BROADCAST LOOP =====
async function broadcastPrediction() {
  console.log("🔔 Starting prediction broadcast cycle");
  
  try {
    for (const [chatId, user] of users.entries()) {
      if (user.subscribed && verifiedUsers.has(chatId)) {
        const expiry = keyExpiryTimers.get(chatId);
        if (!expiry || Date.now() > expiry) {
          verifiedUsers.delete(chatId);
          awaitingKeyRenewal.add(chatId);
          bot.sendMessage(chatId, "⛔ KEY IS EXPIRED. Please enter your *new access key* to continue:", { 
            parse_mode: "Markdown",
            reply_markup: { remove_keyboard: true }
          });
          continue;
        }

        try {
          const site = user.selectedSite;
          const currentResults = await fetchLastResults(site);
          if (!currentResults.length) {
            console.log(`⚠️ No ${site} results available for prediction`);
            continue;
          }
          
          const latestResult = currentResults[0];
          const userName = userNames.get(chatId) || 'Unknown User';
          console.log(`📊 ${site} Latest result for ${userName}: ${latestResult.result} (${latestResult.actualNumber}) for issue ${latestResult.issueNumber}`);

          if (predictionHistory.has(chatId)) {
            const lastPrediction = predictionHistory.get(chatId);
            
            if (lastPrediction.site === site) {
              const matchingResult = currentResults.find(r => r.issueNumber === lastPrediction.issueNumber);
              
              if (matchingResult) {
                const outcome = updateUserStats(chatId, lastPrediction.prediction, matchingResult.result, site);
                
                const historyPrediction = {
                  prediction: lastPrediction.prediction,
                  issueNumber: lastPrediction.issueNumber,
                  timestamp: lastPrediction.timestamp,
                  outcome: outcome,
                  actualResult: matchingResult.result,
                  site: site
                };
                
                addToPredictionHistory(chatId, historyPrediction);
                
                let resultMessage = `🎯 *${site} Result*\n`;
                resultMessage += `📅 Period: \`${matchingResult.issueNumber}\`\n`;
                resultMessage += `🔮 Last Prediction: ${lastPrediction.prediction}\n`;
                resultMessage += `🎲 Actual Result: ${matchingResult.result}\n`;
                resultMessage += `📊 Outcome: ${outcome === "WIN" ? "✅ WIN" : "❌ LOSE"}`;
                
                bot.sendMessage(chatId, resultMessage, { 
                  parse_mode: 'Markdown',
                  reply_markup: getMainKeyboard(site)
                });
                
                predictionHistory.delete(chatId);
              }
            }
          }
          
          const issue = await fetchCurrentIssue(site);
          if (!issue?.data?.issueNumber) {
            console.log(`⚠️ No ${site} issue data available`);
            continue;
          }
          
          const prediction = await getPredictionForUser(chatId, site);
          if (prediction.prediction === "UNKNOWN") {
            console.log(`⚠️ Could not generate ${site} prediction for ${userName}`);
            continue;
          }
          
          const now = new Date();
          const clock = now.toLocaleTimeString('en-US', { hour12: true });
          
          let message = `🎰 *${site} Predictor Pro*\n`;
          message += `📅 Period: \`${issue.data.issueNumber}\`\n`;
          message += `🕒 ${clock}\n\n`;
          message += `🔮 *Prediction: ${prediction.prediction}*\n`;
          message += `📊 Confidence: ${prediction.confidence}\n`;
          message += `🧠 Strategy: ${prediction.formulaName}\n\n`;
          message += `⚠️ လိုက်ဆပြင်ဆင်ပြီးဆော့ပါ ဆတက်�နိုင်ပါတယ်\n\n`;
          message += `⚠️ အရင်းရဲ့ 20% နိုင်ရင်နားပါ`;
          
          const sentMessage = await bot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            reply_markup: getMainKeyboard(site)
          });
          
          predictionHistory.set(chatId, {
            prediction: prediction.prediction,
            issueNumber: issue.data.issueNumber,
            timestamp: now,
            site: site
          });
          
          console.log(`✅ ${site} Prediction sent to ${userName}: ${prediction.prediction} (${prediction.formulaName})`);
          
        } catch (err) {
          const userName = userNames.get(chatId) || 'Unknown User';
          console.error(`❌ Error sending prediction to ${userName}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error("❌ Broadcast error:", err.message);
  }
  
  console.log("✅ Prediction broadcast cycle completed");
}

// ===== MAIN LOOP =====
setInterval(broadcastPrediction, SLOT_SECONDS * 1000);
setInterval(checkKeyExpiry, 60000); // Check key expiry every minute
setInterval(showUserStats, 300000); // Show user stats every 5 minutes

console.log("🤖 Bot is running...");
console.log("📊 User statistics will be displayed every 5 minutes");
console.log("🔄 Reverse prediction mode is ACTIVE - will reverse predictions after a loss");
console.log("🔄 If reverse mode loses again, it will return to normal mode");
