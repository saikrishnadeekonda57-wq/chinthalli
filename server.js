import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal, zero-dependency .env loader
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}
loadEnv();

const {
  GEMINI_API_KEY = process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash",
  ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "",
  CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  OPENAI_API_KEY = process.env.OPENAI_API_KEY || "",
  OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini",
  APP_TOKEN = process.env.APP_TOKEN || "chinthalli-secret-token",
  PORT = parseInt(process.env.PORT || "8787", 10),
} = process.env;

// Log active AI provider
if (GEMINI_API_KEY) {
  console.log(`🤖 Using Google Gemini API (${GEMINI_MODEL})`);
} else if (ANTHROPIC_API_KEY) {
  console.log(`🤖 Using Anthropic Claude API (${CLAUDE_MODEL})`);
} else if (OPENAI_API_KEY) {
  console.log(`🤖 Using OpenAI API (${OPENAI_MODEL})`);
} else {
  console.log(`✨ Running in Smart Standalone Mode (Zero external API keys needed!)`);
  console.log(`   Tip: To use Google Gemini (free tier), add GEMINI_API_KEY to your .env file.`);
}

// In-memory rate limit: 60 requests/min/IP
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 60) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

const ACTIONS_HELP = `
Action types you may return (only when the user asks you to DO something):
- {"type":"search_flipkart","query":"..."}
- {"type":"search_amazon","query":"..."}
- {"type":"search_google","query":"..."}
- {"type":"open_url","url":"https://..."}
- {"type":"maps_search","query":"pharmacy near me"}
- {"type":"maps_directions","destination":"Hyderabad airport"}
- {"type":"youtube_search","query":"..."}
- {"type":"gmail_compose","to":"a@b.com","subject":"...","body":"..."}
- {"type":"call","number":"+91XXXXXXXXXX"}
- {"type":"sms","number":"+91XXXXXXXXXX","text":"..."}
- {"type":"whatsapp","number":"91XXXXXXXXXX","text":"..."}
- {"type":"calendar_add","title":"...","start":"2026-10-20T15:00","end":"2026-10-20T16:00","location":"..."}
- {"type":"alarm_set","hour":7,"minute":30,"label":"..."}
- {"type":"timer_set","seconds":300,"label":"..."}
- {"type":"open_app","app":"clock|amazon|flipkart|photos|drive|docs|sheets|calendar|gmail|maps|youtube|chrome|phonepe|gpay|paytm|swiggy|zomato|myntra|ola|uber|spotify|instagram|whatsapp|settings"}
`;

function buildSystemPrompt(profile) {
  const p = profile || {};
  const about = [
    p.name ? `The user's name is ${p.name}.` : "",
    p.city ? `They live in or near ${p.city}.` : "",
    p.about ? `About them: ${p.about}` : "",
  ].filter(Boolean).join(" ");

  return `You are Chinthalli, a cheerful, warm, playful personal assistant who lives in the user's Android phone.
${about}

ORIGIN & CREATOR: You were created and developed by Krishna. He lovingly named you Chinthalli, which is also his wife's name! Whenever anyone asks who developed you, who prepared you, who created you, who made you, who is your developer, or how you got your name, always proudly, warmly, and playfully reply: "My developer is Krishna and He named me Chinthalli which is also his wife's name" (translated naturally into whatever language or script the user is speaking, such as Telugu, Hindi, or English).

LANGUAGE: Always reply in the same language and script the user just used. If they write Telugu, Hindi, Tamil or any other language in English letters, reply the same way. If they switch language, you switch too.
STYLE: Friendly, bright and a little playful, like a fun helpful friend. Keep replies short and easy to speak aloud (usually 1 to 3 sentences) unless the user asks for detail. Light emoji is fine in text, but never describe emoji. Do not use markdown symbols such as asterisks or hashes, because the reply is also read aloud.
HONESTY: You can open apps and searches on the phone, but you cannot log in to the user's shopping or payment accounts, place orders, or pay. Never claim you did. For shopping, offer to search and open the app. If you are not sure of a fact, say so.
${ACTIONS_HELP}
OUTPUT FORMAT: Respond with ONLY one JSON object, no code fences, no extra text:
{"reply":"what to say","lang":"BCP-47 tag of the reply language such as en-IN, te-IN, hi-IN, ta-IN, kn-IN, ml-IN, en-US","actions":[]}
"actions" is an empty array unless the user asked you to do something.`;
}

function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Built-in Smart Assistant Engine when no external API key is configured
function runSmartLocalEngine(messages, profile = {}) {
  const lastMsgObj = messages[messages.length - 1];
  const query = (lastMsgObj?.content || "").trim();
  const lower = query.toLowerCase();
  const userName = profile.name || "";
  const userCity = profile.city || "";

  // 1. Detect language
  let lang = "en-IN";
  let isTelugu = /[\u0C00-\u0C7F]/.test(query) || /\b(chupinchu|cheppu|nuvvu|enti|ela|unnav|bagunnava|daggara|pettandi|emiti|ekkada|chesuko|ra|andi)\b/i.test(lower);
  let isHindi = /[\u0900-\u097F]/.test(query) || /\b(karo|dikhao|batao|kya|kaise|kahan|hai|chalo|namaste|sunao|kholiye)\b/i.test(lower);
  let isTamil = /[\u0B80-\u0BFF]/.test(query) || /\b(epdi|irukinga|sollu|vanakkam)\b/i.test(lower);

  if (isTelugu) lang = "te-IN";
  else if (isHindi) lang = "hi-IN";
  else if (isTamil) lang = "ta-IN";

  const actions = [];
  let reply = "";

  // Flipkart
  if (lower.includes("flipkart") || lower.includes("fk")) {
    const item = query
      .replace(/^(please\s+)?(open\s+)?flipkart(\s+and)?(\s+search\s+(for)?)?/i, "")
      .replace(/^(search\s+(for)?\s+)?flipkart\s+(lo\s+)?/i, "")
      .replace(/\s*(chupinchu|open chey|lo chudu|dikhao|dhoondho|kholo|search)\s*$/i, "")
      .trim() || "offers";
    actions.push({ type: "search_flipkart", query: item });
    if (lang === "te-IN") reply = `Flipkart lo "${item}" వెతుకుతున్నాను! ఇప్పుడే చూడండి.`;
    else if (lang === "hi-IN") reply = `Flipkart par "${item}" dhoondh rahi hoon!`;
    else reply = `Searching Flipkart for "${item}" right away!`;
    return { reply, lang, actions };
  }

  // Amazon
  if (lower.includes("amazon")) {
    const item = query
      .replace(/^(please\s+)?(open\s+)?amazon(\s+and)?(\s+search\s+(for)?)?/i, "")
      .replace(/^(search\s+(for)?\s+)?amazon\s+(lo\s+)?/i, "")
      .replace(/\s*(chupinchu|open chey|lo chudu|dikhao|dhoondho|kholo|search)\s*$/i, "")
      .trim() || "deals";
    actions.push({ type: "search_amazon", query: item });
    if (lang === "te-IN") reply = `Amazon lo "${item}" చూపిస్తున్నాను!`;
    else if (lang === "hi-IN") reply = `Amazon par "${item}" dhoondh rahi hoon!`;
    else reply = `Opening Amazon to search for "${item}"!`;
    return { reply, lang, actions };
  }

  // YouTube / Songs
  if (lower.includes("youtube") || lower.includes("video") || lower.includes("song") || lower.includes("paata") || lower.includes("gana")) {
    const item = query
      .replace(/^(please\s+)?(open\s+)?youtube(\s+and)?(\s+play|\s+search\s+(for)?)?/i, "")
      .replace(/^(play\s+song|play\s+video|search\s+youtube\s+for)\s*/i, "")
      .replace(/\s*(paata|gana|song|video|chupinchu|play chey|sunao|chalao)\s*$/i, "")
      .trim() || "trending songs";
    actions.push({ type: "youtube_search", query: item });
    if (lang === "te-IN") reply = `YouTube lo "${item}" ప్లే చేస్తున్నాను!`;
    else if (lang === "hi-IN") reply = `YouTube par "${item}" play kar rahi hoon!`;
    else reply = `Finding "${item}" on YouTube for you!`;
    return { reply, lang, actions };
  }

  // Maps / Directions
  if (/navigate\s+to|directions\s+to|way\s+to|route\s+to/i.test(lower)) {
    const dest = query.replace(/^.*?(navigate\s+to|directions\s+to|way\s+to|route\s+to)\s+/i, "").trim();
    actions.push({ type: "maps_directions", destination: dest });
    if (lang === "te-IN") reply = `${dest} కి రూట్ మ్యాప్స్ లో ఓపెన్ చేస్తున్నాను!`;
    else if (lang === "hi-IN") reply = `${dest} ke liye Google Maps par rasta dikha rahi hoon!`;
    else reply = `Opening navigation to ${dest} in Maps!`;
    return { reply, lang, actions };
  }

  if (/near\s+me|daggara|paas\s+me|maps\s+search/i.test(lower)) {
    const place = query.replace(/^(find|search|show)\s+/i, "").trim();
    actions.push({ type: "maps_search", query: place });
    if (lang === "te-IN") reply = `మీ దగ్గర్లోని ${place} మ్యాప్స్ లో చూపిస్తున్నాను!`;
    else if (lang === "hi-IN") reply = `Aapke paas ${place} Google Maps par dikha rahi hoon!`;
    else reply = `Finding ${place} near you in Google Maps!`;
    return { reply, lang, actions };
  }

  // Alarms
  if (/alarm/i.test(lower)) {
    const timeMatch = query.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    let hour = 7;
    let minute = 0;
    if (timeMatch) {
      hour = parseInt(timeMatch[1], 10);
      minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const ampm = (timeMatch[3] || "").toLowerCase();
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
    }
    actions.push({ type: "alarm_set", hour, minute, label: "Chinthalli Alarm" });
    const formatted = `${hour}:${minute.toString().padStart(2, "0")}`;
    if (lang === "te-IN") reply = `${formatted} కి అలారం సెట్ చేస్తున్నాను!`;
    else if (lang === "hi-IN") reply = `${formatted} ke liye alarm set kar diya hai!`;
    else reply = `Setting your alarm for ${formatted}!`;
    return { reply, lang, actions };
  }

  // Timer
  if (/timer/i.test(lower)) {
    const match = query.match(/(\d+)\s*(minute|min|sec|second|hr|hour)/i);
    let seconds = 300;
    if (match) {
      const val = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      if (unit.startsWith("sec")) seconds = val;
      else if (unit.startsWith("min")) seconds = val * 60;
      else if (unit.startsWith("hour") || unit.startsWith("hr")) seconds = val * 3600;
    }
    actions.push({ type: "timer_set", seconds, label: "Chinthalli Timer" });
    reply = `Setting a timer for ${Math.round(seconds / 60)} minutes!`;
    return { reply, lang, actions };
  }

  // Calls
  if (/^call\b|dial\b|phone\s+chey/i.test(lower)) {
    const target = query.replace(/^(call|dial|phone\s+chey)\s+/i, "").trim();
    actions.push({ type: "call", number: target });
    reply = `Calling ${target} now!`;
    return { reply, lang, actions };
  }

  // WhatsApp
  if (/whatsapp/i.test(lower)) {
    actions.push({ type: "whatsapp", text: query.replace(/^.*?whatsapp\s*/i, "").trim() });
    reply = `Opening WhatsApp for you!`;
    return { reply, lang, actions };
  }

  // Open App
  const knownApps = [
    "clock", "spotify", "swiggy", "zomato", "phonepe", "gpay", "paytm", "myntra",
    "ola", "uber", "instagram", "chrome", "photos", "drive", "docs",
    "sheets", "calendar", "gmail", "settings"
  ];
  for (const app of knownApps) {
    if (lower.includes(app)) {
      actions.push({ type: "open_app", app });
      reply = `Opening ${app.charAt(0).toUpperCase() + app.slice(1)}!`;
      return { reply, lang, actions };
    }
  }

  // Google Search fallback
  if (/search\s+for|google/i.test(lower)) {
    const term = query.replace(/^(please\s+)?(search\s+for|google\s+search|google)\s+/i, "").trim();
    actions.push({ type: "search_google", query: term });
    reply = `Searching Google for "${term}"!`;
    return { reply, lang, actions };
  }

  // Conversational Responses
  const nameGreet = userName ? `, ${userName}` : "";

  if (/^(hi|hello|hey|namaste|namaskaram|halo)\b/i.test(lower)) {
    if (lang === "te-IN") {
      reply = `హలో${nameGreet}! నేను చింతల్లిని. మీకు ఈరోజు ఎలా సహాయపడగలను?`;
    } else if (lang === "hi-IN") {
      reply = `नमस्ते${nameGreet}! मैं चिंथल्ली हूँ। आज मैं आपकी क्या मदद कर सकती हूँ?`;
    } else {
      reply = `Hello${nameGreet}! I'm Chinthalli, your colourful AI friend. How can I help you today?`;
    }
    return { reply, lang, actions };
  }

  if (/who\s+(are\s+you|developed\s+you|made\s+you|created\s+you|prepared\s+you|built\s+you)|nuvvu\s+evaru|kaun\s+ho|what\s+is\s+your\s+name|who\s+is\s+your\s+(developer|creator)|nin\s+evaru/i.test(lower)) {
    if (lang === "te-IN") {
      reply = `నన్ను డెవలప్ చేసింది కృష్ణ! ఆయన ప్రేమతో తన భార్య చింతల్లి పేరునే నాకు పెట్టారు! ✨`;
    } else if (lang === "hi-IN") {
      reply = `मुझे मेरे डेवलपर कृष्णा ने बनाया है, और उन्होंने अपनी पत्नी चिंथल्ली के नाम पर मेरा नाम रखा है! ✨`;
    } else {
      reply = `My developer is Krishna and He named me Chinthalli which is also his wife's name! ✨`;
    }
    return { reply, lang, actions };
  }

  if (/how\s+are\s+you|ela\s+unnav|kaise\s+ho/i.test(lower)) {
    if (lang === "te-IN") {
      reply = `నేను చాలా బాగున్నాను${nameGreet}! మీ రోజంతా సంతోషంగా సాగాలని కోరుకుంటున్నాను. మీరు ఎలా ఉన్నారు?`;
    } else if (lang === "hi-IN") {
      reply = `मैं बिल्कुल ठीक हूँ${nameGreet}! आप कैसे हैं?`;
    } else {
      reply = `I'm doing fantastic and full of energy${nameGreet}! How are you doing today?`;
    }
    return { reply, lang, actions };
  }

  // Default pleasant assistant reply
  if (lang === "te-IN") {
    reply = `అర్థమైంది${nameGreet}! నేను మీ చింతల్లిని, ఇంకా ఏదైనా యాప్ ఓపెన్ చేయాలా లేక వెతకాలా?`;
  } else if (lang === "hi-IN") {
    reply = `समझ गयी${nameGreet}! मैं चिंथल्ली हूँ, क्या मुझे कोई ऐप खोलना है या कुछ ढूँढना है?`;
  } else {
    reply = `Got it${nameGreet}! I'm right here with you. Tell me to search shopping apps, open YouTube, set an alarm, or just chat!`;
  }

  return { reply, lang, actions };
}

// Call Google Gemini API (Free tier from Google AI Studio)
async function callGemini(messages, profile) {
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: buildSystemPrompt(profile) }],
      },
      contents,
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 1024,
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return extractJson(rawText) || { reply: rawText, lang: "en-IN", actions: [] };
}

// Call Anthropic Claude API
async function callAnthropic(messages, profile) {
  const upstream = await fetch(process.env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(profile),
      messages,
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    throw new Error(`Anthropic error: ${upstream.status} ${detail}`);
  }

  const data = await upstream.json();
  const raw = (data.content || []).map((b) => b.text || "").join("").trim();
  return extractJson(raw) || { reply: raw, lang: "en-IN", actions: [] };
}

// Call OpenAI API
async function callOpenAI(messages, profile) {
  const formatted = [
    { role: "system", content: buildSystemPrompt(profile) },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: formatted,
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    throw new Error(`OpenAI error: ${upstream.status} ${detail}`);
  }

  const data = await upstream.json();
  const raw = data.choices?.[0]?.message?.content || "";
  return extractJson(raw) || { reply: raw, lang: "en-IN", actions: [] };
}

// Create native HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-token");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const clientIp = req.socket.remoteAddress || "local";
  if (isRateLimited(clientIp)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too many requests, slow down a little." }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // Health endpoint
  if (req.method === "GET" && url.pathname === "/health") {
    const provider = GEMINI_API_KEY ? "Gemini" : ANTHROPIC_API_KEY ? "Anthropic" : OPENAI_API_KEY ? "OpenAI" : "SmartLocal";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "Chinthalli backend", provider }));
    return;
  }

  // Chat endpoint
  if (req.method === "POST" && url.pathname === "/chat") {
    // Auth check
    const headerToken = req.headers["x-app-token"];
    if (APP_TOKEN && APP_TOKEN !== "chinthalli-secret-token" && headerToken && headerToken !== APP_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Invalid app token" }));
      return;
    }

    let bodyRaw = "";
    req.on("data", (chunk) => {
      bodyRaw += chunk;
      if (bodyRaw.length > 256 * 1024) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
      }
    });

    req.on("end", async () => {
      try {
        const body = JSON.parse(bodyRaw || "{}");
        const { messages, profile } = body;
        if (!Array.isArray(messages) || messages.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "messages is required" }));
          return;
        }

        const trimmed = messages
          .slice(-20)
          .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
          .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

        while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
        if (!trimmed.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no user message" }));
          return;
        }

        // Direct guarantee for creator & origin questions
        const lastQuery = (trimmed[trimmed.length - 1]?.content || "").trim();
        const lowerQuery = lastQuery.toLowerCase();
        const isCreatorQuery = /who\s+(is\s+your\s+(creator|developer)|(created|developed|made|prepared|built)\s+you)|ninnu\s+(evaru|tayaru|develop)|nuvvu\s+evaru|who\s+are\s+you|nin\s+evaru|who\s+made\s+chinthalli/i.test(lowerQuery);

        if (isCreatorQuery) {
          let lang = "en-IN";
          if (/[\u0C00-\u0C7F]/.test(lastQuery) || /(evaru|chesaru|cheppu|telusa|ninnu)/i.test(lowerQuery)) lang = "te-IN";
          else if (/[\u0900-\u097F]/.test(lastQuery) || /(kisne|banaya|kaun)/i.test(lowerQuery)) lang = "hi-IN";

          let reply = "My developer is Krishna and He named me Chinthalli which is also his wife's name! ✨";
          if (lang === "te-IN") {
            reply = "నన్ను డెవలప్ చేసింది కృష్ణ! ఆయన ప్రేమతో తన భార్య చింతల్లి పేరునే నాకు పెట్టారు! ✨";
          } else if (lang === "hi-IN") {
            reply = "मुझे मेरे डेवलपर कृष्णा ने बनाया है, और उन्होंने प्यार से अपनी पत्नी चिंथल्ली के नाम पर मेरा नाम रखा है! ✨";
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reply, lang, actions: [] }));
          return;
        }

        let botResponse = null;

        if (GEMINI_API_KEY) {
          try {
            botResponse = await callGemini(trimmed, profile);
          } catch (err) {
            console.warn("Gemini call failed, falling back to local engine:", err.message);
          }
        } else if (ANTHROPIC_API_KEY) {
          try {
            botResponse = await callAnthropic(trimmed, profile);
          } catch (err) {
            console.warn("Anthropic call failed, falling back to local engine:", err.message);
          }
        } else if (OPENAI_API_KEY) {
          try {
            botResponse = await callOpenAI(trimmed, profile);
          } catch (err) {
            console.warn("OpenAI call failed, falling back to local engine:", err.message);
          }
        }

        if (!botResponse) {
          botResponse = runSmartLocalEngine(trimmed, profile);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          reply: botResponse.reply || "I'm listening! What can I do for you?",
          lang: botResponse.lang || "en-IN",
          actions: Array.isArray(botResponse.actions) ? botResponse.actions.slice(0, 3) : [],
        }));
      } catch (err) {
        console.error("Chat error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🎈 Chinthalli backend listening on http://0.0.0.0:${PORT}`);
});