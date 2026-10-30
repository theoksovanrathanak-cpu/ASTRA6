# Fix Gmail not sending on Render Free - HTTP Webhook via Google Apps Script

## Root Cause Found:
Render FREE plan blocks outbound SMTP ports 465 and 587 with error:
`[Errno 101] Network is unreachable`
This is intentional to prevent spam. Your SMTP_PASS is correctly set (16 chars, no spaces, starts dvl***), but Render free firewall blocks it.

Debug endpoint proves it:
GET https://astra6.onrender.com/api/debug/smtp
→ smtp_pass_set: true, len 16, no spaces ✅

GET https://astra6.onrender.com/api/debug/smtp-test
→ 465 FAIL Network unreachable, 587 FAIL Network unreachable ❌

## Solutions (choose one):

### Option 1: Upgrade Render to Paid ($7/mo) - EASIEST, SMTP works immediately
1. Render Dashboard → astra6 service → Scale → Upgrade to Starter $7/mo
2. SMTP will work instantly, no code change
3. Your current env vars already correct:
   SMTP_HOST=smtp.gmail.com
   SMTP_USER=astra6render@gmail.com
   SMTP_PASS=dvlgqfnumbhinqvi
   SMTP_PORT=587

### Option 2: Use HTTP Email Webhook (FREE, works on free plan) - RECOMMENDED FOR FREE
Create Google Apps Script that sends Gmail via Google's internal API (uses HTTP, not SMTP, so not blocked)

Steps:
1. Go to https://script.google.com → New Project
2. Paste this code:

```javascript
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var to = data.to;
    var resetLink = data.reset_link;
    var token = data.reset_token;
    var email = data.email;
    var logoUrl = data.logo_url || "https://astra6.onrender.com/logo.png";
    
    var subject = "ASTRA6 - Password Reset Link";
    var html = `
      <div style="max-width:500px;margin:0 auto;border:2px solid #000;border-radius:14px;overflow:hidden;font-family:Arial">
        <div style="background:#fff;padding:20px;text-align:center;border-bottom:2px solid #000">
          <img src="${logoUrl}" alt="ASTRA6" style="height:60px"><br>
          <h2 style="margin:8px 0 0 0;font-weight:900">ASTRA6</h2>
          <p style="color:#666;font-size:11px">BEST GOLD SIGNALS</p>
        </div>
        <div style="padding:24px">
          <h3>Password Reset</h3>
          <p>Hi ${email},</p>
          <p>Reset Link (expires 1 hour):</p>
          <div style="background:#f5f5f5;border:1px solid #000;padding:12px;border-radius:10px;word-break:break-all">
            <a href="${resetLink}" style="color:#000;font-weight:900">${resetLink}</a>
          </div>
          <p>Token:</p>
          <div style="background:#000;color:#fff;padding:12px;border-radius:10px;word-break:break-all;font-family:monospace">${token}</div>
          <p>Go to https://astra6.onrender.com → Sign In → Forgot password? → Paste token</p>
        </div>
        <div style="background:#000;color:#fff;padding:12px;text-align:center;font-size:10px">
          From: astra6render@gmail.com - ASTRA6 Owner
        </div>
      </div>
    `;
    
    GmailApp.sendEmail(to, subject, "Reset link: " + resetLink + " Token: " + token, {htmlBody: html});
    return ContentService.createTextOutput(JSON.stringify({status:"ok", sent_to: to})).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({status:"error", error: err.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}
```

3. Click Deploy → New Deployment → Web App
   - Execute as: Me (astra6render@gmail.com)
   - Who has access: Anyone
   - Copy Web App URL (looks like https://script.google.com/macros/s/.../exec)
4. In Render Dashboard → Environment → Add:
   - EMAIL_WEBHOOK_URL = your Google Apps Script URL
5. Save → Redeploy → Gmail will now send via HTTP (works on free!)

### Option 3: Current Workaround (Already Working)
Forgot password already returns reset_link immediately for copy-paste:
- User enters email → gets link + token + copy buttons instantly (1 sec, no timeout)
- Token auto-filled, user can change password without Gmail
- Admin panel shows all reset tokens for manual Gmail send
- Admin can copy token and manually send via Gmail app astra6render@gmail.com

This works now even without SMTP!

## Current Live Status:
- SMTP_PASS set correctly ✅ (16 chars, no spaces)
- Forgot password returns reset_link in 1 sec ✅ (no timeout, background thread)
- Gmail SMTP blocked by Render free ❌ (Network unreachable)
- Workaround copy-paste works ✅
- Admin fallback works ✅

## Recommended:
Use Option 2 (Google Apps Script webhook) to get Gmail working on free plan with same logo, or Option 1 upgrade to $7/mo for SMTP.
