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
    } catch {
        console.warn(`Error while trying to read from ${fullFilePath}`, error);
    }
    return dataObject;
}

function writeDataObjectToFile(dataObject, dirPath, fileName) {
    const fullFilePath = `${dirPath}/${fileName}`;
    console.log(`Writing to ${fullFilePath}...`);
    try {
        const outDir = resolve(__dirname, dirPath);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(resolve(outDir, fileName), JSON.stringify(dataObject, null, 2));
        console.log(`File ${fullFilePath} updated.`);
    } catch (error) {
        console.error(`Error while trying to write to ${fullFilePath}`, error);
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

async function fetchNextGameInfo(teamAbbr = 'por') {
    const gameInfo = {
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
        const response = await fetch(url);
        const data = await response.json();
        const upcomingGames = data.events?.filter(event =>
            event?.competitions?.[0]?.status?.type?.completed === false
        );
        const nextGame = upcomingGames[0];
        if (nextGame) {
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
    let stausStr= '';
    try {
        const url = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}`;
        const response = await fetch(url);
        if (response.ok) {
            const json = await response.json();
            const injuries = json.athlete?.injuries;
            if (injuries && injuries.length > 0) {
                const status = injuries[0]?.details?.fantasyStatus?.description;
                if (status) {
                    stausStr = status;
                }
            } else {
                stausStr = `ACT`;
            }
        } else {
            console.error(`Error fetching player status`, response.error);
        }
    } catch (error) {
        console.error(`Error processing player status`, error);
    }
    return stausStr;
}

async function handleNextGameInfo(bot, chatId) {
    console.log(`Handling next game info...`);
    const TEAM_ABBR = 'por';
    const nextGameInfo = await fetchNextGameInfo(TEAM_ABBR);
    const nextGameInfoStr = nextGameInfo.msg || `N/A`;
    const msg = `Next Game: ${nextGameInfoStr}`;
    console.log(msg);
    const isGameInProgress = nextGameInfo.leftDays <= 0 && nextGameInfo.leftHours <= 0 && nextGameInfo.leftMinutes <= 0;
    if (isGameInProgress) {
        console.log(`Game is currently in progress.`);
    }
    const isGameSoon = !isGameInProgress && nextGameInfo.leftDays <= 0 && nextGameInfo.leftHours <= 12;
    if (isGameSoon) {
        console.log(`Game is soon.`);
    }
    if (!isGameInProgress && isGameSoon) {
        console.log(`Reporting to Telegram...`);
        bot.telegram.sendMessage(chatId, msg).catch(console.error);
        console.log(`Reported to Telegram.`);
    } else {
        console.log(`Skip reporting to Telegram.`);
    }
}

async function handlePlayersStatusChanges(bot, chatId) {
    console.log(`Handling player status changes...`);
    const playersLastStatus = readDataObjectFromFile('.', 'players-last-status.json');
    if (!Array.isArray(playersLastStatus) || playersLastStatus.length === 0) {
        console.log(`No players found in players-last-status.json. Skip handling player statuses.`);
        return;
    }

    const validPlayers = playersLastStatus.filter((player) => {
        const playerId = player?.playerId;
        if (playerId === undefined || playerId === null) {
            console.warn(`Skipping player entry without playerId`, player);
            return false;
        }
        return true;
    });

    const resolvedPlayers = await Promise.all(
        validPlayers.map(async (player) => {
            const playerId = player.playerId;
            const playerName = player?.name || `Player ${playerId}`;
            const lastStatus = player?.status || `N/A`;
            const playerStatusStr = await fetchPlayerStatusStr(playerId) || `N/A`;
            return {
                sourcePlayer: player,
                playerId,
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
        console.log(`${player.name} (${player.playerId}) status: ${player.status}`);

        if (player.changed) {
            console.log(`Player status changed for ${player.name} from ${player.oldStatus} to ${player.status}`);
            changedPlayers.push({
                playerId: player.playerId,
                name: player.name,
                oldStatus: player.oldStatus,
                newStatus: player.status,
            });
        } else {
            console.log(`Player status did not change for ${player.name}. Last known status: ${player.oldStatus}`);
        }

        updatedPlayers.push({
            ...player.sourcePlayer,
            playerId: player.playerId,
            name: player.name,
            status: player.status,
        });
    }

    writeDataObjectToFile(updatedPlayers, '.', 'players-last-status.json');

    if (changedPlayers.length > 0) {
        const msg = changedPlayers
            .map(({ name, oldStatus, newStatus }) => `${name}: ${oldStatus} -> ${newStatus}`)
            .join('\n');
        console.log(`Reporting to Telegram...`);
        bot.telegram.sendMessage(chatId, msg).catch(console.error);
        console.log(`Reported to Telegram.`);
    } else {
        console.log(`Skip reporting to Telegram. No player status changes detected.`);
    }
}

async function go() {
    console.log(`GO!`);
    const {botToken, chatId} = loadEnvVars();
    const bot = initBot(botToken);
    await handleNextGameInfo(bot, chatId);
    await handlePlayersStatusChanges(bot, chatId);
    console.log(`DONE.`);
}

go().catch(console.error);
