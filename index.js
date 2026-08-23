// ============================================================
//  KRIX – BACKGROUND VENOM (TERMUX CLI VERSION)
//  ✅ No port, no web server, pure terminal
//  ✅ Pairing code + socket logic same as before
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
const DR = DisconnectReason || { loggedOut: 401, forbidden: 403, restartRequired: 515 };

const logger = pino({ level: "fatal" });

// Folders
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
    socketLock: null,
    stopReconnect: false,
    reconnectAttempts: 0,
    lastError: null,
    saveCreds: null
};

let currentTask = null; // currently running send task

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

function backupAuth() {
    if (!state.authPath) return;
    try {
        const backupDir = path.join("backups", `${path.basename(state.authPath)}_${Date.now()}`);
        fs.cpSync(state.authPath, backupDir, { recursive: true, force: true });
        console.log(`💾 Auth backup done: ${backupDir}`);
    } catch (e) {
        console.error("Backup failed:", e.message);
    }
}

function closeSocket(timeout = 2500) {
    return new Promise(resolve => {
        const client = state.client;
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
        } catch (e) {}

        try {
            client.end();
        } catch (e) {}

        setTimeout(done, timeout);
    });
}

async function withSocketLock(fn) {
    if (state.socketLock) return state.socketLock;
    const p = (async () => fn())();
    state.socketLock = p;
    try {
        return await p;
    } finally {
        if (state.socketLock === p) state.socketLock = null;
    }
}

// ============================================================
//  SOCKET CREATION (SAME LOGIC)
// ============================================================

async function createSocket(number, authPath) {
    if (state.client) {
        await closeSocket();
    }

    let authState;
    let saveCreds;
    try {
        const loaded = await useMultiFileAuthState(authPath);
        authState = loaded.state;
        saveCreds = loaded.saveCreds;
    } catch (e) {
        state.authRequired = true;
        state.lastError = `AUTH_READ_FAILED: ${e.message}`;
        throw new Error(state.lastError);
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
        printQRInTerminal: false,
        logger: logger,
        browser: Browsers.macOS('Safari'),
        syncFullHistory: false,
        shouldIgnoreJid: jid => isJidBroadcast(jid),
        getMessage: async () => ({})
    });

    state.client = client;
    state.saveCreds = saveCreds;

    return { client, state: authState, saveCreds };
}

function registerHandlers() {
    const client = state.client;
    if (!client) return;

    client.ev.on("creds.update", debounce(async () => {
        try {
            await state.saveCreds();
        } catch (e) {
            console.error("creds save error:", e.message);
        }
    }, 3000));

    client.ev.on("connection.update", handleConnectionUpdate);
}

// ============================================================
//  CONNECTION UPDATE (SAME HANDLER)
// ============================================================

async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, isNewLogin } = update;

    if (connection === "open") {
        state.connected = true;
        state.reconnectAttempts = 0;
        state.authRequired = false;
        state.loggedOut = false;
        state.lastError = null;
        if (isNewLogin) console.log("🔑 New login established!");
        console.log("✅ Connected!");
        return;
    }

    if (connection === "close") {
        state.connected = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || "";
        state.lastError = errMsg || `Connection closed (code=${statusCode})`;
        state.lastDisconnectReason = statusCode;

        console.log(`❌ Connection closed, code=${statusCode}, reason=${errMsg}`);

        if (state.stopReconnect) return;

        // Auth failure
        if (
            statusCode === DR.loggedOut ||
            statusCode === DR.forbidden ||
            /logout|logged out|invalid auth|401/i.test(errMsg)
        ) {
            state.loggedOut = true;
            state.authRequired = true;
            console.log("🔐 Auth required. Pair again.");
            return;
        }

        // Reconnect
        attemptReconnect().catch(e => console.error("Reconnect error:", e));
    }
}

// ============================================================
//  RECONNECT (SAME ENGINE)
// ============================================================

async function attemptReconnect() {
    if (state.stopReconnect || state.loggedOut || state.reconnecting || state.socketLock) return;

    state.reconnecting = true;

    try {
        if (state.client) {
            const oldClient = state.client;
            state.client = null;
            await closeSocket();
        }

        if (state.stopReconnect || state.loggedOut) return;

        state.reconnectAttempts++;

        if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.error("⛔ Max reconnect attempts reached");
            return;
        }

        const backoff = Math.min(20000, 1000 * Math.pow(2, state.reconnectAttempts - 1));
        console.log(`🔄 Reconnecting in ${(backoff / 1000).toFixed(1)}s (attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

        await delay(backoff);

        if (state.stopReconnect || state.loggedOut) return;

        backupAuth();

        const socketData = await withSocketLock(() => createSocket(state.number, state.authPath));
        if (!socketData) return;

        registerHandlers();
        console.log("✅ Socket recreated");
    } catch (e) {
        console.error("❌ Reconnect failed:", e.message);
        if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            setTimeout(() => attemptReconnect(), 5000);
        }
    } finally {
        state.reconnecting = false;
    }
}

// ============================================================
//  CLI HELPERS
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
    console.log("1. Generate Pairing Code");
    console.log("2. Send Messages (bulk)");
    console.log("3. Show Groups");
    console.log("4. Stop Current Task");
    console.log("5. Logout / Delete Session");
    console.log("6. Exit");
    console.log("==============================");
}

// ============================================================
//  PAIRING (SAME PAIR CODE LOGIC)
// ============================================================

async function generatePairingCode() {
    if (state.client) {
        console.log("⚠️  Already have a session! Logout first.");
        return;
    }

    const input = await ask("Enter WhatsApp number (with country code): ");
    const number = input.replace(/[^0-9]/g, "");

    if (number.length < 7 || number.length > 15) {
        console.log("❌ Invalid number. Use country code + number (e.g., 92300xxxxxxx).");
        return;
    }

    state.number = number;
    state.authPath = path.join("temp", `session_${Date.now()}`);
    if (fs.existsSync(state.authPath)) fs.rmSync(state.authPath, { recursive: true, force: true });
    fs.mkdirSync(state.authPath, { recursive: true });

    console.log("🔄 Initializing socket...");

    try {
        const socketData = await createSocket(number, state.authPath);
        registerHandlers();

        if (socketData.state.creds.registered) {
            console.log("⚠️  This session is already registered. Logout first.");
            return;
        }

        await delay(1500);

        const code = await withTimeout(
            state.client.requestPairingCode(number),
            30000,
            "Pairing code request timed out"
        );

        console.log("\n==============================================");
        console.log(`🔐 PAIRING CODE: ${code}`);
        console.log("==============================================");
        console.log("Enter this code in WhatsApp → Linked Devices → Link with phone number");
        console.log("Waiting for connection...");

        // Wait for connected (max 60s)
        for (let i = 0; i < 60; i++) {
            if (state.connected) break;
            await delay(1000);
        }

        if (state.connected) {
            console.log("✅ WhatsApp connected!");
        } else {
            console.log("⚠️  Not connected yet. Check if code was entered correctly.");
        }
    } catch (err) {
        console.error("❌ Pairing failed:", err.message);
        if (state.client) {
            state.client.ev.removeAllListeners();
            state.client.end();
            state.client = null;
        }
    }
}

// ============================================================
//  SEND MESSAGES (BULK LOOP)
// ============================================================

async function runSendLoop(task) {
    const { target, targetType, recipients, messages, delaySec, prefix } = task;

    while (task.isRunning && !task.stopRequested) {
        if (!state.client || !state.connected) {
            console.log("⏸ Connection lost, waiting...");
            await delay(5000);
            continue;
        }

        const msg = prefix ? `${prefix.trim()} ${messages[task.index]}` : messages[task.index];

        try {
            await state.client.sendMessage(recipients[task.index % recipients.length], { text: msg });
            task.sent++;
            task.index = (task.index + 1) % messages.length;
            console.log(`✅ Sent #${task.sent} to ${recipients.join(', ')}`);
            await delay(delaySec * 1000);
        } catch (err) {
            console.error(`❌ Send failed:`, err.message);
            await delay(delaySec * 1000);
        }
    }

    task.isRunning = false;
    console.log(`🏁 Task finished. Total sent: ${task.sent}`);
}

async function sendMessages() {
    if (!state.client || !state.connected) {
        console.log("❌ Not connected. Generate pairing code first.");
        return;
    }

    if (currentTask && currentTask.isRunning) {
        console.log("⚠️  Already a task running. Stop it first.");
        return;
    }

    const targetType = await ask("Target type (number/group): ");
    const target = await ask("Target (number or group UID): ");
    const filePath = await ask("Message file path (e.g., messages.txt): ");
    const prefix = await ask("Message prefix (Hater Name) [Enter to skip]: ");
    const delaySec = parseInt(await ask("Delay in seconds: ")) || 10;

    if (!fs.existsSync(filePath)) {
        console.log("❌ File not found.");
        return;
    }

    const messages = fs.readFileSync(filePath, "utf-8")
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0);

    if (messages.length === 0) {
        console.log("❌ Empty message file.");
        return;
    }

    // Build recipient list
    let recipients;
    if (targetType.toLowerCase() === "group") {
        recipients = [target + "@g.us"];
    } else {
        recipients = [target + "@s.whatsapp.net"];
    }

    currentTask = {
        target,
        targetType,
        recipients,
        messages,
        delaySec,
        prefix,
        index: 0,
        sent: 0,
        isRunning: true,
        stopRequested: false
    };

    console.log("🚀 Task started! Type '4' to stop it.");
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
            console.log(`${i}. ${g.subject}`);
            console.log(`   ID: ${gid.replace('@g.us', '')}`);
            console.log(`   Members: ${g.participants ? g.participants.length : 'N/A'}`);
            i++;
        }
        if (i === 1) console.log("No groups found.");
    } catch (e) {
        console.error("❌ Error fetching groups:", e.message);
    }
}

// ============================================================
//  LOGOUT / DELETE SESSION
// ============================================================

async function logoutAndDelete() {
    if (!state.client) {
        console.log("⚠️  No active session.");
        return;
    }

    console.log("🛑 Logging out...");
    if (currentTask && currentTask.isRunning) {
        currentTask.stopRequested = true;
        currentTask.isRunning = false;
    }

    state.stopReconnect = true;

    try {
        state.client.ev.removeAllListeners();
        state.client.end();
    } catch (e) {}

    if (state.authPath && fs.existsSync(state.authPath)) {
        fs.rmSync(state.authPath, { recursive: true, force: true });
        console.log("🧹 Auth files deleted.");
    }

    state.client = null;
    state.connected = false;
    state.loggedOut = false;
    state.authRequired = false;
    state.reconnectAttempts = 0;
    state.stopReconnect = false;
    state.number = null;
    state.authPath = null;
    state.saveCreds = null;
    currentTask = null;

    console.log("✅ Session deleted. You can pair again.");
}

// ============================================================
//  MAIN LOOP
// ============================================================

async function main() {
    console.log("==============================================");
    console.log("  KRIX – Background Venom (Termux CLI)");
    console.log("  No port, no web. Direct terminal control.");
    console.log("==============================================");

    let running = true;

    while (running) {
        await showMenu();
        const choice = await ask("Select option: ");

        switch (choice.trim()) {
            case "1":
                await generatePairingCode();
                break;
            case "2":
                await sendMessages();
                break;
            case "3":
                await showGroups();
                break;
            case "4":
                if (currentTask && currentTask.isRunning) {
                    currentTask.stopRequested = true;
                    console.log("🛑 Stop requested. Task will stop after current message.");
                } else {
                    console.log("ℹ️  No task running.");
                }
                break;
            case "5":
                await logoutAndDelete();
                break;
            case "6":
                console.log("👋 Exiting...");
                if (currentTask && currentTask.isRunning) {
                    currentTask.stopRequested = true;
                    currentTask.isRunning = false;
                }
                if (state.client) {
                    try {
                        state.client.ev.removeAllListeners();
                        state.client.end();
                    } catch (e) {}
                }
                running = false;
                rl.close();
                process.exit(0);
                break;
            default:
                console.log("❌ Invalid option.");
        }
    }
}

// ============================================================
//  CRASH HANDLERS
// ============================================================

process.on("uncaughtException", (err) => {
    console.error("🔥 Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
    console.error("🔥 Unhandled Rejection:", reason);
});

// Start
main();
