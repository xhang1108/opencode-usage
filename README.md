# Opencode Token Usage

A Chrome extension that syncs your [opencode.ai](https://opencode.ai) usage token data into local storage (OPFS) and shows it in a built-in dashboard. opencode's own usage page does not count free models, so this extension tracks them too.

## Install

1. Clone/download this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder.

![Load unpacked extension](https://developer.chrome.com/static/docs/extensions/get-started/tutorial/hello-world/image/extensions-page-e0d64d89a6acf_1440.png)

## Usage

1. Open `https://opencode.ai/workspace/<your-workspace-id>/usage` and sign in.
2. Click the extension icon → **Crawl Now** to sync the latest usage records.
3. Click **Open Dashboard** to view charts, tables, and cost estimates.
4. Use **Export Filtered Data (CSV)** on the dashboard to download records.

![Dashboard](screenshots/dashboard.avif)

## Notes

- Crawling is manual (click **Crawl Now** each time); the extension refreshes the server ID itself.
- Model rates can be edited in the dashboard's **Rate Settings**.
- The Rescan button is hidden by default; uncomment it in `popup/popup.html` and `popup/popup.js` to show it.
