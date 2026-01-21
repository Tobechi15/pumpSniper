const { Scraper } = require('agent-twitter-client');
const fs = require('fs');

async function generateAndStoreSession(username, password, email) {
    const scraper = new Scraper();
    
    console.log(`Logging in as ${username}...`);
    await scraper.login(username, password, email);
    
    if (await scraper.isLoggedIn()) {
        const cookies = await scraper.getCookies();
        
        // Convert cookies to a JSON string for storage
        const cookieString = JSON.stringify(cookies);
        
        console.log("--- COPY THE STRING BELOW INTO YOUR ACCOUNTS_JSON ---");
        console.log(cookieString);
        
        // Optional: Save to a local file for backup
        fs.writeFileSync(`./${username}_session.json`, cookieString);
        return cookies;
    } else {
        console.error("Login failed. Check credentials or 2FA requirements.");
    }
}

// Usage: node get_session.js
generateAndStoreSession("kaleeburne97834", "toocool10", "kaeleerenegolf@gmail.com");