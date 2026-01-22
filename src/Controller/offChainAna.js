const { GoogleGenerativeAI } = require("@google/generative-ai");
const { config } = require('../Utils/config.js');
const { logger } = require('../Utils/logger.js')
const puppeteer = require("puppeteer");

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

/**
 * AI Analysis Engine
 * Categorizes project narrative and evaluates social health
 */
const analyzeProjectData = async (scrapedData) => {
  if (!scrapedData) {
    return { error: "EMPTY_INPUT" };
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-3-flash-preview",
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  });

  const prompt = `
You are a crypto social intelligence engine.

INPUT:
${JSON.stringify(scrapedData)}

ANALYZE:
- Audience size (followers or members)
- Account credibility (verification, age, professionalism)
- Engagement quality (likes vs replies ratio)
- Narrative classification (select ONE only)

NARRATIVE OPTIONS:
- Trend-Driven Coin
- Problem-Solving Coin
- Meme Coin

RETURN STRICT JSON ONLY:
{
  "audienceSize": number,
  "credibilityScore": number,
  "accountMaturity": "new" | "established",
  "isVerified": boolean,
  "engagementQuality": "organic" | "artificial" | "mixed",
  "narrative": string,
  "summary": string
}
`;

  try {
    const result = await model.generateContent(prompt);
    let text = await result.response.text(); // ensure we await promise
    text = text.trim();

    // Attempt to extract JSON block if extra text is present
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON block found");

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.error("AI_PARSE_ERROR:", err.message, "\nRAW_RESPONSE:", err.raw || "");
    return { error: "AI_ANALYSIS_FAILED" };
  }
};

/* ------------------ helpers ------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizeCount = (value = "") => {
  const v = value.replace(/,/g, "").toUpperCase();
  if (v.endsWith("K")) return Math.round(parseFloat(v) * 1_000);
  if (v.endsWith("M")) return Math.round(parseFloat(v) * 1_000_000);
  return parseInt(v) || 0;
};

/* ------------------ human-like navigation ------------------ */

async function gotoHumanLike(page, url) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000
  });

  // Wait for React hydration
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="UserDescription"]') ||
      document.querySelector('[data-testid="tweetText"]') ||
      document.querySelector('[data-testid="primaryColumn"]'),
    { timeout: 20000 }
  );

  // Human pause
  await sleep(1200 + Math.random() * 1500);

  // Human scroll
  await page.evaluate(() => {
    window.scrollBy(0, 300 + Math.random() * 400);
  });

  await sleep(1000);
}

/* ------------------ fingerprint hardening ------------------ */

async function applyFingerprint(page) {
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/121.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9"
  });

  await page.setViewport({ width: 1280, height: 1600 });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"]
    });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    Object.defineProperty(navigator, "hardwareConcurrency", {
      get: () => 8
    });

    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5]
    });

    window.chrome = { runtime: {} };
  });
}

/* ------------------ scraper ------------------ */

async function scrapeX(twitterLink) {
  // Load browser with persistent x-session
  const browser = await puppeteer.launch({
    headless: "new",
    userDataDir: "./x-session", // reuse the warm-up session
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,1600"
    ]
  });

  const page = await browser.newPage();

  try {
    await applyFingerprint(page);

    await gotoHumanLike(page, twitterLink);

    const contextType =
      twitterLink.includes("/communities/")
        ? "community"
        : twitterLink.includes("/status/")
        ? "post"
        : "profile";

    const scrapedData = await page.evaluate((type) => {
      const text = (sel) =>
        document.querySelector(sel)?.innerText.trim() || "";

      const result = { type };

      if (type === "profile") {
        result.name = text('[data-testid="UserName"]');
        result.bio = text('[data-testid="UserDescription"]');
        result.isVerified = !!document.querySelector(
          '[data-testid="icon-verified"]'
        );

        const stat = (label) =>
          Array.from(document.querySelectorAll("a"))
            .find((a) => a.innerText.includes(label))
            ?.innerText.replace(label, "")
            .trim() || "0";

        result.followingCount = stat("Following");
        result.followerCount = stat("Followers");

        result.joinedDate =
          Array.from(document.querySelectorAll("span"))
            .find((s) => s.innerText.includes("Joined"))
            ?.innerText || "";
      }

      if (type === "post") {
        result.username = text('[data-testid="UserName"]');
        result.content = text('[data-testid="tweetText"]');
        result.isVerified = !!document.querySelector(
          '[data-testid="icon-verified"]'
        );

        const engagement = {};
        document
          .querySelectorAll(
            '[data-testid="reply"],[data-testid="retweet"],[data-testid="like"],[data-testid="bookmark"]'
          )
          .forEach((el) => {
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
        result.description =
          document.querySelector('[style*="-webkit-line-clamp"]')?.innerText ||
          "";
        result.isVerified = !!document.querySelector(
          '[data-testid="icon-verified"]'
        );

        const members = Array.from(document.querySelectorAll("span"))
          .find((s) => s.innerText === "Members")
          ?.parentElement?.innerText;

        result.memberCount = members?.replace("Members", "").trim() || "0";
      }

      return result;
    }, contextType);

    // normalize numbers
    if (scrapedData.engagement) {
      scrapedData.engagement = {
        comments: normalizeCount(scrapedData.engagement.comments || "0"),
        reposts: normalizeCount(scrapedData.engagement.reposts || "0"),
        likes: normalizeCount(scrapedData.engagement.likes || "0"),
        bookmarks: normalizeCount(scrapedData.engagement.bookmarks || "0")
      };
    }

    scrapedData.followingCount = normalizeCount(scrapedData.followingCount);
    scrapedData.followerCount = normalizeCount(scrapedData.followerCount);
    scrapedData.memberCount = normalizeCount(scrapedData.memberCount);

    return scrapedData;
  } catch (err) {
    console.error("SCRAPER_ERROR:", err.message);
    return null;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeX };
