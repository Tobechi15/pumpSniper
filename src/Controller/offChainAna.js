const { logger } = require('../Utils/logger.js');
const puppeteer = require("puppeteer");
const { warmUpXSession } = require("../pupbrowser/warmup.js");
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

/* ------------------ memory-friendly scraper ------------------ */
class XScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.userDataDir = "./x-session"; // reuse warmup session
  }

  async init() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: "new",
        userDataDir: this.userDataDir,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1280,1600"
        ]
      });
      this.page = await this.browser.newPage();
      await applyFingerprint(this.page);
      await warmUpXSession(this.page)
    }
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

        if (type === "post") {
          result.username = text('[data-testid="UserName"]');
          result.content = text('[data-testid="tweetText"]');
          result.isVerified = !!document.querySelector('[data-testid="icon-verified"]');

          const engagement = {};
          document.querySelectorAll('[data-testid="reply"],[data-testid="retweet"],[data-testid="like"],[data-testid="bookmark"]').forEach(el => {
            const label = el.getAttribute("aria-label") || "";
            if (label.includes("Reply")) engagement.comments = label;
            if (label.includes("Repost")) engagement.reposts = label;
            if (label.includes("Like")) engagement.likes = label;
            if (label.includes("Bookmark")) engagement.bookmarks = label;
          });
          result.engagement = engagement;
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

      // normalize numbers
      if (data.engagement) {
        data.engagement = {
          comments: normalizeCount(data.engagement.comments || "0"),
          reposts: normalizeCount(data.engagement.reposts || "0"),
          likes: normalizeCount(data.engagement.likes || "0"),
          bookmarks: normalizeCount(data.engagement.bookmarks || "0")
        };
      }
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
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}

module.exports = XScraper;
