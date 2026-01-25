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
  // Wait for essential UI elements instead of full network idle to save RAM
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="UserDescription"]') ||
        document.querySelector('[data-testid="tweetText"]') ||
        document.querySelector('[data-testid="primaryColumn"]'),
      { timeout: 15000 }
    );
  } catch (e) {
    logger.warn("Navigation timeout: Some elements might be missing.");
  }

  await sleep(1000 + Math.random() * 1000);
  await page.evaluate(() => window.scrollBy(0, 300 + Math.random() * 200));
}

/* ------------------ optimized scraper ------------------ */
class XScraper {
  constructor({ recycleAfter = 2 } = {}) { // Recycle every 2 scrapes for 512MB RAM
    this.browser = null;
    this.page = null;
    this.userDataDir = "./x-session"; 
    this.queue = [];
    this.active = false;
    this.scrapeCount = 0;
    this.recycleAfter = recycleAfter; 
  }

  async init() {
    if (this.browser) return;

    this.browser = await puppeteer.launch({
      headless: "new", 
      userDataDir: this.userDataDir, 
      args: [
        "--no-sandbox", 
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // Uses disk instead of RAM for temporary files [cite: 73]
        "--disable-gpu",
        "--no-zygote", // Saves memory by not pre-forking processes
        "--disable-extensions",
        "--disable-images",
        "--disable-background-networking",
        "--js-flags='--max-old-space-size=128'" // Restricts Chromium internal JS RAM
      ]
    });

    this.page = await this.browser.newPage();

    // MEMORY FIX: Intercept requests to block heavy CSS and Fonts
    await this.page.setRequestInterception(true);
    this.page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await applyFingerprint(this.page); 
  }

  async enqueue(twitterLink) {
    return new Promise((resolve) => {
      this.queue.push({ twitterLink, resolve });
      if (!this.active) this.runQueue();
    });
  }

  async runQueue() {
    this.active = true;
    while (this.queue.length) {
      const { twitterLink, resolve } = this.queue.shift(); 
      try {
        // FULL RECYCLE: Restart browser process to clear leaked RAM
        if (this.scrapeCount >= this.recycleAfter) {
          logger.info("Recycling full browser process to free memory...");
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
    if (!this.page) throw new Error("Scraper not initialized.");
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
        }

        if (type === 'post') {
          result.username = text('[data-testid="User-Name"]');
          result.content = text('[data-testid="tweetText"]');
          result.engagement = text('[role="group"][aria-label*="replies"]');
          result.isVerified = !!document.querySelector('[data-testid="icon-verified"]');
        }

        if (type === "community") {
          result.name = text('h2[role="heading"]');
          result.memberCount = Array.from(document.querySelectorAll("span"))
            .find(s => s.innerText === "Members")
            ?.parentElement?.innerText.replace("Members", "").trim() || "0";
        }

        return result;
      }, contextType);

      // Format engagement numbers
      const eng = data.engagement || "";
      const parts = eng.split('\n');
      data.engagement = {
        comments: normalizeCount(parts[0] || "0"),
        reposts: normalizeCount(parts[1] || "0"),
        likes: normalizeCount(parts[2] || "0")
      };

      data.followingCount = normalizeCount(data.followingCount);
      data.followerCount = normalizeCount(data.followerCount);
      data.memberCount = normalizeCount(data.memberCount);

      return data;
    } catch (err) {
      logger.error("SCRAPER_ERROR:", err);
      return null;
    }
  }

  async close() {
    try {
      if (this.page) await this.page.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch (e) {
      // Ignore errors during process termination
    } finally {
      this.page = null;
      this.browser = null;
    }
  }
}

module.exports = XScraper;