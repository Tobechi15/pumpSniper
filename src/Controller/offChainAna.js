const { logger } = require('../Utils/logger.js');
const puppeteer = require("puppeteer");
const { applyFingerprint } = require("../pupbrowser/fingerprint.js");

/* ------------------ helpers ------------------ */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const normalizeCount = (value = "") => {
  const v = value.toString().replace(/,/g, "").toUpperCase();
  if (v.endsWith("K")) return Math.round(parseFloat(v) * 1_000);
  if (v.endsWith("M")) return Math.round(parseFloat(v) * 1_000_000);
  return parseInt(v) || 0;
};

/* ------------------ human-like navigation ------------------ */
async function gotoHumanLike(page, url) {
  // Use "networkidle2" to ensure the React app has actually finished fetching data
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });

  try {
    // Increased timeout slightly to account for slow 512MB RAM processing
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="UserDescription"]') ||
        document.querySelector('[data-testid="tweetText"]') ||
        document.querySelector('[data-testid="primaryColumn"]'),
      { timeout: 20000 }
    );
  } catch (e) {
    logger.warn(`Navigation timeout for ${url}: Content might not have loaded fully.`);
  }

  await sleep(1500 + Math.random() * 1000);
  await page.evaluate(() => window.scrollBy(0, 400 + Math.random() * 300));
}

/* ------------------ optimized scraper ------------------ */
class XScraper {
  constructor({ recycleAfter = 2 } = {}) {
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
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-extensions",
        "--window-size=1280,1600",
        "--js-flags='--max-old-space-size=128'"
      ]
    });

    this.page = await this.browser.newPage();

    // TUNED INTERCEPTOR: Allow Stylesheets to prevent empty scrapes, block images/media
    await this.page.setRequestInterception(true);
    this.page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'media', 'font'].includes(type)) {
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
        if (!this.browser || this.scrapeCount >= this.recycleAfter) {
          logger.info("Recycling browser process to refresh memory...");
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

          const stat = (label) => {
            const anchors = Array.from(document.querySelectorAll("a"));
            const target = anchors.find(a => a.innerText.includes(label));
            return target ? target.innerText.replace(label, "").trim() : "0";
          };

          result.followingCount = stat("Following");
          result.followerCount = stat("Followers");
        }

        if (type === 'post') {
          result.username = text('[data-testid="User-Name"]');
          result.content = text('[data-testid="tweetText"]');

          // Improved post engagement selector
          const group = document.querySelector('[role="group"][aria-label*="replies"]');
          result.engagementRaw = group ? group.getAttribute("aria-label") : "";
          result.isVerified = !!document.querySelector('[data-testid="icon-verified"]');
        }

        if (type === "community") {
          result.name = text('h2[role="heading"]');
          const spans = Array.from(document.querySelectorAll("span"));
          const memberSpan = spans.find(s => s.innerText === "Members");
          result.memberCount = memberSpan ? memberSpan.parentElement.innerText.replace("Members", "").trim() : "0";
        }

        return result;
      }, contextType);

      // Post-processing engagement for 'post' type
      if (data.type === 'post' && data.engagementRaw) {
        // Example aria-label: "23 replies, 10 reposts, 50 likes"
        const parts = data.engagementRaw.split(',');
        data.engagement = {
          comments: normalizeCount(parts[0] || "0"),
          reposts: normalizeCount(parts[1] || "0"),
          likes: normalizeCount(parts[2] || "0")
        };
      } else if (!data.engagement) {
        data.engagement = { comments: 0, reposts: 0, likes: 0 };
      }

      data.followingCount = normalizeCount(data.followingCount || "0");
      data.followerCount = normalizeCount(data.followerCount || "0");
      data.memberCount = normalizeCount(data.memberCount || "0");

      return data;
    } catch (err) {
      logger.error(`SCRAPE_FAILED for ${twitterLink}`, err);
      return null;
    }
  }

  async close() {
    try {
      if (this.page) await this.page.close().catch(() => { });
      if (this.browser) await this.browser.close().catch(() => { });
    } catch (e) {
      // Silently catch closure errors
    } finally {
      this.page = null;
      this.browser = null;
    }
  }
}

module.exports = XScraper;