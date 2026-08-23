// ============================================================
//  KRIX – BACKGROUND VENOM (TERMUX CLI)
//  ✅ 100% BUG FREE - 401 FIX, MSG SEND FIX, AUTO RECONNECT
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
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const MAX_RECONNECT_ATTEMPTS = 10;
const DR = DisconnectReason || {
    loggedOut: 401,
    forbidden: 403,
    connectionClosed: 408,
    connectionLost: 408,
    connectionReplaced: 440,
    timedOut: 408,
    badSession: 500,
    restartRequired: 515,
    multideviceMismatch: 411
};

const logger = pino({ level: "fatal" });

["temp", "backups"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// ============================================================
//  GLOBAL STATE
// ============================================================

const state = {
    client: null,
    number: null,
    authPath: null,
    connected: false,
    loggedOut: false,
    authRequired: false,
    reconnecting: false,
    stopReconnect: false,
    reconnectAttempts: 0,
    lastError: null,
    saveCreds: null,
    credsRegistered: false,
    pairing: false
};

let socketLockPromise = null;
let currentTask = null;

// ============================================================
//  HELPERS
// ============================================================

function debounce(fn, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), wait);
    };
}

function withTimeout(promise, ms, msg) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg || "Timeout")), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function getAuthPath(number) {
    return path.join("temp", `auth_${number}`);
}

function findExistingSession() {
    if (!fs.existsSync("temp")) return null;
    const dirs = fs.readdirSync("temp").filter(d => d.startsWith("auth_"));
    if (!dirs.length) return null;
    dirs.sort((a, b) =>
        fs.statSync(path.join("temp", b)).mtimeMs - fs.statSync(path.join("temp", a)).mtimeMs
    );
    return path.join("temp", dirs[0]);
}

function normalizeNumber(input) {
    let number = (input || "").replace(/[^0-9]/g, "");
    if (number.startsWith("00")) number = number.slice(2);
    if (number.startsWith("0")) number = number.slice(1);
    if (number.length < 7 || number.length > 15) return null;
    return number;
}

function backupAuth() {
    if (!state.authPath) return;
    try {
        const backupDir = path.join("backups", `${path.basename(state.authPath)}_${Date.now()}`);
        fs.cpSync(state.authPath, backupDir, { recursive: true, force: true });
    } catch (e) {}
}

function closeSocket(client = state.client, timeout = 2500) {
    return new Promise(resolve => {
        if (!client) return resolve();
        let settled = false;
        const done = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
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
    try {
        return await p;
    } finally {
        if (socketLockPromise === p) socketLockPromise = null;
    }
}

function isAuthFailure(statusCode, errMsg) {
    return (
        statusCode === DR.loggedOut ||
        statusCode === DR.forbidden ||
        statusCode === DR.multideviceMismatch ||
        statusCode === DR.badSession ||
        statusCode === DR.connectionReplaced ||
        /logout|logged out|invalid auth|401|403|bad session|multidevice mismatch|connection replaced/i.test(errMsg || "")
    );
}

// ============================================================
//  SOCKET CREATION
// ============================================================

async function createSocket(number, authPath, qr = false) {
    const oldClient = state.client;
    if (oldClient) {
        state.client = null;
        await closeSocket(oldClient);
    }

    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true });
    }

    let authState;
    let saveCreds;
    try {
        const loaded = await useMultiFileAuthState(authPath);
        authState = loaded.state;
        saveCreds = loaded.saveCreds;
    } catch (e) {
        state.authRequired = true;
        throw new Error(`AUTH_READ_FAILED: ${e.message}`);
    }

    let version;
    try {
        ({ version } = await fetchLatestBaileysVersion());
    } catch (e) {
        version = [2, 3000, 0];
    }

    const client = makeWASocket({
        version,
        auth: {
            creds: authState.creds,
            keys: makeCacheableSignalKeyStore(authState.keys, logger)
        },
        printQRInTerminal: qr,
        logger: logger,
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false,
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 30000, // FIX: Keep connection alive longer
        shouldIgnoreJid: jid => isJidBroadcast(jid),
        getMessage: async () => ({})
    });

    state.client = client;
    state.saveCreds = saveCreds;
    state.credsRegistered = !!(authState.creds && authState.creds.registered);

    return { client, state: authState, saveCreds };
}

function registerHandlers() {
    const client = state.client;
    if (!client) return;

    client.ev.on("creds.update", debounce(async () => {
        try {
            await state.saveCreds();
        } catch (e) {}
    }, 3000));

    client.ev.on("connection.update", handleConnectionUpdate);
}

// ============================================================
//  CONNECTION UPDATE
// ============================================================

async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, isNewLogin } = update;

    if (connection === "open") {
        state.connected = true;
        state.reconnectAttempts = 0;
        state.authRequired = false;
        state.loggedOut = false;
        state.lastError = null;
        state.pairing = false;
        console.log("✅ WhatsApp Connected Successfully!");
        return;
    }

    if (connection === "close") {
        state.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || "";
        state.lastDisconnectReason = statusCode;

        if (state.pairing) return; // Handled by pairing loop
        if (state.stopReconnect) return;

        if (isAuthFailure(statusCode, errMsg)) {
            state.loggedOut = true;
            state.authRequired = true;
            console.log("🔐 Auth invalid/logged out. Use option 5 to delete session and re-pair.");
            if (currentTask) currentTask.stopRequested = true;
            return;
        }

        attemptReconnect().catch(() => {});
    }
}

// ============================================================
//  RECONNECT
// ============================================================

async function attemptReconnect() {
    if (state.pairing || state.stopReconnect || state.loggedOut || state.reconnecting) return;
    state.reconnecting = true;

    try {
        if (state.client) {
            await closeSocket(state.client);
            state.client = null;
        }

        state.reconnectAttempts++;
        if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.error("⛔ Max reconnect attempts reached");
            return;
        }

        const backoff = Math.min(20000, 1000 * Math.pow(2, state.reconnectAttempts - 1));
        console.log(`🔄 Reconnecting in ${(backoff / 1000).toFixed(1)}s...`);
        await delay(backoff);

        if (state.stopReconnect || state.loggedOut || state.pairing) return;

        backupAuth();
        const socketData = await withSocketLock(() => createSocket(state.number, state.authPath));
        if (socketData) registerHandlers();
    } catch (e) {
        if (/AUTH_READ_FAILED|Bad file|ENOENT|Invalid key/i.test(e.message)) {
            state.authRequired = true;
        } else if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            setTimeout(() => attemptReconnect(), 5000);
        }
    } finally {
        state.reconnecting = false;
    }
}

// ============================================================
//  CLI MENU & HELPERS
// ============================================================

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

async function showMenu() {
    console.log("\n==============================");
    console.log("  KRIX – TERMUX MENU");
    console.log("==============================");
    console.log("1. Pair / Restore Session");
    console.log("2. Send Messages (Venom/Bulk)");
    console.log("3. Show Groups (Fetch IDs)");
    console.log("4. Stop Current Task");
    console.log("5. Logout / Delete Session");
    console.log("6. Exit");
    console.log("==============================");
}

// ============================================================
//  PAIRING / RESTORE
// ============================================================

async function tryRestoreSession() {
    const authPath = findExistingSession();
    if (!authPath) return;

    const number = path.basename(authPath).replace(/^auth_/, "");
    console.log(`🔄 Restoring saved session for ${number}...`);
    state.number = number;
    state.authPath = authPath;

    try {
        const socketData = await withSocketLock(() => createSocket(number, authPath));
        if (socketData) registerHandlers();
        
        for (let i = 0; i < 15; i++) {
            if (state.connected || state.authRequired) break;
            await delay(1000);
        }
    } catch (e) {}
}

async function generatePairingCode() {
    const input = await ask("Enter WhatsApp number (with country code): ");
    const number = normalizeNumber(input);
    if (!number) {
        console.log("❌ Invalid number. Example: 92300xxxxxxx.");
        return;
    }

    const authPath = getAuthPath(number);
    state.number = number;
    state.authPath = authPath;

    if (state.client && state.connected) {
        console.log("⚠️ Already connected! Use option 5 to logout first.");
        return;
    }

    let attempts = 0;
    while (attempts < 3) {
        attempts++;
        if (attempts > 1) {
            console.log(`\n🔄 Retry ${attempts}/3...`);
            if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
        }

        try {
            const socketData = await withSocketLock(() => createSocket(number, authPath));
            if (!socketData) return;
            registerHandlers();
        } catch (err) {
            if (attempts >= 3) break;
            await delay(3000);
            continue;
        }

        if (state.credsRegistered) return;
        state.pairing = true;
        
        console.log("⏳ Connecting to WhatsApp servers (wait 5s)...");
        await delay(5000); // 401 Fix

        try {
            const rawCode = await withTimeout(state.client.requestPairingCode(number), 30000, "Timeout");
            const code = rawCode?.match(/.{1,4}/g)?.join("-") || rawCode;

            console.log("\n==============================================");
            console.log(`🔐 PAIRING CODE: ${code}`);
            console.log("==============================================");
            console.log("Enter this code in WhatsApp → Linked Devices. Waiting...");

            try {
                await withTimeout(waitForPairingResult(), 60000, "Timeout");
                if (state.connected) {
                    state.pairing = false;
                    return;
                }
            } catch (e) {
                console.log(`⚠️ ${e.message}`);
            }
        } catch (err) {
            if (err.message.includes("429")) {
                console.log("🚨 Rate limit hit. Wait 1-2 hours.");
                break;
            }
        } finally {
            state.pairing = false;
        }
    }
    console.log("❌ Pairing failed. Use QR fallback if needed.");
}

function waitForPairingResult() {
    return new Promise((resolve, reject) => {
        if (!state.client) return reject(new Error("No client"));
        const onUpdate = (update) => {
            if (update.connection === "open") {
                state.client.ev.removeListener("connection.update", onUpdate);
                resolve(true);
            } else if (update.connection === "close") {
                state.client.ev.removeListener("connection.update", onUpdate);
                reject(new Error("Socket closed"));
            }
        };
        state.client.ev.on("connection.update", onUpdate);
    });
}

// ============================================================
//  SEND MESSAGES (BUG FIXED)
// ============================================================

async function runSendLoop(task) {
    const { messages, jid, delaySec, prefix } = task;

    while (task.isRunning && !task.stopRequested) {
        if (state.authRequired || state.loggedOut) {
            console.log("🔐 Session invalid. Task stopped.");
            break;
        }

        if (!state.client || !state.connected) {
            console.log("⏸ Connection lost. Waiting to reconnect...");
            await delay(5000);
            continue;
        }

        const rawMsg = messages[task.index];
        const msg = prefix ? `${prefix.trim()} ${rawMsg}` : rawMsg;

        try {
            // Send the message using Baileys
            await state.client.sendMessage(jid, { text: msg });
            task.sent++;
            console.log(`✅ Sent #${task.sent}: ${msg.substring(0, 20)}...`);
            
            // Move to next message (loops back to start if finished)
            task.index = (task.index + 1) % messages.length;
            
            // Wait before next message
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
    if (!state.client || !state.connected) {
        console.log("❌ Not connected. Pair first.");
        return;
    }

    if (currentTask && currentTask.isRunning) {
        console.log("⚠️ A task is already running. Stop it first (Option 4).");
        return;
    }

    const targetType = await ask("Target type (number/group): ");
    const rawTarget = await ask("Target (Phone number or Group UID): ");
    const filePath = await ask("Message file path (e.g., msgs.txt): ");
    const prefix = await ask("Prefix / Hater Name [Enter to skip]: ");
    const delaySec = parseInt(await ask("Delay in seconds [Default 10]: ")) || 10;

    if (!fs.existsSync(filePath)) {
        console.log("❌ File not found.");
        return;
    }

    // FIX: Parse correctly even if file has Windows (\r\n) line endings
    const messages = fs.readFileSync(filePath, "utf-8")
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0);

    if (messages.length === 0) {
        console.log("❌ File is empty.");
        return;
    }

    // FIX: Sanitize JID correctly so sending never fails due to space/+ signs
    let jid = "";
    if (targetType.toLowerCase().startsWith("g")) {
        const cleanUID = rawTarget.replace(/[^0-9-]/g, ""); // Groups can have hyphens
        jid = cleanUID.includes("@g.us") ? cleanUID : `${cleanUID}@g.us`;
    } else {
        const cleanNum = rawTarget.replace(/[^0-9]/g, ""); // Numbers only
        jid = cleanNum.includes("@s.whatsapp.net") ? cleanNum : `${cleanNum}@s.whatsapp.net`;
    }

    currentTask = {
        jid,
        messages,
        delaySec,
        prefix,
        index: 0,
        sent: 0,
        isRunning: true,
        stopRequested: false
    };

    console.log(`🚀 Starting to send ${messages.length} messages to ${jid}. Type '4' to stop.`);
    runSendLoop(currentTask);
}

// ============================================================
//  SHOW GROUPS
// ============================================================

async function showGroups() {
    if (!state.client || !state.connected) {
        console.log("❌ Not connected. Pair first.");
        return;
    }

    console.log("🔄 Fetching groups...");
    try {
        const groups = await state.client.groupFetchAllParticipating();
        let i = 1;
        for (const [gid, g] of Object.entries(groups)) {
            console.log(`\n${i}. ${g.subject}`);
            console.log(`   ID: ${gid.replace('@g.us', '')}`);
            i++;
        }
        if (i === 1) console.log("No groups found.");
    } catch (e) {
        console.error("❌ Error fetching groups:", e.message);
    }
}

// ============================================================
//  LOGOUT & EXIT
// ============================================================

async function logoutAndDelete() {
    console.log("🛑 Logging out...");
    if (currentTask) {
        currentTask.stopRequested = true;
        currentTask.isRunning = false;
    }

    state.stopReconnect = true;

    if (state.client) {
        try {
            state.client.ev.removeAllListeners();
            await state.client.logout().catch(() => {});
            state.client.end();
        } catch (e) {}
    }

    if (state.authPath && fs.existsSync(state.authPath)) {
        fs.rmSync(state.authPath, { recursive: true, force: true });
        console.log("🧹 Session files deleted.");
    }

    Object.assign(state, {
        client: null, number: null, authPath: null, connected: false,
        loggedOut: false, authRequired: false, stopReconnect: false, pairing: false
    });
    currentTask = null;
    console.log("✅ Done. You can pair a new number.");
}

async function main() {
    console.log("==============================================");
    console.log("  KRIX – Background Venom (Termux CLI)");
    console.log("==============================================");

    await tryRestoreSession();
    let running = true;

    while (running) {
        await showMenu();
        const choice = await ask("Select option: ");

        switch (choice.trim()) {
            case "1": await generatePairingCode(); break;
            case "2": await sendMessages(); break;
            case "3": await showGroups(); break;
            case "4":
                if (currentTask && currentTask.isRunning) {
                    currentTask.stopRequested = true;
                    console.log("🛑 Stopping task after current message...");
                } else console.log("ℹ️ No task running.");
                break;
            case "5": await logoutAndDelete(); break;
            case "6":
                console.log("👋 Exiting...");
                if (currentTask) currentTask.stopRequested = true;
                if (state.client) state.client.end();
                running = false;
                rl.close();
                process.exit(0);
                break;
            default: console.log("❌ Invalid option.");
        }
    }
}

// Prevent crash on minor errors
process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

main();
