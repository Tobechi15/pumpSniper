const { logger } = require('../Utils/logger.js');
const puppeteer = require("puppeteer");
const { applyFingerprint } = require("../pupbrowser/fingerprint.js");
const fs = require("fs/promises");
const path = require("path");

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
  await page.goto("https://x.com/pubity/status/2014435780102418733", {
    waitUntil: "load",
    timeout: 0
  });

  await sleep(4000);

  await page.evaluate(() => {
    window.scrollBy(0, 500);
  });

  await sleep(3000);
}

/* ------------------ human-like navigation ------------------ */
async function gotoHumanLike(page, url) {
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }); // longer timeout

  try {
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="UserDescription"]') ||
        document.querySelector('[data-testid="tweetText"]') ||
        document.querySelector('[data-testid="primaryColumn"]'),
      { timeout: 30000 } // longer wait
    );
  } catch {
    logger.warn(`Navigation timeout for ${url}`);
  }

  await sleep(2000 + Math.random() * 1000);
  await page.evaluate(() => window.scrollBy(0, 400 + Math.random() * 300));
}

/* ------------------ scraper ------------------ */
class XScraper {
  constructor({ recycleAfter = 1 } = {}) {
    this.queue = [];
    this.active = false;
    this.userDataDir = "./x-session";
    this.sessionDir = path.resolve(this.userDataDir);
    this.totalScrapes = 0;
    this.recycleAfter = recycleAfter;
  }

  async cleanupSessionDir() {
    try {
      await fs.rm(this.sessionDir, { recursive: true, force: true });
      logger.warn("x-session deleted → ready for fresh warmup");
    } catch (_) {}
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
        const result = await this.scrape(twitterLink);
        resolve(result);
      } catch (err) {
        logger.error("SCRAPER_QUEUE_ERROR:", err);
        resolve(null);
      }
    }

    this.active = false;
  }

  async scrape(twitterLink) {
    const attemptScrape = async () => {
      let browser = null;
      let page = null;

      try {
        browser = await puppeteer.launch({
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
            "--js-flags=--max-old-space-size=128"
          ]
        });

        page = await browser.newPage();
        await applyFingerprint(page);

        // Warmup first
        logger.info("X WARMUP → cold session");
        await warmUpXSession(page);

        // Intercept heavy requests after warmup
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          const type = req.resourceType();
          if (["image", "media", "font"].includes(type)) {
            req.abort();
          } else {
            req.continue();
          }
        });

        // Navigate to actual target
        await gotoHumanLike(page, twitterLink);

        const contextType =
          twitterLink.includes("/communities/")
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

        return data;

      } catch (err) {
        throw err;

      } finally {
        try { if (page) await page.close(); } catch {}
        try { if (browser) await browser.close(); } catch {}
        await this.cleanupSessionDir();
      }
    };

    try {
      return await attemptScrape();
    } catch (err) {
      logger.warn(`First scrape failed for ${twitterLink}, retrying...`);
      try {
        return await attemptScrape();
      } catch (err2) {
        logger.error(`SCRAPE_FAILED after retry for ${twitterLink}:`, err2);
        return null;
      }
    }
  }
}

module.exports = XScraper;
