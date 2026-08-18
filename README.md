# 📥 ChatExporter

A high-performance Discord chat export plugin for **Vencord** and **Vesktop**, inspired by [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter).

Export complete message histories from **Direct Messages (DMs)**, **Group DMs**, and **Server Channels** directly from Discord's right-click context menu.

---

## ✨ Features

* **⚡ Ultra-Fast Throughput:** Uses Discord API v10 with native HTTP/2 streaming, interleaved asynchronous pipelining, and 64-bit Discord Snowflake date indexing for maximum download speeds.
* **📦 Multiple Export Formats:**
  * **HTML (Dark Theme):** Styled to look and feel like Discord with avatars, embeds, attachments, and timestamps.
  * **HTML (Light Theme):** Discord light mode styling.
  * **JSON:** Full structured message objects with all metadata.
  * **CSV:** Spreadsheet-compatible format with timestamps, authors, reactions, and attachments.
  * **Plain Text (.txt):** Clean, chronological text transcripts.
* **💬 Discord-Style Message Grouping:** Consecutive messages sent by the same user within 7 minutes are grouped together with a single avatar/header.
* **🎯 Rich Message Elements:** Renders markdown (bold, italics, code blocks), replied-to message previews, reactions with count badges, custom emojis, stickers, and image previews.
* **⏱ Advanced Filtering:** Filter by date range (**After** / **Before**) and set custom message limits.
* **🚀 Hyper-Speed Mode:** Aggressive mode that bypasses sliding advisory rate-limit pauses, operating at maximum connection bandwidth and pausing only on HTTP 429 responses.
* **🛡️ Client-Native:** Runs directly in your client without needing third-party token scrapers or external binaries.

---

## 🛠️ Installation

### Method 1: Installing in Vesktop

1. **Clone Vencord:**
   ```bash
   git clone https://github.com/Vendicated/Vencord.git
   cd Vencord
   pnpm install
   ```

2. **Add ChatExporter to `userplugins`:**
   ```bash
   mkdir -p src/userplugins/chatExporter
   ```
   Copy `index.tsx` and `styles.css` into `src/userplugins/chatExporter/`.

   *(Or clone this repository directly into `src/userplugins`)*:
   ```bash
   git clone https://github.com/Qssaf/ChatExporter.git src/userplugins/chatExporter
   ```

3. **Build Vencord:**
   ```bash
   pnpm build
   ```

4. **Copy Built Files to Vesktop:**
   ```bash
   # For Linux
   cp -fv dist/* ~/.config/vesktop/sessionData/vencordFiles/
   ```

5. **Restart Vesktop** (`Ctrl+R` or relaunch the app).

---

### Method 2: Installing in Standard Vencord (Discord Desktop)

1. Clone Vencord and install dependencies:
   ```bash
   git clone https://github.com/Vendicated/Vencord.git
   cd Vencord
   pnpm install
   ```

2. Clone this plugin into `src/userplugins`:
   ```bash
   git clone https://github.com/Qssaf/ChatExporter.git src/userplugins/chatExporter
   ```

3. Build and inject into Discord:
   ```bash
   pnpm build
   pnpm inject
   ```

4. Restart Discord.

---

## 📖 How to Use

1. Open Discord / Vesktop.
2. Ensure the plugin is enabled in **User Settings → Plugins → Search "ChatExporter"** (it is enabled by default).
3. **Right-click** any DM, Group Chat, or Server Channel in your sidebar.
4. Click **Export Chat**.
5. Select your desired format, date filters, or limits in the dialog and click **Export**.
6. Your browser / client will download the generated export file.

---

## ⚙️ Export Options

| Option | Description |
|---|---|
| **Export Format** | Choose between `HTML (Dark)`, `HTML (Light)`, `JSON`, `CSV`, or `Plain Text`. |
| **After (From Date)** | Only export messages sent *after* this timestamp. |
| **Before (To Date)** | Only export messages sent *before* this timestamp. |
| **Message Limit** | Maximum number of messages to fetch (leave blank for all messages). |
| **Include Bot Messages** | Toggle whether bot messages are included in the export. |
| **Hyper-Speed Mode** | Disregards sliding advisory limits and pauses only when Discord returns a 429. |

---

## 📄 License

Licensed under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE).
