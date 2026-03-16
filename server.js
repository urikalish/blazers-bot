import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { Telegraf } from 'telegraf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadEnvVars() {
    const ENV_PATH = resolve(__dirname, '.env');
    const envLoadResult = loadEnv({path: ENV_PATH});
    if (envLoadResult.error && envLoadResult.error.code !== 'ENOENT') {
        throw new Error(
            `[config] Failed to load .env file at ${ENV_PATH}: ${envLoadResult.error.message}`,
        );
    }
    const parsedEnv = envLoadResult.parsed ?? {};
    const ENV = {
        BOT_TOKEN_KEY: 'BOT_TOKEN',
        CHAT_ID_KEY: 'CHAT_ID'
    };
    if (process.env[ENV.BOT_TOKEN_KEY] === undefined && parsedEnv[ENV.BOT_TOKEN_KEY] === undefined) {
        throw new Error(
            `[config] Missing ${ENV.BOT_TOKEN_KEY}. Set it in environment variables (CI) or .env (${ENV_PATH}).`,
        );
    }
    const botToken = process.env[ENV.BOT_TOKEN_KEY] ?? parsedEnv[ENV.BOT_TOKEN_KEY];
    if (process.env[ENV.CHAT_ID_KEY] === undefined && parsedEnv[ENV.CHAT_ID_KEY] === undefined) {
        throw new Error(
            `[config] Missing ${ENV.CHAT_ID_KEY}. Set it in environment variables (CI) or .env (${ENV_PATH}).`,
        );
    }
    const chatId = process.env[ENV.CHAT_ID_KEY] ?? parsedEnv[ENV.CHAT_ID_KEY];
    return  {
        botToken,
        chatId
    };
}

function initBot(botToken) {
    console.log(`Bot initializing...`);
    const bot = new Telegraf(botToken);
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    console.log(`Bot initialized.`);
    return bot;
}

function readDataObjectFromFile(dirPath, fileName) {
    let dataObject = null;
    const fullFilePath = `${dirPath}/${fileName}`;
    try {
        const outDir = resolve(__dirname, dirPath);
        const raw = readFileSync(resolve(outDir, fileName), 'utf8');
        dataObject = JSON.parse(raw);
    } catch (error) {
        console.warn(`Error while trying to read from ${fullFilePath}`, error);
    }
    return dataObject;
}

function getRunMode() {
    const mode = (process.argv[2] || 'all').toLowerCase();
    const allowedModes = new Set(['all', 'players', 'game']);
    if (!allowedModes.has(mode)) {
        throw new Error(`Invalid mode "${mode}". Use: all | players | game`);
    }
    return mode;
}

function writeDataObjectToFile(dataObject, dirPath, fileName) {
    const fullFilePath = `${dirPath}/${fileName}`;
    console.log(`Writing to ${fullFilePath}...`);
    try {
        const outDir = resolve(__dirname, dirPath);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(resolve(outDir, fileName), JSON.stringify(dataObject, null, 2));
        console.log(`File ${fullFilePath} updated.`);
        return true;
    } catch (error) {
        console.error(`Error while trying to write to ${fullFilePath}`, error);
        return false;
    }
}


function getTimeRemaining(futureDate) {
    const now = new Date();
    const differenceMs = futureDate - now;
    if (differenceMs <= 0) {
        return { days: 0, hours: 0, minutes: 0 };
    }
    const days = Math.floor(differenceMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((differenceMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((differenceMs % (1000 * 60 * 60)) / (1000 * 60));
    return { days, hours, minutes };
}

function getIsraelTimeStr(utcDate) {
    const options = {
        timeZone: "Asia/Jerusalem",
        weekday: "long",    // "Thursday"
        day: "2-digit",      // "05"
        month: "2-digit",    // "03"
        year: "2-digit",     // "26"
        hour: "2-digit",     // "03"
        minute: "2-digit",   // "00"
        hour12: false        // 24-hour format
    };
    return utcDate.toLocaleString('en-GB', options);
}

const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchNextGameInfo(teamAbbr = 'por') {
    const gameInfo = {
        id: '',
        name: '',
        israelTimeStr: '',
        utcDateTime: null,
        leftDays: 0,
        leftHours: 0,
        leftMinutes: 0,
        msg: ''
    };
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamAbbr}/schedule`;
    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            console.error(`Error fetching next game info`, response.status, response.statusText);
            return gameInfo;
        }
        const data = await response.json();
        const upcomingGames = data.events?.filter(event =>
            event?.competitions?.[0]?.status?.type?.completed === false
        ) ?? [];
        const nextGame = upcomingGames[0];
        if (nextGame) {
            gameInfo.id = nextGame.id;
            gameInfo.name = nextGame.name;
            gameInfo.utcDateTime = new Date(nextGame.date);
            gameInfo.israelTimeStr = getIsraelTimeStr(gameInfo.utcDateTime);
            const timeRemaining = getTimeRemaining(gameInfo.utcDateTime);
            gameInfo.leftDays = timeRemaining.days;
            gameInfo.leftHours = timeRemaining.hours;
            gameInfo.leftMinutes = timeRemaining.minutes;
            let timeLeftStr = '';
            if (gameInfo.leftDays > 0) {
                timeLeftStr = `${gameInfo.leftDays} day(s) and ${gameInfo.leftHours} hour(s)`;
            } else if (gameInfo.leftHours > 0) {
                timeLeftStr = `${gameInfo.leftHours} hour(s) and ${gameInfo.leftMinutes} minute(s)`;
            } else if (gameInfo.leftMinutes > 0) {
                timeLeftStr = `${gameInfo.leftMinutes} minute(s)`;
            }
            gameInfo.msg = `${gameInfo.name}\n${gameInfo.israelTimeStr}${timeLeftStr ? '\nin ' + timeLeftStr : ''}`;
        } else {
            console.warn(`No upcoming games found for team ${teamAbbr}`);
        }
    } catch (error) {
        console.error(`Error processing next game info`, error);
    }
    return gameInfo;
}

async function fetchPlayerStatusStr(playerId) {
    let statusStr = null;
    try {
        const url = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}`;
        const response = await fetchWithTimeout(url);
        if (response.ok) {
            const json = await response.json();
            const injuries = json.athlete?.injuries;
            if (injuries && injuries.length > 0) {
                const status = injuries[0]?.details?.fantasyStatus?.description;
                if (typeof status === 'string' && status.trim() !== '') {
                    statusStr = status;
                } else {
                    console.warn(`Player status payload missing/invalid for playerId=${playerId}`);
                }
            } else {
                statusStr = `ACT`;
            }
        } else {
            console.error(`Error fetching player status`, response.status, response.statusText);
        }
    } catch (error) {
        console.error(`Error processing player status`, error);
    }
    return statusStr;
}

async function handleNextGameInfo(bot, chatId) {
    console.log(`Handling next game info...`);
    const TEAM_ABBR = 'por';
    const nextGameInfo = await fetchNextGameInfo(TEAM_ABBR);
    const lastGame = readDataObjectFromFile('.', 'last-game.json');
    const lastGameId = lastGame?.id ?? null;
    const isNewGame = !!nextGameInfo.id && nextGameInfo.id !== lastGameId;

    if (isNewGame) {
        console.log(`New game detected (id=${nextGameInfo.id}). Persisting to last-game.json...`);
        writeDataObjectToFile({ id: nextGameInfo.id }, '.', 'last-game.json');
    }

    let timeLeftStr = '';
    if (nextGameInfo.leftDays > 0) {
        timeLeftStr = `${nextGameInfo.leftDays} day(s) and ${nextGameInfo.leftHours} hour(s)`;
    } else if (nextGameInfo.leftHours > 0) {
        timeLeftStr = `${nextGameInfo.leftHours} hour(s) and ${nextGameInfo.leftMinutes} minute(s)`;
    } else if (nextGameInfo.leftMinutes > 0) {
        timeLeftStr = `${nextGameInfo.leftMinutes} minute(s)`;
    }
    const dateAndTimeStr = nextGameInfo.israelTimeStr
        ? `${nextGameInfo.israelTimeStr}${timeLeftStr ? '\nin ' + timeLeftStr : ''}`
        : null;
    const newGameInfoStr = nextGameInfo.name && dateAndTimeStr
        ? `${nextGameInfo.name}\n${dateAndTimeStr}`
        : (nextGameInfo.msg || `N/A`);
    const existingGameInfoStr = dateAndTimeStr || `N/A`;
    const nextGameInfoStr = isNewGame ? newGameInfoStr : existingGameInfoStr;
    let msg = `Next Game: ${nextGameInfoStr}`;
    console.log(msg);

    const isGameInProgress = !!nextGameInfo.utcDateTime && nextGameInfo.leftDays <= 0 && nextGameInfo.leftHours <= 0 && nextGameInfo.leftMinutes <= 0;
    const isGameSoon = !!nextGameInfo.utcDateTime && !isGameInProgress && nextGameInfo.leftDays <= 0 && nextGameInfo.leftHours <= 12;
    if (isGameInProgress) {
        msg = `Game is currently in progress.`;
        console.log(msg);
        await bot.telegram.sendMessage(chatId, msg).catch(console.error);
    } else if (isGameSoon || isNewGame) {
        if (isNewGame) {
            console.log(`Reporting new game to Telegram...`);
        } else {
            console.log(`Game is soon. Reporting to Telegram...`);
        }
        await bot.telegram.sendMessage(chatId, msg).catch(console.error);
        console.log(`Reported to Telegram.`);
    } else {
        console.log(`Skip reporting to Telegram.`);
    }
}

async function handlePlayersStatusChanges(bot, chatId) {
    console.log(`Handling player status changes...`);
    const lastPlayersStatus = readDataObjectFromFile('.', 'last-players-status.json');
    if (!Array.isArray(lastPlayersStatus) || lastPlayersStatus.length === 0) {
        console.log(`No players found in last-players-status.json. Skip handling player statuses.`);
        return;
    }

    const resolvedPlayers = await Promise.all(
        lastPlayersStatus.map(async (player) => {
            const playerId = player?.id;
            if (playerId === undefined || playerId === null) {
                console.warn(`Skipping player entry without id`, player);
                return {
                    sourcePlayer: player,
                    playerId: null,
                    shirt: player?.shirt || `N/A`,
                    name: player?.name || `Unknown Player`,
                    oldStatus: player?.status || `N/A`,
                    status: player?.status || `N/A`,
                    changed: false,
                };
            }

            const playerName = player?.name || `Player ${playerId}`;
            const lastStatus = player?.status || `N/A`;
            const fetchedStatus = await fetchPlayerStatusStr(playerId);
            const playerStatusStr = fetchedStatus ?? lastStatus;
            return {
                sourcePlayer: player,
                playerId,
                shirt: player?.shirt || `N/A`,
                name: playerName,
                oldStatus: lastStatus,
                status: playerStatusStr,
                changed: lastStatus !== playerStatusStr,
            };
        })
    );

    const updatedPlayers = [];
    const changedPlayers = [];

    for (const player of resolvedPlayers) {
        if (player.playerId !== null) {
            console.log(`${player.name} (${player.playerId}) status: ${player.status}`);
        }

        if (player.changed) {
            console.log(`Player status changed for ${player.name} from ${player.oldStatus} to ${player.status}`);
            changedPlayers.push({
                playerId: player.playerId,
                shirt: player.shirt,
                name: player.name,
                oldStatus: player.oldStatus,
                newStatus: player.status,
            });
        } else {
            console.log(`Player status did not change for ${player.name}. Last known status: ${player.oldStatus}`);
        }

        updatedPlayers.push({
            ...player.sourcePlayer,
            status: player.status,
        });
    }

    const writeSucceeded = writeDataObjectToFile(updatedPlayers, '.', 'last-players-status.json');
    if (!writeSucceeded) {
        console.error(`Skip reporting to Telegram because state persistence failed.`);
        return;
    }

    if (changedPlayers.length > 0) {
        const msg = changedPlayers
            .map(({ name, oldStatus, newStatus }) => `${name}: ${oldStatus} -> ${newStatus}`)
            .join('\n');
        console.log(`Reporting to Telegram...`);
        await bot.telegram.sendMessage(chatId, msg).catch(console.error);
        console.log(`Reported to Telegram.`);
    } else {
        console.log(`Skip reporting to Telegram. No player status changes detected.`);
    }
}

async function go() {
    console.log(`GO!`);
    const {botToken, chatId} = loadEnvVars();
    const bot = initBot(botToken);
    const runMode = getRunMode();
    if (runMode === 'all' || runMode === 'game') {
        await handleNextGameInfo(bot, chatId);
    }
    if (runMode === 'all' || runMode === 'players') {
        await handlePlayersStatusChanges(bot, chatId);
    }
    console.log(`DONE.`);
}

go().catch(console.error);
