# Opencode Token Usage

[![Version](https://img.shields.io/github/manifest-json/v/xhang1108/opencode-usage?filename=extension%2Fmanifest.json&label=version&color=blue)](https://github.com/xhang1108/opencode-usage)

A Chrome extension that syncs your [opencode.ai](https://opencode.ai) usage token data into local storage (OPFS) and shows it in a built-in dashboard. opencode's own usage page does not count free models, so this extension tracks them too.

## Features

<table>
  <tr>
    <td align="center" width="33%">
      <strong>Free Models</strong><br>
      <sub>Tracks free models ignored by the official page</sub>
    </td>
    <td align="center" width="33%">
      <strong>Full Usage</strong><br>
      <sub>Charts, tables, rates & CSV export</sub>
    </td>
    <td align="center" width="33%">
      <strong>Peak Alerts</strong><br>
      <sub>Peak / off-peak reminders with 24h timeline</sub>
    </td>
  </tr>
</table>

## Install

1. Clone/download this repo.
2. Open <kbd>chrome://extensions</kbd>, enable **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder.

<img src="https://developer.chrome.com/static/docs/extensions/get-started/tutorial/hello-world/image/extensions-page-e0d64d89a6acf_1440.png" alt="Load unpacked extension" width="400">

## Usage

1. Sign in at [opencode.ai/auth](https://opencode.ai/auth) and open your workspace **Usage** page — `https://opencode.ai/workspace/<your-workspace-id>/usage`.
2. Click the extension icon → **Crawl Now** to sync the latest usage records.
3. Click **Open Dashboard** to view charts, tables, and cost estimates.
4. Use **Export Filtered Data (CSV)** on the dashboard to download records.

![Dashboard](screenshots/dashboard.avif)

## Notes

- Crawling is manual (click **Crawl Now** each time); the extension refreshes the server ID itself.
- Model rates can be edited in the dashboard's **Rate Settings**.
- The Rescan button is hidden by default; uncomment it in `popup/popup.html` and `popup/popup.js` to show it.
