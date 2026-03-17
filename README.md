# Blazers Bot

A Node.js Telegram bot that monitors the **Portland Trail Blazers** NBA team and sends automated alerts about upcoming games and player status changes.

---

## Overview

The bot does two things when run:

1. **Game Alert** – Checks when the next Blazers game is and sends a Telegram message if the game is currently in progress or starting within 12 hours.
2. **Player Status Alert** – Fetches the current injury/availability status for each tracked player, compares it to the last known status, and sends a Telegram message whenever a player's status changes.

---

## Tech Stack

- **Node.js** (ES modules) — Node 18+ recommended for built-in `fetch`
- **[Telegraf](https://telegraf.js.org/)** – Telegram Bot API framework
- **[dotenv](https://github.com/motdotla/dotenv)** – Loads environment variables from `.env`
- Built-in `fetch` + `AbortController` for HTTP requests

---

## Project Structure

```
blazers-bot/
├── server.js                  # Main application logic (startup, API calls, message decisions, persistence)
├── last-players-status.json   # Persisted player status state
├── last-game-info.json        # Persisted last known next-game ID (auto-created on first run)
├── package.json               # Dependencies and npm scripts
└── .env                       # Secret credentials (not committed)
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root with the following variables:

```env
BOT_TOKEN=<your_telegram_bot_token>
CHAT_ID=<target_chat_id>
```

Alternatively, these can be set as environment variables directly (e.g. in a CI/CD pipeline).

| Variable    | Description                                                                   |
|-------------|-------------------------------------------------------------------------------|
| `BOT_TOKEN` | Telegram bot token from [@BotFather](https://t.me/BotFather)                 |
| `CHAT_ID`   | Target Telegram chat/group ID to send messages to                            |

If either variable is missing, startup fails with a clear error from `loadEnvVars()`.

---

## Usage

```bash
# Run both game check and player status check (default)
npm start

# Or directly with mode selection
node server.js          # defaults to "all"
node server.js game     # only game check
node server.js players  # only player status check
```

### Run Modes

`getRunMode()` reads the CLI argument and supports exactly these modes:

| Mode      | Description                                         |
|-----------|-----------------------------------------------------|
| `all`     | Runs both game and player status checks (default)   |
| `game`    | Only checks and reports the next game               |
| `players` | Only checks and reports player status changes       |

Any other mode throws: `Invalid mode "<mode>". Use: all | players | game`

---

## Execution Flow

`go()` is the entrypoint:

1. Load environment variables (`loadEnvVars`)
2. Initialize Telegram bot (`initBot`)
3. Resolve run mode (`getRunMode`)
4. Execute selected handlers:
   - `handleNextGameInfo(bot, chatId)`
   - `handlePlayersStatusChanges(bot, chatId)`
5. Log completion

---

## How It Works

### Game Check (`handleNextGameInfo`)

1. Fetches the Blazers schedule from the ESPN API:  
   `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/por/schedule`
2. Selects the first upcoming event where the game is not completed.
3. Builds a `gameInfo` object with the game ID, name, UTC date, formatted Israel-local time string, time remaining (days/hours/minutes), and a formatted message.
4. Compares the game's ID against the one persisted in `last-game-info.json`.  
   - If the ID is different (or the file doesn't exist yet), the game is considered **new** and the ID is saved to `last-game-info.json`.
5. Sends a Telegram message in these cases:
   - **Game in progress** – tip-off time has already passed.
   - **Game is soon** – less than 12 hours until tip-off.
   - **New game** – first time this game has been retrieved, regardless of how far away it is.
6. Otherwise, skips silently.

**Example Telegram message:**
```
Next Game: Portland Trail Blazers vs Golden State Warriors
Thursday, 17/03/26, 03:00
in 4 hour(s) and 30 minute(s)
```

---

### Player Status Check (`handlePlayersStatusChanges`)

1. Reads the tracked player list from `last-players-status.json`.
2. For each player, fetches their current status in parallel (`Promise.all`) from the ESPN athlete API:  
   `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{playerId}`
   - If injury data exists, reads `injuries[0].details.fantasyStatus.description`.
   - If no injuries are listed, defaults to `ACT`.
   - Returns `null` on request/processing errors (falls back to the previous status).
3. Compares the fetched status to the last known status.
4. Writes the updated statuses back to `last-players-status.json`.
5. If any player's status changed, sends a Telegram message listing all changes.

**Example Telegram message:**
```
D. Avdija: ACT -> GTD
J. Grant: OUT -> ACT
```

> **Note:** If writing the updated state to `last-players-status.json` fails, the bot skips sending the Telegram message to avoid reporting stale changes on the next run.

---

## `last-players-status.json` Format

This file tracks the last known status for each player. Edit it to add or remove players.

```json
[
  {
    "id": 4683021,
    "shirt": "8",
    "name": "D. Avdija",
    "status": "ACT"
  }
]
```

| Field    | Type     | Description                                          |
|----------|----------|------------------------------------------------------|
| `id`     | `number` | ESPN athlete ID (required for API lookups)           |
| `shirt`  | `string` | Jersey number (for reference only)                   |
| `name`   | `string` | Player display name                                  |
| `status` | `string` | Last known status (e.g. `ACT`, `OUT`, `GTD`)        |

Keep this file as valid JSON and ensure every entry includes an `id`.

---

## Key Functions

| Function                                  | Description                                                                 |
|-------------------------------------------|-----------------------------------------------------------------------------|
| `loadEnvVars()`                           | Loads and validates `BOT_TOKEN` and `CHAT_ID` from env or `.env`           |
| `initBot(botToken)`                       | Creates and configures the Telegraf bot instance                            |
| `fetchNextGameInfo(teamAbbr)`             | Fetches next game data from ESPN and builds a summary object                |
| `fetchPlayerStatusStr(playerId)`          | Fetches a single player's current injury/availability status from ESPN      |
| `handleNextGameInfo(bot, chatId)`         | Orchestrates the game check and conditionally sends a Telegram alert        |
| `handlePlayersStatusChanges(bot, chatId)` | Orchestrates the player status check and sends change alerts                |
| `getTimeRemaining(futureDate)`            | Returns days/hours/minutes until a future date                              |
| `getIsraelTimeStr(utcDate)`               | Formats a UTC date as a human-readable string in the `Asia/Jerusalem` timezone |
| `getRunMode()`                            | Reads the CLI argument to determine which checks to run                     |
| `writeDataObjectToFile()`                 | Persists a JSON object to a file                                            |
| `readDataObjectFromFile()`                | Reads and parses a JSON file                                                |
| `fetchWithTimeout(url)`                   | Wraps `fetch` with an `AbortController` timeout (default 10 s)             |

---

## Time & Formatting Notes

- `getIsraelTimeStr()` renders game time in the `Asia/Jerusalem` timezone via `toLocaleString('en-GB', ...)`.
- `getTimeRemaining()` computes remaining days, hours, and minutes until game start.

---

## Error Handling

The code catches and logs errors around:

- Environment loading
- Network / API calls
- JSON parsing
- File read / write
- Telegram send operations (`.catch(console.error)`)

Most failures degrade gracefully by skipping sends or using fallback values.

---

## Maintenance Tips

- Keep `last-players-status.json` valid JSON and include `id` for each player.
- To monitor only one feature in automation, use `players` or `game` mode.
- If ESPN response schema changes, update the parsers in:
  - `fetchNextGameInfo`
  - `fetchPlayerStatusStr`
- If running on Node < 18, built-in `fetch` may not exist — upgrade the runtime.

