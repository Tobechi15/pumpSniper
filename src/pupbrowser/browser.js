// browser.js
const puppeteer = require("puppeteer");

async function createBrowser() {
  const browser = await puppeteer.launch({
    headless: "new",
    userDataDir: "./x-session",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,1600"
    ]
  });

  return browser;
}

module.exports = { createBrowser };
