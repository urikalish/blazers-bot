# Blazers Bot

A Node.js Telegram bot that monitors the **Portland Trail Blazers** NBA team and sends automated alerts about upcoming games and player status changes.

---

## Overview

The bot does two things when run:

1. **Game Alert** – Checks when the next Blazers game is and sends a Telegram message if the game is currently in progress, starting within 12 hours, or detected as a newly upcoming game.
2. **Player Status Alert** – Fetches the current injury/availability status for each tracked player, compares it to the last known status, and sends a Telegram message whenever a player's status changes.

---

## Tech Stack

- **Node.js** (ES modules) — Node 22+ required (workflow uses Node 22; built-in `fetch` has been stable since Node 21)
- **[Telegraf](https://telegraf.js.org/)** – Telegram Bot API framework
- **[dotenv](https://github.com/motdotla/dotenv)** – Loads environment variables from `.env`
- **[Yarn](https://yarnpkg.com/)** – Package manager (lockfile committed; use yarn, not npm)
- Built-in `fetch` + `AbortController` for HTTP requests

---

## Project Structure

```
blazers-bot/
├── .github/
│   └── workflows/
│       └── run-all-checks.yml     # Active GitHub Actions workflow (runs every 15 min)
├── inactive_workflows/            # Archived per-check workflows (not active)
│   ├── game-info.yml
│   └── players-status.yml
├── server.js                      # All application logic (startup, API calls, message decisions, persistence)
├── last-players-status.json       # Persisted player roster and status state (committed to repo)
├── last-game-info.json            # Persisted last known next-game ID (committed to repo)
├── package.json                   # Dependencies and scripts
├── yarn.lock                      # Lockfile — always commit this
└── .env                           # Secret credentials (not committed)
```

---

## Setup

### 1. Install dependencies

```bash
yarn install
```

> Do not use `npm install`. The project uses Yarn and commits `yarn.lock`.

### 2. Configure environment variables

Create a `.env` file in the project root (see `.env.example`):

```env
BOT_TOKEN=<your_telegram_bot_token>
CHAT_ID=<target_chat_id>
```

Alternatively, set these directly as environment variables (e.g. in CI/CD).

| Variable    | Description                                                                   |
|-------------|-------------------------------------------------------------------------------|
| `BOT_TOKEN` | Telegram bot token from [@BotFather](https://t.me/BotFather)                 |
| `CHAT_ID`   | Target Telegram chat/group ID to send messages to                            |

If either variable is missing, startup fails with a clear error from `loadEnvVars()`.

### 3. GitHub Secrets (for CI)

For the GitHub Actions workflow to function, add both variables as **repository secrets** under  
_Settings → Secrets and variables → Actions_:

- `BOT_TOKEN`
- `CHAT_ID`

---

## Usage

```bash
# Run both game check and player status check (default)
yarn start

# With explicit mode
node server.js          # defaults to "all"
node server.js game     # only game check
node server.js players  # only player status check
```

> The `start` script passes `--disable-warning=DEP0040` to suppress the Node.js punycode deprecation warning emitted by a transitive dependency.

### Run Modes

`getRunMode()` reads the CLI argument and supports exactly these modes:

| Mode      | Description                                         |
|-----------|-----------------------------------------------------|
| `all`     | Runs both game and player status checks (default)   |
| `game`    | Only checks and reports the next game               |
| `players` | Only checks and reports player status changes       |

Any other mode throws: `Invalid mode "<mode>". Use: all | players | game`

---

## GitHub Actions / CI

### Active workflow: `run-all-checks.yml`

The bot is designed to run **entirely on GitHub Actions** — no server required.

| Property        | Value                                                                              |
|-----------------|------------------------------------------------------------------------------------|
| Trigger         | Cron: `7,22,37,52 * * * *` (every 15 minutes) + manual `workflow_dispatch`        |
| Runner          | `ubuntu-latest`                                                                    |
| Node version    | 22                                                                                 |
| Package manager | Yarn (frozen lockfile)                                                             |
| Concurrency     | Group `run-all`, `cancel-in-progress: false` (queues; never cancels a running job) |

**What the workflow does:**

1. Checks out the repo (full history with `fetch-depth: 0`).
2. Installs dependencies via `yarn install --frozen-lockfile`.
3. Runs `yarn start all` with `BOT_TOKEN` and `CHAT_ID` from repository secrets.
4. Commits and pushes any changes to `last-game-info.json` and/or `last-players-status.json` back to the repo as `github-actions[bot]`. This is the persistence mechanism — the repo itself is the database.

> **Important:** Because state is persisted by committing to the repo, the workflow must have `permissions: contents: write`.

### Inactive workflows: `inactive_workflows/`

Two older per-check workflows (`game-info.yml`, `players-status.yml`) exist in `inactive_workflows/`. They ran separately on an hourly cron and are kept for reference. They are **not** in `.github/workflows/` and are therefore not active. To reactivate one, move it to `.github/workflows/`.

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
   - **Game in progress** – tip-off time has already passed (message: `Game is currently in progress.`).
   - **Game is soon** – less than 12 hours until tip-off.
   - **New game** – first time this game has been retrieved, regardless of how far away it is.
6. Message formatting for upcoming games:
   - If the game is **new**: includes game name + date/time + time remaining.
   - If the game is **not new**: includes only date/time + time remaining (no game name).
7. Otherwise, skips silently.

**Example Telegram messages:**
```
Portland Trail Blazers vs Golden State Warriors
Thursday, 17/03/26, 03:00
in 4 hour(s) and 30 minute(s)

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
Avdija: ACT -> GTD
Grant: OUT -> ACT
```

> **Note:** If writing the updated state to `last-players-status.json` fails, the bot skips sending the Telegram message to avoid reporting stale changes on the next run.

---

## `last-players-status.json` Format

This file tracks the last known status for each player. **Edit it directly to add or remove players.** Changes are committed back to the repo automatically by the CI workflow after each run.

```json
[
  {
    "id": 4683021,
    "shirt": "8",
    "name": "Avdija",
    "status": "ACT"
  }
]
```

| Field    | Type     | Description                                                       |
|----------|----------|-------------------------------------------------------------------|
| `id`     | `number` | ESPN athlete ID (required for API lookups)                        |
| `shirt`  | `string` | Jersey number (for display/reference only, not used in logic)     |
| `name`   | `string` | Player display name (used in Telegram messages)                   |
| `status` | `string` | Last known status — e.g. `ACT`, `OUT`, `GTD`, `OFS`             |

Keep this file as valid JSON and ensure every entry has an `id`. The `shirt` and `name` fields are informational only.

**Finding a player's ESPN ID:** Look up the player on ESPN and copy the numeric ID from the athlete URL, e.g. `https://www.espn.com/nba/player/_/id/4683021/deni-avdija`.

---

## `last-game-info.json` Format

Persists the ESPN event ID of the last-known upcoming game to detect new games.

```json
{ "id": "401767890" }
```

Initialize with `{ "id": "0" }` to ensure the very first game found is treated as "new" and reported.

---

## External APIs

| API | URL pattern | Used for |
|-----|-------------|----------|
| ESPN Schedule | `site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/por/schedule` | Next game lookup |
| ESPN Athlete  | `site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}` | Player injury/status |

Both APIs are unofficial/public ESPN endpoints. They have no authentication and no documented SLA. HTTP requests time out after **10 seconds** (`FETCH_TIMEOUT_MS`).

Game times are displayed in the **`Asia/Jerusalem`** timezone (Israel time) in 24-hour format.

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
| `writeDataObjectToFile()`                 | Persists a JSON object to a file; returns `true` on success                 |
| `readDataObjectFromFile()`                | Reads and parses a JSON file; returns `null` on any error                   |
| `fetchWithTimeout(url)`                   | Wraps `fetch` with an `AbortController` timeout (default 10 s)             |
