const WebSocket = require('ws');
const buffers = require('./config/buffers');
const algorithm = require("./utils/algorithm");
const Reader = require("./utils/reader");
const ProxyManager = require('./config/proxyManager');
const config = require('./config/config');

const CLIENTS_MAX_BOTS = 9999; // Maximum bots per client
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const UNDERLINE = "\x1b[4m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";

let bots = [];
let maxBots = CLIENTS_MAX_BOTS;
let wsServer = null;
let currentClient = null;
let initInterval = null;
let botHealthCheckInterval = null;
const BOT_HEALTH_CHECK_INTERVAL = 3450;

const data = {
    x: 0,
    y: 0,
    serverIP: null,
    protocolVersion: 0,
    clientVersion: 0,
    followMouse: true,
    party: "ScarzBots",
    vshield: false
};

function centerText(text, totalWidth) {
    const padding = totalWidth - text.length;
    const padLeft = Math.floor(padding / 2);
    const padRight = padding - padLeft;
    return ' '.repeat(padLeft) + text + ' '.repeat(padRight);
}

function showStartBanner() {
    const boxWidth = 60;
    const title = `${BOLD}${CYAN}ScarzBots${RESET}`;
    const developer = `${MAGENTA}Developed By Scarz${RESET}`;
    const proxiesStatus = `${YELLOW}Proxies: ${config.useProxies ? 'Enabled' : 'Disabled'}${RESET}`;
    const scrapingStatus = `${YELLOW}Scraping: ${config.useProxyScrape ? 'Enabled' : 'Disabled'}${RESET}`;
    const portInfo = `${GREEN}Port: ${config.port}${RESET}`;
    const versionInfo = `${MAGENTA}Version: 1${RESET}`;

    console.log(GREEN + '┌' + '─'.repeat(boxWidth) + '┐' + RESET);
    console.log(centerText(title, boxWidth));
    console.log(centerText(developer, boxWidth));
    console.log(centerText(proxiesStatus, boxWidth));
    console.log(centerText(scrapingStatus, boxWidth));
    console.log(centerText(portInfo, boxWidth));
    console.log(centerText(versionInfo, boxWidth));
    console.log(GREEN + '└' + '─'.repeat(boxWidth) + '┘' + RESET);
}

function parseIP(url) {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname + parsedUrl.pathname.replace(/\/$/g, '');
}

class Entity {
    constructor() {
        this.id = 0;
        this.x = 0;
        this.y = 0;
        this.size = 0;
        this.party = '';
        this.skin = '';
        this.isVirus = false;
        this.isPellet = false;
        this.isFriend = false;
    }
}

class Bot {
    constructor(gameIP, id) {
        this.id = id;
        this.party = data.party;
        this.gameIP = gameIP;
        this.parsedGameIp = parseIP(this.gameIP);
        this.encryptionKey = 0;
        this.decryptionKey = 0;
        this.offsetX = 0;
        this.offsetY = 0;
        this.gotMapSize = false;
        this.mapWidth = 0;
        this.mapHeight = 0;
        this.isAlive = false;
        this.lastActiveTime = Date.now();
        this.connectionAttempts = 0;
        this.maxConnectionAttempts = 3;
        this.botMoveInterval = null;
        this.botCellsIDs = [];
        this.viewportEntities = {};
        this.ghostCells = [];
        this.ws = null;
        this.biggerPlayerAvoidanceRange = 1.15;
        this.avoidanceDistance = 1;
        this.avoidanceDistance2 = 1;
        this.proxyManager = new ProxyManager();
        this.currentProxy = null;
        this.connect();
    }

    connect() {
        if (this.connectionAttempts >= this.maxConnectionAttempts) {
            this.replace();
            return;
        }

        this.connectionAttempts++;
        this.currentProxy = config.useProxies ? this.proxyManager.getNextProxy() : null;
        const wsOptions = this.proxyManager.configureWebSocketOptions(this.currentProxy);

        try {
            this.ws = new WebSocket(data.serverIP, wsOptions);
            this.ws.binaryType = "arraybuffer";
            this.ws.onopen = this.onOpen.bind(this);
            this.ws.onmessage = this.onMessage.bind(this);
            this.ws.onclose = this.onClose.bind(this);
            this.ws.onerror = this.onError.bind(this);
        } catch (error) {
            console.error(`Error connecting bot ${this.id}: ${error}`);
            this.replace();
        }
    }

    replace() {
        this.disconnect();
        const index = bots.indexOf(this);
        if (index !== -1) {
            bots[index] = new Bot(data.serverIP, this.id);
        }
    }

    disconnect() {
        if (this.ws) this.ws.close();
        if (this.botMoveInterval) clearInterval(this.botMoveInterval);
        this.isAlive = false;
    }

    updateActivity() {
        this.lastActiveTime = Date.now();
    }

    isHealthy() {
        const inactiveTime = Date.now() - this.lastActiveTime;
        return this.ws && this.ws.readyState === WebSocket.OPEN && inactiveTime < 23000;
    }

    onOpen() {
        this.updateActivity();
        this.send(buffers.protocol(data.protocolVersion));
        this.send(buffers.client(data.clientVersion));
    }

    onMessage(event) {
        this.updateActivity();
        try {
            let reader;
            if (this.decryptionKey) {
                reader = new Reader(algorithm.rotateBufferBytes(event.data, this.decryptionKey ^ data.clientVersion), true);
                const opcode = reader.readUint8();

                switch (opcode) {
                    case 18: // Server close
                        setTimeout(() => this.ws.close(), 1000);
                        break;
                    case 32: // Bot cell ID
                        this.botCellsIDs.push(reader.readUint32());
                        if (!this.isAlive) {
                            this.isAlive = true;
                            this.botMoveInterval = setInterval(() => this.move(), 17);
                        }
                        break;
                    case 69: // Ghost cells
                        const cellLength = reader.readUint16(true);
                        this.ghostCells = [];
                        for (let i = 0; i < cellLength; i++) {
                            const x = reader.readInt32(true);
                            const y = reader.readInt32(true);
                            const mass = reader.readUint32(true);
                            const size = Math.sqrt(mass) * 10;
                            if (Math.abs(x) < 14142 && Math.abs(y) < 14142 && mass > 0) {
                                this.ghostCells.push({ x, y, size, mass });
                            }
                        }
                        break;
                    case 85: // Reconnect
                        setTimeout(() => {
                            this.reconnect();
                            setTimeout(() => {
                                bots = bots.filter(bot => bot !== this);
                                bots.push(new Bot(data.serverIP, bots.length + 1));
                            }, 700);
                        }, 1000);
                        break;
                    case 242: // Spawn
                        this.send(buffers.spawn(this.party));
                        break;
                    case 255: // Compressed data
                        const buffer = algorithm.uncompressBuffer(new Uint8Array(reader.dataView.buffer.slice(5)), new Uint8Array(reader.readUint32()));
                        reader = new Reader(buffer.buffer, true);
                        const subOpcode = reader.readUint8();
                        switch (subOpcode) {
                            case 16: // Entity update
                                const eatRecordLength = reader.readUint16();
                                reader.byteOffset += eatRecordLength * 8;

                                while (true) {
                                    const id = reader.readUint32();
                                    if (id === 0) break;
                                    const entity = new Entity();
                                    entity.id = id;
                                    entity.x = reader.readInt32();
                                    entity.y = reader.readInt32();
                                    entity.size = reader.readUint16();
                                    const flags = reader.readUint8();
                                    const extendedFlags = flags & 128 ? reader.readUint8() : 0;
                                    if (flags & 1) entity.isVirus = true;
                                    if (flags & 2) reader.byteOffset += 3;
                                    if (flags & 4) entity.skin = reader.readString();
                                    if (flags & 8) entity.name = reader.readString();
                                    if (extendedFlags & 1) entity.isPellet = true;
                                    if (extendedFlags & 2) entity.isFriend = true;
                                    if (extendedFlags & 4) reader.byteOffset += 4;
                                    this.viewportEntities[entity.id] = entity;
                                }

                                const removeRecordLength = reader.readUint16();
                                for (let i = 0; i < removeRecordLength; i++) {
                                    const removedEntityID = reader.readUint32();
                                    if (this.botCellsIDs.includes(removedEntityID)) {
                                        this.botCellsIDs.splice(this.botCellsIDs.indexOf(removedEntityID), 1);
                                    }
                                    delete this.viewportEntities[removedEntityID];
                                }

                                if (this.isAlive && this.botCellsIDs.length === 0) {
                                    this.isAlive = false;
                                    setTimeout(() => {
                                        this.party = data.party;
                                        this.send(buffers.spawn(this.party));
                                    }, 1500);
                                }
                                break;
                            case 64: // Map bounds
                                const left = reader.readFloat64();
                                const top = reader.readFloat64();
                                const right = reader.readFloat64();
                                const bottom = reader.readFloat64();
                                if (!this.gotMapSize) {
                                    this.gotMapSize = true;
                                    this.mapWidth = Math.floor(right - left);
                                    this.mapHeight = Math.floor(bottom - top);
                                }
                                if (Math.floor(right - left) === this.mapWidth && Math.floor(bottom - top) === this.mapHeight) {
                                    this.offsetX = (right + left) / 2;
                                    this.offsetY = (bottom + top) / 2;
                                }
                                break;
                        }
                        break;
                }
            } else {
                reader = new Reader(event.data, true);
                if (reader.readUint8() === 0xf1) {
                    this.decryptionKey = reader.readUint32();
                    this.encryptionKey = algorithm.murmur2(this.parsedGameIp + reader.readString(), 255);
                }
            }
        } catch (error) {
            console.error(`\x1b[31m[Error] Bot ${this.id} error processing message: ${error}\x1b[0m`);
            this.replace();
        }
    }

    calculateDistanceWithPerimeter(x1, y1, size1, x2, y2, size2) {
        const centerDistance = Math.hypot(x2 - x1, y2 - y1);
        return Math.max(0, centerDistance - (size1 + size2));
    }

    getClosestEntity(type, x, y, size) {
        let closestDistance = Infinity;
        let closestEntity = null;
        for (const entity of Object.values(this.viewportEntities)) {
            let isValid = false;
            switch (type) {
                case 'biggerPlayer':
                    isValid = !entity.isVirus && !entity.isPellet && !entity.isFriend &&
                              entity.size > size * this.biggerPlayerAvoidanceRange &&
                              entity.party !== this.party;
                    break;
                case 'smallerPlayer':
                    isValid = !entity.isVirus && !entity.isPellet && !entity.isFriend &&
                              entity.size < size && entity.name !== this.party;
                    break;
                case "pellet":
                    isValid = !entity.isVirus && !entity.isFriend && entity.isPellet;
                    break;
                case "virus":
                    isValid = entity.isVirus && !entity.isPellet && !entity.isFriend &&
                              size > entity.size * 1.32;
                    break;
            }
            if (isValid) {
                const distance = this.calculateDistanceWithPerimeter(x, y, size, entity.x, entity.y, entity.size);
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestEntity = entity;
                }
            }
        }
        return { distance: closestDistance, entity: closestEntity };
    }

    sendPosition(x, y) {
        this.send(buffers.move(x, y, this.decryptionKey));
    }

    move() {
        const bot = { x: 0, y: 0, size: 0 };
        this.botCellsIDs.forEach(id => {
            const cell = this.viewportEntities[id];
            if (cell) {
                bot.x += cell.x / this.botCellsIDs.length;
                bot.y += cell.y / this.botCellsIDs.length;
                bot.size += cell.size;
            }
        });

        const closestBiggerPlayer = this.getClosestEntity('biggerPlayer', bot.x, bot.y, bot.size);
        const closestSmallerPlayer = this.getClosestEntity('smallerPlayer', bot.x, bot.y, bot.size);
        const closestPellet = this.getClosestEntity('pellet', bot.x, bot.y, bot.size);
        const closestVirus = this.getClosestEntity('virus', bot.x, bot.y, bot.size);

        const detectionRange = bot.size * 1.5;
        const detectionRange2 = bot.size * 1.2;

        if (data.vshield && bot.size >= 113 && closestVirus.entity) {
            this.sendPosition(closestVirus.entity.x, closestVirus.entity.y);
            return;
        }

        if (data.followMouse) {
            if (closestBiggerPlayer.entity && closestBiggerPlayer.distance < this.avoidanceDistance + detectionRange) {
                const deltaX = bot.x - closestBiggerPlayer.entity.x;
                const deltaY = bot.y - closestBiggerPlayer.entity.y;
                this.sendPosition(bot.x + deltaX, bot.y + deltaY);
            } else if (bot.size >= 100) {
                this.sendPosition(data.x + this.offsetX, data.y + this.offsetY);
            } else if (closestVirus.entity && closestBiggerPlayer.entity) {
                this.ejectVirusTowardsPlayer(closestVirus.entity, closestBiggerPlayer.entity);
            } else if (closestPellet.entity) {
                this.sendPosition(closestPellet.entity.x, closestPellet.entity.y);
            } else {
                const randomX = Math.floor(1337 * Math.random());
                const randomY = Math.floor(1337 * Math.random());
                this.sendPosition(bot.x + (Math.random() > 0.5 ? randomX : -randomX), bot.y + (Math.random() > 0.5 ? -randomY : randomY));
            }
        } else {
            if (this.botCellsIDs.length > 1) {
                if (closestPellet.entity) {
                    this.sendPosition(closestPellet.entity.x, closestPellet.entity.y);
                } else {
                    const randomX = Math.floor(1337 * Math.random());
                    const randomY = Math.floor(1337 * Math.random());
                    this.sendPosition(bot.x + (Math.random() > 0.5 ? randomX : -randomX), bot.y + (Math.random() > 0.5 ? -randomY : randomY));
                }
            } else if (closestBiggerPlayer.entity && closestBiggerPlayer.distance < this.avoidanceDistance + detectionRange2) {
                const deltaX = bot.x - closestBiggerPlayer.entity.x;
                const deltaY = bot.y - closestBiggerPlayer.entity.y;
                this.sendPosition(bot.x + deltaX, bot.y + deltaY);
            } else if (closestSmallerPlayer.entity && closestSmallerPlayer.entity.size <= bot.size * 0.83) {
                this.sendPosition(closestSmallerPlayer.entity.x, closestSmallerPlayer.entity.y);
            } else if (closestPellet.entity) {
                this.sendPosition(closestPellet.entity.x, closestPellet.entity.y);
            } else {
                const randomX = Math.floor(1337 * Math.random());
                const randomY = Math.floor(1337 * Math.random());
                this.sendPosition(bot.x + (Math.random() > 0.5 ? randomX : -randomX), bot.y + (Math.random() > 0.5 ? -randomY : randomY));
            }
        }
    }

    ejectVirusTowardsPlayer(virus, player) {
        const angle = Math.atan2(player.y - virus.y, player.x - virus.x);
        const moveX = virus.x + Math.cos(angle) * this.mapWidth;
        const moveY = virus.y + Math.sin(angle) * this.mapHeight;
        this.sendPosition(moveX, moveY);
    }

    setAvoidanceDistance(distance) {
        this.avoidanceDistance = distance;
    }

    setAvoidanceDistance2(distance) {
        this.avoidanceDistance2 = distance;
    }

    setBiggerPlayerAvoidanceRange(range) {
        this.biggerPlayerAvoidanceRange = range;
    }

    onError(error) {
        this.replace();
    }

    onClose(event) {
        this.isAlive = false;
        this.replace();
    }

    eject() {
        const averageSize = this.botCellsIDs.reduce((totalSize, cellId) => {
            const entity = this.viewportEntities[cellId];
            return entity ? totalSize + entity.size : totalSize;
        }, 0) / this.botCellsIDs.length;

        if (averageSize >= 80) {
            this.send(buffers.eject());
        }
    }

    split() {
        const averageSize = this.botCellsIDs.reduce((totalSize, cellId) => {
            const entity = this.viewportEntities[cellId];
            return entity ? totalSize + entity.size : totalSize;
        }, 0) / this.botCellsIDs.length;

        if (averageSize >= 80) {
            this.send(buffers.split());
        }
    }

    send(buffer) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            if (this.encryptionKey) {
                buffer = algorithm.rotateBufferBytes(buffer.buffer, this.encryptionKey);
                this.encryptionKey = algorithm.rotateEncryptionKey(this.encryptionKey);
            }
            this.ws.send(buffer);
        }
    }

    reconnect() {
        this.disconnect();
        this.connect();
    }
}

function disconnectBotsSlowly(bots, callback) {
    if (bots.length === 0) {
        console.log('\x1b[33m[Info] No bots to disconnect\x1b[0m');
        if (callback) callback();
        return;
    }

    const totalBots = bots.length;
    let disconnectedCount = 0;

    function disconnectNext() {
        if (bots.length > 0) {
            const bot = bots.shift();
            if (bot) {
                try {
                    bot.disconnect();
                    disconnectedCount++;
                } catch (error) {
                    console.error(`\x1b[31m[Error] Error disconnecting bot ${bot.id}: ${error}\x1b[0m`);
                }
            }
            setTimeout(disconnectNext, 4);
        } else {
            console.log(`\x1b[32m[Success] All bots disconnected: ${disconnectedCount}/${totalBots}\x1b[0m`);
            if (callback) callback();
        }
    }
    disconnectNext();
}

function handleExit(signal) {
    clearInterval(initInterval);
    clearInterval(botHealthCheckInterval);
    disconnectBotsSlowly(bots, () => process.exit(0));
}

process.on('uncaughtException', (err) => {
    console.error('\x1b[31m[Critical Error] Uncaught exception:', err, '\x1b[0m');
});

process.on('SIGINT', handleExit);
process.on("SIGTERM", handleExit);
process.on("beforeExit", handleExit);
process.on("exit", code => {
    console.log(`\x1b[35m[Exit] Process exiting with code ${code}: disconnecting bots...\x1b[0m`);
    clearInterval(initInterval);
    clearInterval(botHealthCheckInterval);
    disconnectBotsSlowly(bots);
});

const scriptKey = "key2";
const scriptVersion = 3;

function maintainBotCount() {
    const currentBotCount = bots.length;
    if (currentBotCount < maxBots) {
        const botsToAdd = maxBots - currentBotCount;
        for (let i = 0; i < botsToAdd; i++) {
            bots.push(new Bot(data.serverIP, currentBotCount + i + 1));
        }
    }
}

function checkBotsHealth() {
    bots.forEach((bot, index) => {
        if (!bot.isHealthy()) {
            bot.replace();
        }
    });
    maintainBotCount();
}

wsServer = new WebSocket.Server({ port: config.port });
showStartBanner();

wsServer.on('connection', (ws) => {
    if (currentClient) {
        console.log("\x1b[31m[Rejected] Connection attempt rejected: only one user allowed\x1b[0m");
        ws.send(JSON.stringify({ type: "error", message: "Only one user is allowed to connect at a time." }));
        ws.close();
        return;
    }

    currentClient = ws;
    console.log("\x1b[32m[Connection] User connected\x1b[0m");

    let botCountInterval = null;

    ws.on('close', () => {
        console.log("\x1b[33m[Disconnection] User disconnected\x1b[0m");
        currentClient = null;
        if (botHealthCheckInterval) clearInterval(botHealthCheckInterval);
        if (botCountInterval) clearInterval(botCountInterval);
        if (initInterval) clearInterval(initInterval);
        bots.forEach(bot => bot.disconnect());
        bots = [];
    });

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.type) {
                case 'start':
                    if (msg.config.scriptKey !== scriptKey || msg.config.scriptVersion !== scriptVersion) {
                        console.log("\x1b[31m[Auth Failed] Connection rejected: Invalid script key or version\x1b[0m");
                        ws.close();
                        return;
                    }

                    data.clientVersion = msg.config.clientVersion;
                    data.protocolVersion = msg.config.protocolVersion;
                    data.serverIP = msg.config.ip;

                    console.log('\x1b[36m\x1b[0m');
                    console.log(`\x1b[36m\x1b[33mServer:\x1b[37m ${msg.config.ip.padEnd(37)}\x1b[36m \x1b[0m`);
                    console.log(`\x1b[36m\x1b[33mClient Version:\x1b[37m ${msg.config.clientVersion.toString().padEnd(30)}\x1b[36m \x1b[0m`);
                    console.log(`\x1b[36m\x1b[33mProtocol Version:\x1b[37m ${msg.config.protocolVersion.toString().padEnd(27)}\x1b[36m \x1b[0m`);
                    console.log(`\x1b[36m\x1b[33mBots Mode:\x1b[37m ${config.useProxies ? 'Using Proxies' : 'Without Proxies'} ${' '.repeat(config.useProxies ? 23 : 21)}\x1b[36m \x1b[0m`);
                    console.log('\x1b[36m\x1b[0m');
                    console.log('\x1b[32m[Start] Starting bot connection...\x1b[0m');

                    let botIndex = 0;
                    initInterval = setInterval(() => {
                        if (botIndex < maxBots) {
                            bots.push(new Bot(data.serverIP, botIndex + 1));
                            botIndex++;
                        } else {
                            clearInterval(initInterval);
                            botHealthCheckInterval = setInterval(checkBotsHealth, BOT_HEALTH_CHECK_INTERVAL);
                        }
                    }, 168);

                    if (botCountInterval) clearInterval(botCountInterval);
                    botCountInterval = setInterval(() => {
                        const connectedBots = bots.filter(bot => bot.isHealthy()).length;
                        const aliveBots = bots.filter(bot => bot.isHealthy() && bot.isAlive).length;
                        ws.send(JSON.stringify({ type: "botCount", connected: connectedBots, alive: aliveBots }));
                    }, 600);
                    break;

                case 'stop':
                    if (initInterval) clearInterval(initInterval);
                    if (botCountInterval) clearInterval(botCountInterval);
                    if (botHealthCheckInterval) clearInterval(botHealthCheckInterval);

                    const botsToDisconnect = [...bots];
                    bots = [];
                    disconnectBotsSlowly(botsToDisconnect, () => {
                        data.followMouse = true;
                        data.vshield = false;
                        ws.send(JSON.stringify({ type: "stopped", status: "success" }));
                    });
                    break;

                case 'move':
                    data.x = msg.x;
                    data.y = msg.y;
                    break;

                case 'split':
                    bots.forEach(bot => bot.split());
                    break;

                case 'eject':
                    bots.forEach(bot => bot.eject());
                    break;

                case 'aiMode':
                    data.followMouse = !data.followMouse;
                    break;

                case 'updateBotName':
                    if (msg.botName) {
                        data.party = msg.botName;
                        bots.forEach(bot => {
                            bot.party = msg.botName;
                            bot.send(buffers.spawn(msg.botName));
                        });
                        ws.send(JSON.stringify({
                            type: "botNameUpdated",
                            success: true,
                            newBotName: msg.botName
                        }));
                    }
                    break;

                case 'updateBotAmount':
                    const botAmount = parseInt(msg.botAmount, 10);
                    if (!isNaN(botAmount) && botAmount >= 1) {
                        maxBots = botAmount;
                        console.log(`\x1b[34m[✓] Updated bot count: ${maxBots}\x1b[0m`);

                        if (bots.length > maxBots) {
                            const extraBots = bots.splice(maxBots);
                            extraBots.forEach(bot => bot.disconnect());
                        }

                        ws.send(JSON.stringify({
                            type: "botAmountUpdated",
                            success: true,
                            newBotCount: maxBots
                        }));
                    }
                    break;

                case 'vshield':
                    data.vshield = !data.vshield;
                    ws.send(JSON.stringify({
                        type: "vshieldUpdated",
                        enabled: data.vshield
                    }));
                    break;
            }
        } catch (error) {
            console.error("Error processing message:", error);
        }
    });
});
