import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { Telegraf } from 'telegraf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LAST_GAME_INFO_FILE = 'last-game-info.json';
const LAST_PLAYERS_STATUS_FILE = 'last-players-status.json';

function loadEnvVars() {
    const ENV_PATH = resolve(__dirname, '.env');
    const envLoadResult = loadEnv({path: ENV_PATH});
    if (envLoadResult.error && envLoadResult.error.code !== 'ENOENT') {
        throw new Error(
            `[config] Failed to load .env file at ${ENV_PATH}: ${envLoadResult.error.message}`,
        );
    }
    const parsedEnv = envLoadResult.parsed ?? {};
    const requireEnvVar = (key) => {
        const value = process.env[key] ?? parsedEnv[key];
        if (typeof value !== 'string' || value.trim() === '') {
            throw new Error(
                `[config] Missing or empty ${key}. Set it in environment variables (CI) or .env (${ENV_PATH}).`,
            );
        }
        return value.trim();
    };
    return {
        botToken: requireEnvVar('BOT_TOKEN'),
        chatId: requireEnvVar('CHAT_ID'),
    }
}

function initBot(botToken) {
    console.log(`Bot initializing...`);
    const bot = new Telegraf(botToken);
    console.log(`Bot initialized.`);
    return bot;
}

async function sendTelegramMessage(bot, chatId, msg) {
    try {
        await bot.telegram.sendMessage(chatId, msg);
        console.log(`Reported to Telegram.`);
        return true;
    } catch (error) {
        console.error(`Error while trying to send a Telegram message`, error);
        return false;
    }
}

function readDataObjectFromFile(fileName) {
    const fullFilePath = resolve(__dirname, fileName);
    try {
        return JSON.parse(readFileSync(fullFilePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            console.log(`File ${fullFilePath} does not exist yet.`);
        } else {
            console.warn(`Error while trying to read from ${fullFilePath}`, error);
        }
        return null;
    }
}

function getRunMode() {
    const mode = (process.argv[2] || 'all').toLowerCase();
    const allowedModes = new Set(['all', 'players', 'game']);
    if (!allowedModes.has(mode)) {
        throw new Error(`Invalid mode "${mode}". Use: all | players | game`);
    }
    return mode;
}

function writeDataObjectToFile(dataObject, fileName) {
    const fullFilePath = resolve(__dirname, fileName);
    console.log(`Writing to ${fullFilePath}...`);
    try {
        writeFileSync(fullFilePath, JSON.stringify(dataObject, null, 2));
        console.log(`File ${fullFilePath} updated.`);
        return true;
    } catch (error) {
        console.error(`Error while trying to write to ${fullFilePath}`, error);
        return false;
    }
}

function getTimeRemaining(futureDate) {
    const now = new Date();
    const differenceMs = futureDate.getTime() - now.getTime();
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
const GAME_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

function getIsGameInProgress(event, utcDateTime) {
    const state = event?.competitions?.[0]?.status?.type?.state;
    if (state === 'in') {
        return true;
    }
    if (state === 'pre' || state === 'post') {
        return false;
    }
    if (!utcDateTime) {
        return false;
    }
    const elapsedMs = Date.now() - utcDateTime.getTime();
    return elapsedMs >= 0 && elapsedMs < GAME_MAX_DURATION_MS;
}

async function fetchNextGameInfo(teamAbbr = 'por', seasonType = '2') {
    const gameInfo = {
        id: '',
        name: '',
        israelTimeStr: '',
        utcDateTime: null,
        isInProgress: false,
        hasError: false,
        leftDays: 0,
        leftHours: 0,
        leftMinutes: 0,
        dateAndTimeStr: ''
    };
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamAbbr}/schedule?seasontype=${seasonType}`;
    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            console.error(`Error fetching next game info`, response.status, response.statusText);
            gameInfo.hasError = true;
            return gameInfo;
        }
        const data = await response.json();
        const upcomingGames = (data.events ?? [])
            .filter(event =>
                event?.competitions?.[0]?.status?.type?.completed === false &&
                !Number.isNaN(new Date(event?.date).getTime())
            )
            .sort((a, b) => new Date(a.date) - new Date(b.date));
        const nextGame = upcomingGames[0];
        if (nextGame) {
            gameInfo.id = nextGame.id;
            gameInfo.name = nextGame.name;
            gameInfo.utcDateTime = new Date(nextGame.date);
            gameInfo.israelTimeStr = getIsraelTimeStr(gameInfo.utcDateTime);
            gameInfo.isInProgress = getIsGameInProgress(nextGame, gameInfo.utcDateTime);
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
            gameInfo.dateAndTimeStr = `${gameInfo.israelTimeStr}${timeLeftStr ? '\nin ' + timeLeftStr : ''}`;
        } else {
            console.warn(`No upcoming games found for team ${teamAbbr}`);
        }
    } catch (error) {
        console.error(`Error processing next game info`, error);
        gameInfo.hasError = true;
    }
    return gameInfo;
}

// Fallback vocabulary used only when ESPN omits details.fantasyStatus; unknown values are treated as unparsable rather than guessed.
const INJURY_STATUS_ABBR = {
    'active': 'ACT',
    'day-to-day': 'DTD',
    'game-time decision': 'GTD',
    'out': 'OUT',
    'out for season': 'OFS',
    'suspension': 'SSPD',
};

function resolveInjuryStatusStr(injury, playerId) {
    const fantasyStatus = injury?.details?.fantasyStatus?.description;
    if (typeof fantasyStatus === 'string' && fantasyStatus.trim() !== '') {
        return fantasyStatus.trim();
    }
    const rawStatus = injury?.status ?? injury?.type?.description;
    if (typeof rawStatus === 'string' && rawStatus.trim() !== '') {
        const abbr = INJURY_STATUS_ABBR[rawStatus.trim().toLowerCase()];
        if (abbr) {
            return abbr;
        }
        console.warn(`Unrecognized player status "${rawStatus}" for playerId=${playerId}`);
        return null;
    }
    console.warn(`Player status payload missing/invalid for playerId=${playerId}`);
    return null;
}

async function fetchPlayerStatus(playerId) {
    try {
        const url = `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}`;
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            console.error(`Error fetching player status`, response.status, response.statusText);
            return { status: null, hasError: true };
        }
        const json = await response.json();
        const injuries = json.athlete?.injuries;
        if (!injuries || injuries.length === 0) {
            return { status: `ACT`, hasError: false };
        }
        const status = resolveInjuryStatusStr(injuries[0], playerId);
        return { status, hasError: status === null };
    } catch (error) {
        console.error(`Error processing player status`, error);
        return { status: null, hasError: true };
    }
}

async function handleNextGameInfo(bot, chatId) {
    console.log(`Handling next game info...`);
    const TEAM_ABBR = 'por';
    const SEASON_TYPE = '1'; //pre = 1, regular = 2, post = 3
    const nextGameInfo = await fetchNextGameInfo(TEAM_ABBR, SEASON_TYPE);
    if (nextGameInfo.hasError) {
        console.error(`Skip handling next game info because the schedule could not be fetched.`);
        return false;
    }
    const lastGame = readDataObjectFromFile(LAST_GAME_INFO_FILE);
    const lastGameId = lastGame?.id === undefined || lastGame?.id === null ? null : String(lastGame.id);
    const nextGameId = nextGameInfo.id ? String(nextGameInfo.id) : '';
    const isNewGame = !!nextGameId && nextGameId !== lastGameId;

    const dateAndTimeStr = nextGameInfo.dateAndTimeStr || 'N/A';
    const isGameInProgress = nextGameInfo.isInProgress;
    const hasNotStarted = !!nextGameInfo.utcDateTime && nextGameInfo.utcDateTime.getTime() > Date.now();
    const isGameSoon = !isGameInProgress && hasNotStarted && nextGameInfo.leftDays <= 0 && nextGameInfo.leftHours < 12;
    const msg = isGameInProgress
        ? (isNewGame
            ? `${nextGameInfo.name}\n${dateAndTimeStr}\nGame is currently in progress.`
            : `Game is currently in progress.`)
        : (isNewGame ? `${nextGameInfo.name}\n${dateAndTimeStr}` : dateAndTimeStr);

    if (!isGameInProgress && !isGameSoon && !isNewGame) {
        console.log(`Skip reporting to Telegram.`);
        return true;
    }
    console.log(msg);

    if (isNewGame) {
        console.log(`New game detected (id=${nextGameId}). Reporting to Telegram...`);
    } else {
        console.log(`Game is ${isGameInProgress ? 'in progress' : 'soon'}. Reporting to Telegram...`);
    }
    const sent = await sendTelegramMessage(bot, chatId, msg);

    if (!isNewGame) {
        return sent;
    }
    if (!sent) {
        console.error(`Skip persisting new game id so it is reported again on the next run.`);
        return false;
    }
    console.log(`Persisting new game id to ${LAST_GAME_INFO_FILE}...`);
    if (!writeDataObjectToFile({ id: nextGameId }, LAST_GAME_INFO_FILE)) {
        console.error(`Failed to persist the new game id. It will be reported again on the next run.`);
        return false;
    }
    return true;
}

async function handlePlayersStatusChanges(bot, chatId) {
    console.log(`Handling player status changes...`);
    const lastPlayersStatus = readDataObjectFromFile(LAST_PLAYERS_STATUS_FILE);
    if (!Array.isArray(lastPlayersStatus) || lastPlayersStatus.length === 0) {
        console.log(`No players found in ${LAST_PLAYERS_STATUS_FILE}. Skip handling player statuses.`);
        return true;
    }

    const resolvedPlayers = await Promise.all(
        lastPlayersStatus.map(async (player) => {
            const playerId = player?.id ?? null;
            const lastStatus = player?.status || `N/A`;
            const base = {
                sourcePlayer: player,
                playerId,
                name: player?.name || (playerId === null ? `Unknown player` : `Player ${playerId}`),
                oldStatus: lastStatus,
                status: lastStatus,
                changed: false,
                hasError: false,
            };

            if (playerId === null) {
                console.warn(`Skipping player entry without id`, player);
                return base;
            }

            const { status: fetchedStatus, hasError } = await fetchPlayerStatus(playerId);
            const playerStatusStr = fetchedStatus ?? lastStatus;
            return {
                ...base,
                status: playerStatusStr,
                changed: lastStatus !== playerStatusStr,
                hasError,
            };
        })
    );

    const changedPlayers = [];
    let failedFetchCount = 0;
    let invalidEntryCount = 0;

    for (const player of resolvedPlayers) {
        console.log(`${player.name} (${player.playerId ?? 'no id'}) status: ${player.status}`);

        if (player.playerId === null) {
            invalidEntryCount++;
        } else if (player.hasError) {
            failedFetchCount++;
        }

        if (player.changed) {
            console.log(`Player status changed for ${player.name} from ${player.oldStatus} to ${player.status}`);
            changedPlayers.push({
                name: player.name,
                oldStatus: player.oldStatus,
                newStatus: player.status,
            });
        } else {
            console.log(`Player status did not change for ${player.name}. Last known status: ${player.oldStatus}`);
        }
    }

    if (invalidEntryCount > 0) {
        console.error(`${invalidEntryCount} entry/entries in ${LAST_PLAYERS_STATUS_FILE} have no id and were never refreshed. Fix the file.`);
    }
    if (failedFetchCount > 0) {
        console.error(`Could not fetch a valid status for ${failedFetchCount} player(s). Their last known status was kept.`);
    }

    if (changedPlayers.length === 0) {
        console.log(`Skip reporting to Telegram. No player status changes detected.`);
        return true;
    }

    const msg = changedPlayers
        .map(({ name, oldStatus, newStatus }) => `${name}: ${oldStatus} -> ${newStatus}`)
        .join('\n');
    console.log(`Reporting to Telegram...`);
    const sent = await sendTelegramMessage(bot, chatId, msg);
    if (!sent) {
        console.error(`Skip persisting player statuses so the changes are reported again on the next run.`);
        return false;
    }

    const updatedPlayers = resolvedPlayers.map((player) => ({
        ...player.sourcePlayer,
        status: player.status,
    }));
    if (!writeDataObjectToFile(updatedPlayers, LAST_PLAYERS_STATUS_FILE)) {
        console.error(`Failed to persist player statuses. The same changes will be reported again on the next run.`);
        return false;
    }
    return true;
}

async function go() {
    console.log(`GO!`);
    const runMode = getRunMode();
    const {botToken, chatId} = loadEnvVars();
    const bot = initBot(botToken);
    let succeeded = true;
    if (runMode === 'all' || runMode === 'game') {
        succeeded = await handleNextGameInfo(bot, chatId) && succeeded;
    }
    if (runMode === 'all' || runMode === 'players') {
        succeeded = await handlePlayersStatusChanges(bot, chatId) && succeeded;
    }
    console.log(`DONE.`);
    if (!succeeded) {
        process.exitCode = 1;
    }
}

go().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
