// detectBot.js
const dns = require('dns');
const { UAParser } = require('ua-parser-js');
const ipRangeCheck = require('ip-range-check');
const crawlerUserAgents = require('crawler-user-agents');
const { botUAList } = require('./middleware/botUA.cjs');
const { botIPList, botIPRangeList, botIPCIDRRangeList, botIPWildcardRangeList } = require('./middleware/botIP.cjs');
const { botRefList } = require('./middleware/botRef.cjs');
const { blockedHost } = require('./middleware/blockedHost.cjs');

function getReqClientIP(req) {
  return (
    req.headers['cf-connecting-ip'] ||       // Cloudflare
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() || // proxies
    req.socket?.remoteAddress ||             // fallback
    req.connection?.remoteAddress || null
  );
}

/**
 * Check if an IP belongs to known bot IPs or ranges
 */
function isBotIP(ipAddress) {
    if (!ipAddress) return false;
    ipAddress = ipAddress.startsWith('::ffff:') ? ipAddress.slice(7) : ipAddress;

    const IPtoNum = ip => ip.split('.').map(d => ('000' + d).substr(-3)).join('');

    return (
        botIPList.some(botIP => ipAddress.includes(botIP)) ||
        botIPRangeList.some(([min, max]) => IPtoNum(ipAddress) >= IPtoNum(min) && IPtoNum(ipAddress) <= IPtoNum(max)) ||
        botIPCIDRRangeList.some(cidr => ipRangeCheck(ipAddress, cidr)) ||
        botIPWildcardRangeList.some(pattern => ipAddress.match(pattern) !== null)
    );
} 

/**
 * Check if referrer URL indicates a bot
 */
function isBotRef(referer) {
    return botRefList.some(ref => referer && referer.toLowerCase().includes(ref));
}

/**
 * Check if a User-Agent string matches known crawlers
 */
const isCrawler = (userAgent) => {
    return crawlerUserAgents.some(crawler =>
        new RegExp(crawler.pattern, 'i').test(userAgent)
    );
};

/**
 * Combined bot detection middleware
 */
const detectBotMiddleware = (req, res, next) => {
    const ip = getReqClientIP(req);
    const userAgent = req.headers['user-agent'] || "Unknown User-Agent";

    // Parse the User-Agent string
    const parser = new UAParser();
    const uaResult = parser.setUA(userAgent).getResult();

    // Extract OS and browser information
    const os = uaResult.os.name || "Unknown OS Platform";
    const browser = uaResult.browser.name || "Unknown Browser";

    console.log(`Detected IP: ${ip}, OS: ${os}, Browser: ${browser}, User-Agent: ${userAgent}`);

    // Block obvious crawlers
    if (isCrawler(userAgent)) {
        console.log(`Blocked crawler: User-Agent: ${userAgent}, IP: ${ip}`);
        return res.status(403).send('Crawlers are not allowed');
    }

    // Skip reverse lookup for private/local IPs
    const privateIP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
    if (privateIP.test(ip)) {
        return next();
    }

    // Perform reverse DNS lookup
    dns.reverse(ip, (err, hostnames) => {
        // Ignore missing reverse DNS (ENOTFOUND = no PTR record)
        if (err) {
            if (err.code !== 'ENOTFOUND') {
                console.error('Unexpected DNS error:', err);
            }
            return next();
        }

        // If no hostnames returned, continue silently
        if (!hostnames || hostnames.length === 0) {
            return next();
        }

        // Check if hostname contains blocked keywords
        const isBlocked = hostnames.some(hostname =>
            blockedHost.some(word => hostname.toLowerCase().includes(word))
        );

        if (isBlocked) {
            console.log(`Blocked request from hostname: ${hostnames.join(', ')}`);
            return res.status(404).send('Not found');
        }

        // Block suspicious IP/OS/Browser combos
        if (
            ip === "92.23.57.168" ||
            ip === "96.31.1.4" ||
            ip === "207.96.148.8" ||
            (os === "Windows Server 2003/XP x64" && browser === "Firefox") ||
            (os === "Windows 7" && browser === "Firefox") ||
            (os === "Windows XP" && ["Firefox", "Internet Explorer", "Chrome"].includes(browser)) ||
            (os === "Windows Vista" && browser === "Internet Explorer") ||
            ["Windows Vista", "Ubuntu", "Chrome OS", "BlackBerry", "Linux"].includes(os) ||
            browser === "Internet Explorer" ||
            os === "Windows 2000" ||
            os === "Unknown OS Platform" ||
            browser === "Unknown Browser"
        ) {
            console.log(`Blocked request: IP: ${ip}, OS: ${os}, Browser: ${browser}`);
            return res.status(404).send('Not found');
        }

        // If no blocking rule matched, allow request
        next();
    });
};

// Export all functions
module.exports = {
    isBotIP,
    isBotRef,
    isCrawler,
    detectBotMiddleware
};
