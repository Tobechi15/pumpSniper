const puppeteer = require("puppeteer");
const { logger } = require("../Utils/logger.js");
const { applyFingerprint } = require("../pupbrowser/fingerprint.js");

/* ------------------ helpers ------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizeCount = (value = "") => {
  const v = value.toString().replace(/,/g, "").toUpperCase();
  if (v.endsWith("K")) return Math.round(parseFloat(v) * 1_000);
  if (v.endsWith("M")) return Math.round(parseFloat(v) * 1_000_000);
  return parseInt(v) || 0;
};

/* ------------------ navigation ------------------ */
async function gotoHumanLike(page, url) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000
  });

  await Promise.race([
    page.waitForSelector('[data-testid="tweetText"]', { timeout: 15000 }),
    page.waitForSelector('[data-testid="UserDescription"]', { timeout: 15000 }),
    page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 15000 })
  ]).catch(() => {
    logger.warn(`Soft load timeout for ${url}`);
  });

  await sleep(800 + Math.random() * 600);
  await page.evaluate(() => window.scrollBy(0, 250 + Math.random() * 200));
}

/* ------------------ scraper ------------------ */
class XScraper {
  constructor({
    recyclePageAfter = 1,
    recycleBrowserAfter = 15,
    memoryLimitMB = 150,
    memoryCheckInterval = 5000
  } = {}) {
    this.browser = null;
    this.page = null;
    this.userDataDir = "./x-session";
    this.queue = [];
    this.active = false;

    this.pageCount = 0;
    this.browserCount = 0;

    this.recyclePageAfter = recyclePageAfter;
    this.recycleBrowserAfter = recycleBrowserAfter;

    this.memoryLimitMB = memoryLimitMB;
    this.memoryCheckInterval = memoryCheckInterval;
    this.watchdog = null;
    this.recycling = false;
  }

  /* -------- memory watchdog -------- */
  startMemoryWatchdog() {
    if (this.watchdog) return;

    this.watchdog = setInterval(async () => {
      const rssMB = process.memoryUsage().rss / 1024 / 1024;

      if (rssMB >= this.memoryLimitMB && !this.recycling) {
        this.recycling = true;
        logger.warn(
          `MEMORY WATCHDOG → ${rssMB.toFixed(1)} MB used. Recycling browser.`
        );

        try {
          await this.closeBrowser();
          await this.initBrowser();
        } catch (err) {
          logger.error("WATCHDOG_RECYCLE_FAILED:", err.message);
        } finally {
          this.recycling = false;
        }
      }
    }, this.memoryCheckInterval);
  }

  stopMemoryWatchdog() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /* -------- init -------- */
  async initBrowser() {
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
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--window-size=1280,1600",
        "--js-flags=--max-old-space-size=128"
      ]
    });

    this.browserCount++;
    logger.info("Browser launched");

    this.startMemoryWatchdog();
  }

  async initPage() {
    if (!this.browser) await this.initBrowser();

    if (this.page) {
      try { await this.page.close(); } catch (_) {}
    }

    this.page = await this.browser.newPage();

    await this.page.setRequestInterception(true);
    this.page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "media", "font"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await applyFingerprint(this.page);
    await this.warmUpSession();

    this.pageCount++;
  }

  /* -------- warmup -------- */
  async warmUpSession() {
    await this.page.goto("https://x.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 0
    });

    await sleep(2000);
    await this.page.evaluate(() => window.scrollBy(0, 400));
    await sleep(1000);
  }

  /* -------- queue -------- */
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
        if (!this.page || this.pageCount >= this.recyclePageAfter) {
          await this.initPage();
          this.pageCount = 0;
        }

        if (this.browserCount >= this.recycleBrowserAfter) {
          logger.warn("Scheduled browser recycle");
          await this.closeBrowser();
          await this.initBrowser();
          this.browserCount = 0;
        }

        const data = await this.scrape(twitterLink);
        resolve(data);
      } catch (err) {
        logger.error("SCRAPER_QUEUE_ERROR:", err);
        resolve(null);
      }
    }

    this.active = false;
  }

  /* -------- scrape -------- */
  async scrape(twitterLink) {
    if (!this.page) throw new Error("Page not initialized");

    try {
      await gotoHumanLike(this.page, twitterLink);

      const type =
        twitterLink.includes("/communities/")
          ? "community"
          : twitterLink.includes("/status/")
          ? "post"
          : "profile";

      const data = await this.page.evaluate((context) => {
        const text = (sel) =>
          document.querySelector(sel)?.innerText.trim() || "";

        const res = { type: context };

        if (context === "profile") {
          res.name = text('[data-testid="UserName"]');
          res.bio = text('[data-testid="UserDescription"]');
          res.isVerified = !!document.querySelector('[data-testid="icon-verified"]');

          const stat = (label) => {
            const links = Array.from(document.querySelectorAll("a"));
            const el = links.find((a) => a.innerText.includes(label));
            return el ? el.innerText.replace(label, "").trim() : "0";
          };

          res.followingCount = stat("Following");
          res.followerCount = stat("Followers");
        }

        if (context === "post") {
          res.content = text('[data-testid="tweetText"]');
          res.isVerified = !!document.querySelector('[data-testid="icon-verified"]');

          const g = document.querySelector('[role="group"][aria-label*="replies"]');
          res.engagementRaw = g?.getAttribute("aria-label") || "";
        }

        if (context === "community") {
          res.name = text('h2[role="heading"]');
          const spans = Array.from(document.querySelectorAll("span"));
          const m = spans.find((s) => s.innerText === "Members");
          res.memberCount = m
            ? m.parentElement.innerText.replace("Members", "").trim()
            : "0";
        }

        return res;
      }, type);

      if (data.type === "post" && data.engagementRaw) {
        const p = data.engagementRaw.split(",");
        data.engagement = {
          comments: normalizeCount(p[0]),
          reposts: normalizeCount(p[1]),
          likes: normalizeCount(p[2])
        };
      } else {
        data.engagement = { comments: 0, reposts: 0, likes: 0 };
      }

      data.followingCount = normalizeCount(data.followingCount);
      data.followerCount = normalizeCount(data.followerCount);
      data.memberCount = normalizeCount(data.memberCount);

      return data;
    } catch (err) {
      logger.error(`SCRAPE_FAILED → ${twitterLink}`, err.message);
      return null;
    }
  }

  /* -------- shutdown -------- */
  async closeBrowser() {
    try {
      if (this.page) await this.page.close();
      if (this.browser) await this.browser.close();
    } catch (_) {
    } finally {
      this.page = null;
      this.browser = null;
      this.stopMemoryWatchdog();
    }
  }
}

module.exports = XScraper;
