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
    console.error("AI_PARSE_ERROR:", err.message, "\nRAW_RESPONSE:", err.raw || "");
    return { error: "AI_ANALYSIS_FAILED" };
  }
};


const normalizeCount = (value = "") => {
  const v = value.replace(/,/g, "").toUpperCase();
  if (v.endsWith("K")) return parseFloat(v) * 1_000;
  if (v.endsWith("M")) return parseFloat(v) * 1_000_000;
  return parseInt(v) || 0;
};

const offChainAnalyze = async (twitterLink) => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 1600 });
    await page.goto(twitterLink, { waitUntil: "networkidle2", timeout: 30000 });

    await page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 10000 });

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

      if (type === "community") {
        result.name = text('h2[role="heading"]');
        result.description =
          document.querySelector('[style*="-webkit-line-clamp"]')?.innerText || "";
        result.isVerified = !!document.querySelector('[data-testid="icon-verified"]');

        const members = Array.from(document.querySelectorAll("span"))
          .find((s) => s.innerText === "Members")
          ?.parentElement?.innerText;

        result.memberCount = members?.replace("Members", "").trim() || "0";
      }

      if (type === "profile") {
        result.name = text('[data-testid="UserName"]');
        result.bio = text('[data-testid="UserDescription"]');
        result.isVerified = !!document.querySelector('[data-testid="icon-verified"]');

        const stat = (label) =>
          Array.from(document.querySelectorAll("a"))
            .find((a) => a.innerText.includes(label))
            ?.innerText.replace(label, "")
            .trim() || "0";

        result.followerCount = stat("Followers");
        result.followingCount = stat("Following");
        result.joinedDate =
          Array.from(document.querySelectorAll("span"))
            .find((s) => s.innerText.includes("Joined"))
            ?.innerText || "";
      }

      if (type === 'post') {
        // In single post view, the main tweet is often the first 'article' or tweet test-id
        result.username = text('[data-testid="User-Name"]');
        result.content = text('[data-testid="tweetText"]');
        result.engagement = text('[role="group"][aria-label*="replies"]');
        result.isVerified = !!document.querySelector('[data-testid="icon-verified"]');
      }

      const posts = [];
      document
        .querySelectorAll('[data-testid="tweet"]')
        .forEach((t) => {
          const content = t.querySelector('[data-testid="tweetText"]')?.innerText;
          const stats = t.querySelector('[role="group"]')?.ariaLabel;
          if (content) posts.push({ content, stats });
        });

      result.recentActivity = posts.slice(0, 3);
      return result;
    }, contextType);


    const engagementStr = scrapedData.engagement;
    // Split by new line
    const parts = engagementStr.split('\n');

    // Map to structured object
    scrapedData.engagement = {
      comments: normalizeCount(parts[0]),
      reposts: normalizeCount(parts[1]),
      likes: normalizeCount(parts[2]),
      bookmarks: normalizeCount(parts[3])
    };;
    scrapedData.followingCount = normalizeCount(scrapedData.followingCount);
    scrapedData.followerCount = normalizeCount(scrapedData.followerCount);
    scrapedData.memberCount = normalizeCount(scrapedData.memberCount);

    // const analysis = await analyzeProjectData(scrapedData);

    return scrapedData;
  } catch (err) {
    console.error("SCRAPER_ERROR:", err.message);
    return null;
  } finally {
    await browser.close();
  }
};

module.exports = { offChainAnalyze };