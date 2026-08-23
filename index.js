// ============================================================
//  KRIX – BACKGROUND VENOM (TERMUX CLI)
//  ✅ 401 MAC-OS BYPASS FIX + STABLE VERSION
// ============================================================

const crypto = require("crypto");
if (!global.crypto) global.crypto = crypto.webcrypto;

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const pino = require("pino");
const {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const MAX_RECONNECT_ATTEMPTS = 10;
const DR = DisconnectReason;

const logger = pino({ level: "fatal" });

["temp", "backups"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

const state = {
    client: null, number: null, authPath: null, connected: false,
    loggedOut: false, authRequired: false, reconnecting: false,
    stopReconnect: false, reconnectAttempts: 0, pairing: false,
    saveCreds: null, credsRegistered: false
};

let socketLockPromise = null;
let currentTask = null;

function normalizeNumber(input) {
    let number = (input || "").replace(/[^0-9]/g, "");
    if (number.startsWith("00")) number = number.slice(2);
    if (number.startsWith("0")) number = number.slice(1);
    if (number.length < 7 || number.length > 15) return null;
    return number;
}

function closeSocket(client = state.client, timeout = 2500) {
    return new Promise(resolve => {
        if (!client) return resolve();
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        try {
            client.ev.removeAllListeners("connection.update");
            client.ev.removeAllListeners("creds.update");
            client.ev.on("connection.update", u => { if (u.connection === "close") done(); });
            client.end();
        } catch (e) {}
        setTimeout(done, timeout);
    });
}

async function withSocketLock(fn) {
    while (socketLockPromise) {
        try { await socketLockPromise; } catch (e) {}
    }
    const p = (async () => fn())();
    socketLockPromise = p;
    try { return await p; } finally { if (socketLockPromise === p) socketLockPromise = null; }
}

// ============================================================
//  SOCKET CREATION (WITH MAC OS BYPASS)
// ============================================================

async function createSocket(number, authPath, qr = false) {
    const oldClient = state.client;
    if (oldClient) {
        state.client = null;
        await closeSocket(oldClient);
    }

    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    let authState, saveCreds;
    try {
        const loaded = await useMultiFileAuthState(authPath);
        authState = loaded.state;
        saveCreds = loaded.saveCreds;
    } catch (e) {
        state.authRequired = true;
        throw new Error(`AUTH_READ_FAILED`);
    }

    let version;
    try {
        ({ version } = await fetchLatestBaileysVersion());
    } catch (e) {
        // Fallback stable version to prevent 401
        version = [2, 3000, 1015901307];
    }

    const client = makeWASocket({
        version,
        auth: {
            creds: authState.creds,
            keys: makeCacheableSignalKeyStore(authState.keys, logger)
        },
        printQRInTerminal: qr,
        logger: logger,
        // 🔥 FIX: Apple Mac OS Safari signature is less flagged by WA Servers
        browser: ['Mac OS', 'Safari', '14.0.0'], 
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 25000,
        shouldIgnoreJid: jid => isJidBroadcast(jid),
        getMessage: async () => ({})
    });

    state.client = client;
    state.saveCreds = saveCreds;
    state.credsRegistered = !!(authState.creds && authState.creds.registered);

    return { client, state: authState, saveCreds };
}

function registerHandlers() {
    if (!state.client) return;
    let timeout;
    state.client.ev.on("creds.update", (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(async () => {
            try { await state.saveCreds(); } catch (e) {}
        }, 3000);
    });
    state.client.ev.on("connection.update", handleConnectionUpdate);
}

// ============================================================
//  CONNECTION HANDLING
// ============================================================

async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
        state.connected = true;
        state.reconnectAttempts = 0;
        state.authRequired = false;
        state.loggedOut = false;
        state.pairing = false;
        console.log("✅ WhatsApp Connected Successfully!");
        return;
    }

    if (connection === "close") {
        state.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        
        // Agar pairing ke dauran 401 aaye, toh yahan handle hoga
        if (state.pairing) {
            console.log(`⚠️ Socket dropped during pairing (Code: ${statusCode}). Retrying logic active...`);
            return;
        }
        
        if (state.stopReconnect) return;

        if (statusCode === 401 || statusCode === 403 || statusCode === 405) {
            state.loggedOut = true;
            state.authRequired = true;
            console.log("🔐 Session logged out/flagged. Please use Option 5 to clear session.");
            if (currentTask) currentTask.stopRequested = true;
            return;
        }

        attemptReconnect().catch(() => {});
    }
}

async function attemptReconnect() {
    if (state.pairing || state.stopReconnect || state.loggedOut || state.reconnecting) return;
    state.reconnecting = true;
    try {
        if (state.client) await closeSocket(state.client);
        
        state.reconnectAttempts++;
        if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) return;

        console.log(`🔄 Reconnecting...`);
        await delay(5000);
        if (state.stopReconnect || state.loggedOut || state.pairing) return;

        const socketData = await withSocketLock(() => createSocket(state.number, state.authPath));
        if (socketData) registerHandlers();
    } catch (e) {
    } finally {
        state.reconnecting = false;
    }
}

// ============================================================
//  MENU & PAIRING
// ============================================================

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question) { return new Promise(resolve => rl.question(question, resolve)); }

async function showMenu() {
    console.log("\n==============================");
    console.log("  KRIX – TERMUX MENU (MAC BYPASS)");
    console.log("==============================");
    console.log("1. Pair WhatsApp");
    console.log("2. Send Messages (Bulk)");
    console.log("3. Stop Task");
    console.log("4. Logout / Delete Session");
    console.log("5. Exit");
    console.log("==============================");
}

async function generatePairingCode() {
    const input = await ask("Enter WhatsApp number (e.g., 92300xxxxxxx): ");
    const number = normalizeNumber(input);
    if (!number) return console.log("❌ Invalid number.");

    const authPath = path.join("temp", `auth_${number}`);
    state.number = number;
    state.authPath = authPath;

    if (state.client && state.connected) return console.log("⚠️ Already connected!");

    console.log("🧹 Clearing old cache to prevent 401 error...");
    if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });

    try {
        const socketData = await withSocketLock(() => createSocket(number, authPath));
        if (!socketData) return;
        registerHandlers();
    } catch (err) {
        return console.error("❌ Setup failed.");
    }

    state.pairing = true;
    
    // 🔥 Socket ko pura properly open hone ka time (6 Seconds)
    console.log("⏳ Stabilizing Web-Socket connection (Wait 6s)...");
    await delay(6000);

    try {
        let codePromise = state.client.requestPairingCode(number);
        let timeoutPromise = new Promise((_, r) => setTimeout(() => r(new Error("Timeout")), 20000));
        let rawCode = await Promise.race([codePromise, timeoutPromise]);
        
        const code = rawCode?.match(/.{1,4}/g)?.join("-") || rawCode;
        console.log("\n==============================================");
        console.log(`🔐 PAIRING CODE: ${code}`);
        console.log("==============================================");
        console.log("Enter code in WhatsApp Linked Devices.");

        // Wait for connection to succeed
        await new Promise((resolve, reject) => {
            const onUpdate = (update) => {
                if (update.connection === "open") {
                    state.client.ev.removeListener("connection.update", onUpdate);
                    resolve();
                } else if (update.connection === "close") {
                    state.client.ev.removeListener("connection.update", onUpdate);
                    reject(new Error("Socket dropped (401/408). Server rejected pairing."));
                }
            };
            state.client.ev.on("connection.update", onUpdate);
            // 90 second timeout for user to enter code
            setTimeout(() => reject(new Error("Time limit exceeded.")), 90000); 
        });

    } catch (err) {
        if (err.message.includes("429")) {
            console.log("🚨 RATE LIMIT: WhatsApp ne temporary block kiya hai. 20-30 min ruko.");
        } else {
            console.log(`❌ Pairing Failed: ${err.message}`);
            console.log("💡 Tip: Try again after 5-10 minutes. WhatsApp anti-bot system is active.");
        }
    } finally {
        state.pairing = false;
    }
}

// ============================================================
//  SEND MESSAGES (ROCK SOLID)
// ============================================================

async function runSendLoop(task) {
    const { messages, jid, delaySec, prefix } = task;

    while (task.isRunning && !task.stopRequested) {
        if (state.authRequired || state.loggedOut || !state.connected) {
            console.log("⏸ Connection issue. Waiting 5s...");
            await delay(5000);
            continue;
        }

        const msg = prefix ? `${prefix.trim()} ${messages[task.index]}` : messages[task.index];

        try {
            await state.client.sendMessage(jid, { text: msg });
            task.sent++;
            console.log(`✅ Sent #${task.sent}: ${msg.substring(0, 20)}...`);
            task.index = (task.index + 1) % messages.length;
            await delay(delaySec * 1000);
        } catch (err) {
            console.error(`❌ Send failed:`, err.message);
            await delay(delaySec * 1000);
        }
    }
    task.isRunning = false;
    console.log(`🏁 Task finished/stopped. Total sent: ${task.sent}`);
}

async function sendMessages() {
    if (!state.client || !state.connected) return console.log("❌ Not connected.");
    if (currentTask && currentTask.isRunning) return console.log("⚠️ Task already running.");

    const rawTarget = await ask("Target (Number or Group ID): ");
    const filePath = await ask("Message File Path: ");
    const prefix = await ask("Prefix / Hater Name [Enter to skip]: ");
    const delaySec = parseInt(await ask("Delay in seconds [Default 10]: ")) || 10;

    if (!fs.existsSync(filePath)) return console.log("❌ File not found.");
    
    const messages = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (!messages.length) return console.log("❌ File empty.");

    let jid = rawTarget.replace(/[^0-9-]/g, "");
    if (jid.includes("-") || jid.length > 15) {
        jid = jid.includes("@g.us") ? jid : `${jid}@g.us`;
    } else {
        jid = jid.includes("@s.whatsapp.net") ? jid : `${jid}@s.whatsapp.net`;
    }

    currentTask = { jid, messages, delaySec, prefix, index: 0, sent: 0, isRunning: true, stopRequested: false };
    console.log(`🚀 Starting msgs to ${jid}. Type '3' to stop.`);
    runSendLoop(currentTask);
}

// ============================================================
//  LOGOUT & MAIN LOOP
// ============================================================

async function logoutAndDelete() {
    console.log("🛑 Logging out...");
    if (currentTask) currentTask.stopRequested = true;
    state.stopReconnect = true;
    if (state.client) {
        try { await state.client.logout().catch(()=>{}); state.client.end(); } catch (e) {}
    }
    if (state.authPath && fs.existsSync(state.authPath)) fs.rmSync(state.authPath, { recursive: true, force: true });
    Object.assign(state, { client: null, number: null, authPath: null, connected: false, loggedOut: false, authRequired: false });
    console.log("✅ Data cleared.");
}

async function main() {
    console.log("==============================================");
    console.log("  KRIX – Background Venom (MAC BYPASS)");
    console.log("==============================================");

    // Auto-restore logic simplified
    const authPath = path.join("temp");
    if (fs.existsSync(authPath)) {
        const dirs = fs.readdirSync(authPath).filter(d => d.startsWith("auth_"));
        if (dirs.length) {
            const lastSession = path.join(authPath, dirs[0]);
            state.number = dirs[0].replace("auth_", "");
            state.authPath = lastSession;
            console.log(`🔄 Trying to restore saved session...`);
            withSocketLock(() => createSocket(state.number, lastSession)).then(res => {
                if (res) registerHandlers();
            }).catch(()=>{});
        }
    }

    while (true) {
        await showMenu();
        const choice = (await ask("Select option: ")).trim();

        if (choice === "1") await generatePairingCode();
        else if (choice === "2") await sendMessages();
        else if (choice === "3") { if (currentTask) currentTask.stopRequested = true; console.log("🛑 Stop requested."); }
        else if (choice === "4") await logoutAndDelete();
        else if (choice === "5") {
            if (currentTask) currentTask.stopRequested = true;
            process.exit(0);
        }
    }
}

process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

main();
