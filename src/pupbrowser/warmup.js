// warmup.js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function warmUpXSession(page) {
  await page.goto("https://x.com/pubity/status/2014435780102418733", {
    waitUntil: "domcontentloaded",
    timeout: 0
  });

  // Allow first-load checks + hydration
  await sleep(3000);

  // Human scroll
  await page.evaluate(() => {
    window.scrollBy(0, 500);
  });

  await sleep(2000);
}

module.exports = { warmUpXSession };
