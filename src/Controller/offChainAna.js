const { logger } = require('../Utils/logger.js');
const puppeteer = require("puppeteer");
const { config } = require("../Utils/config.js");
const { applyFingerprint } = require("../pupbrowser/fingerprint.js");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const normalizeCount = (value = "") => {
  const v = value.toString().replace(/,/g, "").toUpperCase();
  if (v.endsWith("K")) return Math.round(parseFloat(v) * 1_000);
  if (v.endsWith("M")) return Math.round(parseFloat(v) * 1_000_000);
  return parseInt(v) || 0;
};


/* ------------------ human-like navigation ------------------ */
async function gotoHumanLike(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="UserDescription"]') ||
        document.querySelector('[data-testid="tweetText"]') ||
        document.querySelector('[data-testid="primaryColumn"]'),
      { timeout: 20000 }
    );

    await sleep(1000 + Math.random() * 500);
    await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 200));
    return true;
  } catch {
    logger.warn(`Navigation timeout for ${url}`);
    return false;
  }
}

/* ------------------ X Scraper ------------------ */
class XScraper {
  constructor() {
    this.browser = null;
    this.page = null; // reuse single page for Free tier
    this.queue = [];
    this.active = false; // single task at a time
  }

  async initBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.connect({
        browserWSEndpoint: config.BROWSER_WSE_ENDPOINT,
        defaultViewport: null
      });
      logger.info("Persistent browser connected");

      // create a single page for all jobs
      this.page = await this.browser.newPage();
      await applyFingerprint(this.page);

      // Block heavy resources
      await this.page.setRequestInterception(true);
      this.page.on("request", (req) => {
        if (["image", "media", "font"].includes(req.resourceType())) req.abort();
        else req.continue();
      });
    }
  }

  async closeBrowser() {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info("Browser closed");
    }
  }

  async enqueue(url) {
    return new Promise((resolve) => {
      this.queue.push({ url, resolve });
      this.runQueue();
    });
  }

  async runQueue() {
    if (this.active) return; // only 1 active job on Free tier
    const job = this.queue.shift();
    if (!job) return;

    this.active = true;
    try {
      const result = await this.scrape(job.url);
      job.resolve(result);
    } catch (err) {
      logger.error("SCRAPER_QUEUE_ERROR:", err);
      job.resolve(null);
    } finally {
      this.active = false;
      this.runQueue(); // next job
    }
  }

  async scrape(url) {
    await this.initBrowser();
    const page = this.page; // reuse single page

    const ok = await gotoHumanLike(page, url);
    if (!ok) return null;

    const contextType = url.includes("/communities/")
      ? "community"
      : url.includes("/status/")
      ? "post"
      : "profile";

    let data = {};
    try {
      data = await page.evaluate((type) => {
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

    } catch (err) {
      logger.error("SCRAPER_EVAL_ERROR:", err);
      return null;
    }

    return data;
  }
}

module.exports = XScraper;
