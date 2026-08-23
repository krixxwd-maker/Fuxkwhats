// ============================================================
//  KRIX – BACKGROUND VENOM (TERMUX CLI – 401 FIXED)
//  ✅ Pairing retry 3x + QR fallback + session restore
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
        console.log(`💾 Auth backup done: ${backupDir}`);
    } catch (e) {
        console.error("Backup failed:", e.message);
    }
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
        } catch (e) {}

        try {
            client.ev.on("connection.update", u => {
                if (u.connection === "close") done();
            });
        } catch (e) {}

        try {
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
        printQRInTerminal: qr,
        logger: logger,
        browser: Browsers.windows('Chrome'),
        syncFullHistory: false,
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
        } catch (e) {
            console.error("creds save error:", e.message);
        }
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

        // Pairing ke beech close hone par generatePairingCode loop handle karega
        if (state.pairing) {
            console.log("⏳ Pairing interrupted. Retrying with new code...");
            return;
        }

        if (state.stopReconnect) return;

        if (isAuthFailure(statusCode, errMsg)) {
            state.loggedOut = true;
            state.authRequired = true;
            console.log("🔐 Auth required. Use option 5 to delete session and pair again.");
            return;
        }

        attemptReconnect().catch(e => console.error("Reconnect error:", e));
    }
}

// ============================================================
//  RECONNECT
// ============================================================

async function attemptReconnect() {
    if (state.pairing) return;
    if (state.stopReconnect || state.loggedOut || state.reconnecting || socketLockPromise) return;

    state.reconnecting = true;

    try {
        const oldClient = state.client;
        if (oldClient) {
            state.client = null;
            await closeSocket(oldClient);
        }

        if (state.stopReconnect || state.loggedOut || state.pairing) return;

        state.reconnectAttempts++;

        if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.error("⛔ Max reconnect attempts reached");
            return;
        }

        const backoff = Math.min(20000, 1000 * Math.pow(2, state.reconnectAttempts - 1));
        console.log(`🔄 Reconnecting in ${(backoff / 1000).toFixed(1)}s (attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

        await delay(backoff);

        if (state.stopReconnect || state.loggedOut || state.pairing) return;

        backupAuth();

        const socketData = await withSocketLock(() => createSocket(state.number, state.authPath));
        if (!socketData) return;

        registerHandlers();
        console.log("✅ Socket recreated");
    } catch (e) {
        console.error("❌ Reconnect failed:", e.message);

        if (/AUTH_READ_FAILED|Bad file|ENOENT|Invalid key/i.test(e.message)) {
            state.authRequired = true;
            return;
        }

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
    console.log("1. Pair / Restore Session");
    console.log("2. Send Messages (bulk)");
    console.log("3. Show Groups");
    console.log("4. Stop Current Task");
    console.log("5. Logout / Delete Session");
    console.log("6. Exit");
    console.log("==============================");
}

// ============================================================
//  AUTO RESTORE
// ============================================================

async function tryRestoreSession() {
    const authPath = findExistingSession();
    if (!authPath) return;

    const number = path.basename(authPath).replace(/^auth_/, "");
    console.log(`🔄 Found saved session for ${number}. Restoring...`);

    state.number = number;
    state.authPath = authPath;

    try {
        const socketData = await withSocketLock(() => createSocket(number, authPath));
        if (!socketData) return;
        registerHandlers();

        for (let i = 0; i < 15; i++) {
            if (state.connected) break;
            if (state.authRequired) break;
            await delay(1000);
        }

        if (state.connected) {
            console.log("✅ Session restored and connected.");
        } else if (state.authRequired) {
            console.log("⚠️ Saved session is invalid. Use option 1 to pair again.");
        } else {
            console.log("🔄 Session restored, waiting for auto-reconnect...");
        }
    } catch (e) {
        console.error("❌ Restore failed:", e.message);
    }
}

// ============================================================
//  PAIRING WITH RETRY + QR FALLBACK (401 FIX)
// ============================================================

async function generatePairingCode() {
    const input = await ask("Enter WhatsApp number (with country code): ");
    const number = normalizeNumber(input);
    if (!number) {
        console.log("❌ Invalid number. Use country code + number (e.g., 92300xxxxxxx).");
        return;
    }

    const authPath = getAuthPath(number);
    state.number = number;
    state.authPath = authPath;

    // Already connected
    if (state.client && state.connected) {
        console.log("⚠️ Already connected. Use option 5 to logout first.");
        return;
    }

    // Purana socket hatao (fresh start for pairing)
    if (state.client) {
        await closeSocket(state.client);
        state.client = null;
    }

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        attempts++;
        if (attempts > 1) {
            console.log(`\n🔄 Retry ${attempts}/${maxAttempts} – Naya pairing code generate ho raha hai...`);
        }

        // Naya socket banao
        try {
            const socketData = await withSocketLock(() => createSocket(number, authPath));
            if (!socketData) return;
            registerHandlers();
        } catch (err) {
            console.error("❌ Socket creation failed:", err.message);
            if (attempts >= maxAttempts) break;
            await delay(3000);
            continue;
        }

        if (state.credsRegistered) {
            console.log("ℹ️ Session already registered. Use option 5 to logout.");
            return;
        }

        state.pairing = true;
        await delay(1500);

        try {
            const code = await withTimeout(
                state.client.requestPairingCode(number),
                30000,
                "Pairing code request timed out"
            );

            console.log("\n==============================================");
            console.log(`🔐 PAIRING CODE: ${code}`);
            console.log("==============================================");
            console.log("Enter this code in WhatsApp → Linked Devices → Link with phone number");
            console.log("Waiting for connection (timeout: 60s)...");

            // Wait for either "open" or "close"
            let waitingError = null;
            try {
                await withTimeout(waitForPairingResult(), 60000, "Pairing timeout: code may have expired");
            } catch (err) {
                waitingError = err;
            }

            if (state.connected) {
                console.log("✅ WhatsApp connected!");
                state.pairing = false;
                return;
            }

            if (waitingError) {
                console.log(`⚠️ ${waitingError.message}`);
                state.pairing = false;

                // Agar socket close ho gaya, aur attempts baaki hain, retry karo
                if (attempts < maxAttempts) {
                    await delay(2000);
                    continue;
                }
            }
        } catch (err) {
            console.error("❌ Pairing failed:", err.message);
            state.pairing = false;
            if (attempts >= maxAttempts) break;
            await delay(3000);
            continue;
        } finally {
            state.pairing = false;
        }
    }

    // Sab attempts fail → QR fallback
    console.log("❌ Pairing code attempts failed. QR code se try karo...");
    await fallbackToQR(number, authPath);
}

function waitForPairingResult() {
    return new Promise((resolve, reject) => {
        const client = state.client;
        if (!client) return reject(new Error("No client"));

        const onUpdate = (update) => {
            if (update.connection === "open") {
                cleanup();
                resolve(true);
            } else if (update.connection === "close") {
                cleanup();
                reject(new Error(`Socket closed during pairing (code=${state.lastDisconnectReason})`));
            }
        };

        const cleanup = () => {
            client.ev.removeListener("connection.update", onUpdate);
        };

        client.ev.on("connection.update", onUpdate);
    });
}

async function fallbackToQR(number, authPath) {
    if (state.client) {
        await closeSocket(state.client);
        state.client = null;
    }

    console.log("🔄 Starting QR mode...");

    try {
        const socketData = await withSocketLock(() => createSocket(number, authPath, true));
        if (!socketData) return;
        registerHandlers();
        state.pairing = true;

        console.log("📱 Scan the QR code above with WhatsApp → Linked Devices → Link a device");
        console.log("⏳ Waiting for scan (timeout: 120s)...");

        try {
            await withTimeout(waitForPairingResult(), 120000, "QR scan timeout");
            if (state.connected) console.log("✅ WhatsApp connected!");
        } catch (err) {
            console.log(`⚠️ ${err.message}`);
        }

        state.pairing = false;
    } catch (err) {
        console.error("❌ QR mode failed:", err.message);
    }
}

// ============================================================
//  SEND MESSAGES
// ============================================================

async function runSendLoop(task) {
    const { messages, recipients, delaySec, prefix } = task;

    while (task.isRunning && !task.stopRequested) {
        if (state.authRequired || state.loggedOut) {
            console.log("🔐 Auth invalid. Task stopped.");
            task.stopRequested = true;
            break;
        }

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

    if (state.authRequired || state.loggedOut) {
        console.log("🔐 Auth invalid. Pair again.");
        return;
    }

    if (currentTask && currentTask.isRunning) {
        console.log("⚠️ Already a task running. Stop it first.");
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
    if (!state.client && !state.authPath) {
        console.log("⚠️  No active session.");
        return;
    }

    console.log("🛑 Logging out...");
    if (currentTask && currentTask.isRunning) {
        currentTask.stopRequested = true;
        currentTask.isRunning = false;
    }

    state.stopReconnect = true;

    if (state.client) {
        try {
            state.client.ev.removeAllListeners();
            state.client.end();
        } catch (e) {}
    }

    if (state.authPath && fs.existsSync(state.authPath)) {
        fs.rmSync(state.authPath, { recursive: true, force: true });
        console.log("🧹 Auth files deleted.");
    }

    state.client = null;
    state.number = null;
    state.authPath = null;
    state.connected = false;
    state.loggedOut = false;
    state.authRequired = false;
    state.reconnectAttempts = 0;
    state.stopReconnect = false;
    state.saveCreds = null;
    state.credsRegistered = false;
    state.pairing = false;
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

    await tryRestoreSession();

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
