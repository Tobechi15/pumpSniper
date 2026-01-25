const { logger } = require('../Utils/logger.js');
const puppeteer = require("puppeteer");
const { applyFingerprint } = require("../pupbrowser/fingerprint.js");

/* ------------------ helpers ------------------ */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const normalizeCount = (value = "") => {
  const v = value.replace(/,/g, "").toUpperCase();
  if (v.endsWith("K")) return Math.round(parseFloat(v) * 1_000);
  if (v.endsWith("M")) return Math.round(parseFloat(v) * 1_000_000);
  return parseInt(v) || 0;
};

/* ------------------ human-like navigation ------------------ */
async function gotoHumanLike(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="UserDescription"]') ||
      document.querySelector('[data-testid="tweetText"]') ||
      document.querySelector('[data-testid="primaryColumn"]'),
    { timeout: 20000 }
  );

  await sleep(1200 + Math.random() * 1500);

  await page.evaluate(() => window.scrollBy(0, 300 + Math.random() * 400));

  await sleep(1000);
}

/* ------------------ scraper with queue and page recycling ------------------ */
class XScraper {
  constructor({ recycleAfter = 2 } = {}) { // Lowered to 2 for 512MB RAM
    this.browser = null;
    this.page = null;
    this.userDataDir = "./x-session";
    this.queue = [];
    this.active = false;
    this.scrapeCount = 0;
    this.recycleAfter = recycleAfter;
  }

  async init() {
    if (this.browser) return; // Prevent double init

    this.browser = await puppeteer.launch({
      headless: "new",
      userDataDir: this.userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // Crucial for low-memory Linux environments
        "--disable-gpu",
        "--disable-extensions",
        "--disable-images",
        "--no-zygote", // Saves memory by not pre-forking
        "--js-flags='--max-old-space-size=128'",
      ]
    });
    this.page = await this.browser.newPage();
    // Block CSS and Fonts to save bandwidth and RAM
    await this.page.setRequestInterception(true);
    this.page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });
    await applyFingerprint(this.page);
  }

  async runQueue() {
    this.active = true;
    while (this.queue.length) {
      const { twitterLink, resolve } = this.queue.shift();
      try {
        // FULL RECYCLE: Close entire browser after N scrapes
        if (this.scrapeCount >= this.recycleAfter) {
          logger.info("Hard recycling Browser process to clear RAM...");
          await this.close();
          await this.init();
          this.scrapeCount = 0;
        }

        const result = await this.scrape(twitterLink);
        this.scrapeCount++;
        resolve(result);
      } catch (err) {
        logger.error("SCRAPER_QUEUE_ERROR:", err.message);
        resolve(null);
      }
    }
    this.active = false;
  }

  async scrape(twitterLink) {
    if (!this.page) throw new Error("Scraper not initialized. Call init() first.");

    try {
      await gotoHumanLike(this.page, twitterLink);

      const contextType = twitterLink.includes("/communities/") ? "community" :
        twitterLink.includes("/status/") ? "post" : "profile";

      const data = await this.page.evaluate((type) => {
        const text = (sel) => document.querySelector(sel)?.innerText.trim() || "";
        const result = { type };

        if (type === "profile") {
          result.name = text('[data-testid="UserName"]');
          result.bio = text('[data-testid="UserDescription"]');
          result.isVerified = !!document.querySelector('[data-testid="icon-verified"]');

          const stat = (label) =>
            Array.from(document.querySelectorAll("a"))
              .find(a => a.innerText.includes(label))
              ?.innerText.replace(label, "").trim() || "0";

          result.followingCount = stat("Following");
          result.followerCount = stat("Followers");

          result.joinedDate =
            Array.from(document.querySelectorAll("span"))
              .find(s => s.innerText.includes("Joined"))
              ?.innerText || "";
        }

        if (type === 'post') {
          // In single post view, the main tweet is often the first 'article' or tweet test-id
          result.username = text('[data-testid="User-Name"]');
          result.content = text('[data-testid="tweetText"]');
          result.engagement = text('[role="group"][aria-label*="replies"]');
          result.isVerified = !!document.querySelector('[data-testid="icon-verified"]');
        }

        if (type === "community") {
          result.name = text('h2[role="heading"]');
          result.description = document.querySelector('[style*="-webkit-line-clamp"]')?.innerText || "";
          result.isVerified = !!document.querySelector('[data-testid="icon-verified"]');

          const members = Array.from(document.querySelectorAll("span"))
            .find(s => s.innerText === "Members")
            ?.parentElement?.innerText;
          result.memberCount = members?.replace("Members", "").trim() || "0";
        }

        return result;
      }, contextType);

      const engagementStr = data.engagement || "";
      const parts = engagementStr.split('\n');

      data.engagement = {
        comments: normalizeCount(parts[0] || "0"),
        reposts: normalizeCount(parts[1] || "0"),
        likes: normalizeCount(parts[2] || "0"),
        bookmarks: normalizeCount(parts[3] || "0")
      };

      data.followingCount = normalizeCount(data.followingCount);
      data.followerCount = normalizeCount(data.followerCount);
      data.memberCount = normalizeCount(data.memberCount);

      return data;

    } catch (err) {
      logger.error("SCRAPER_ERROR:", err.message);
      return null;
    }
  }

  async close() {
    try {
      if (this.page) {
        await this.page.close().catch(() => { }); // Ignore if already closed 
      }
      if (this.browser) {
        await this.browser.close().catch(() => { }); // Ignore if already closed 
      }
    } catch (err) {
      // Silence PID errors during shutdown
    } finally {
      this.page = null;
      this.browser = null;
    }
  }
}

module.exports = XScraper;