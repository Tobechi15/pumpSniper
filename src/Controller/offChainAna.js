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

/* ------------------ warmup ------------------ */
async function warmUpXSession(page) {
  try {
    await page.goto("https://x.com/pubity/status/2014435780102418733", {
      waitUntil: "load",
      timeout: 0
    });
    await sleep(2000);
    await page.evaluate(() => window.scrollBy(0, 300));
    await sleep(2000);
  } catch (err) {
    logger.warn("Warmup failed, continuing anyway");
  }
}

/* ------------------ human-like navigation ------------------ */
async function gotoHumanLike(page, url) {
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="UserDescription"]') ||
        document.querySelector('[data-testid="tweetText"]') ||
        document.querySelector('[data-testid="primaryColumn"]'),
      { timeout: 30000 }
    );

    await sleep(2000 + Math.random() * 1000);
    await page.evaluate(() => window.scrollBy(0, 400 + Math.random() * 300));
  } catch {
    logger.warn(`Navigation timeout for ${url}`);
  }
}

/* ------------------ scraper ------------------ */
class XScraper {
  constructor({ maxConcurrent = 1 } = {}) {
    this.queue = [];
    this.active = 0;
    this.maxConcurrent = maxConcurrent;
    this.browser = null;
  }

  async initBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-zygote",
          "--disable-extensions",
          "--window-size=1280,1600"
        ]
      });
      logger.info("Persistent browser launched");
    }
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info("Persistent browser closed");
    }
  }

  async enqueue(twitterLink) {
    return new Promise((resolve) => {
      this.queue.push({ twitterLink, resolve });
      this.runQueue();
    });
  }

  async runQueue() {
    if (this.active >= this.maxConcurrent) return;
    while (this.queue.length && this.active < this.maxConcurrent) {
      const { twitterLink, resolve } = this.queue.shift();
      this.active++;
      try {
        const result = await this.scrape(twitterLink);
        resolve(result);
      } catch (err) {
        logger.error("SCRAPER_QUEUE_ERROR:", err);
        resolve(null);
      } finally {
        this.active--;
        this.runQueue(); // start next in queue
      }
    }
  }

  async scrape(twitterLink) {
    await this.initBrowser();
    const page = await this.browser.newPage();

    // Apply fingerprint
    await applyFingerprint(page);

    // Warmup
    logger.info("X WARMUP → cold session");
    await warmUpXSession(page);

    // Block heavy resources
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "media", "font"].includes(type)) req.abort();
      else req.continue();
    });

    // Navigate to target
    await gotoHumanLike(page, twitterLink);

    const contextType = twitterLink.includes("/communities/")
      ? "community"
      : twitterLink.includes("/status/")
      ? "post"
      : "profile";

    const data = await page.evaluate((type) => {
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
        const group = document.querySelector('[role="group"][aria-label*="replies"]');
        result.engagementRaw = group ? group.getAttribute("aria-label") : "";
        result.isVerified = !!document.querySelector('[data-testid="icon-verified"]');
      }

      if (type === "community") {
        result.name = text('h2[role="heading"]');
        const spans = Array.from(document.querySelectorAll("span"));
        const memberSpan = spans.find(s => s.innerText === "Members");
        result.memberCount = memberSpan
          ? memberSpan.parentElement.innerText.replace("Members", "").trim()
          : "0";
      }

      return result;
    }, contextType);

    // Process engagement
    if (data.type === 'post' && data.engagementRaw) {
      const parts = data.engagementRaw.split(',');
      data.engagement = {
        comments: normalizeCount(parts[0] || "0"),
        reposts: normalizeCount(parts[1] || "0"),
        likes: normalizeCount(parts[2] || "0")
      };
    } else {
      data.engagement = { comments: 0, reposts: 0, likes: 0 };
    }

    data.followingCount = normalizeCount(data.followingCount || "0");
    data.followerCount = normalizeCount(data.followerCount || "0");
    data.memberCount = normalizeCount(data.memberCount || "0");

    await page.close();
    return data;
  }
}

module.exports = XScraper;
