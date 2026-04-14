# Use Codex as LLM instead of API call using API Key


- PKCE auth URL generation
- loopback callback listener on `127.0.0.1:1455`
- auth-code exchange and refresh-token flow
- local credential cache
- Codex request submission to `https://chatgpt.com/backend-api/codex/responses`

Basic usage is:

```js
const { CodexOAuthClient } = require("./codex-oauth");

const client = new CodexOAuthClient();
const flow = client.startBrowserLogin();
console.log(flow.authUrl);
const credentials = await flow.waitForCompletion();

const payload = await client.requestResponse({
  prompt: "Hello",
  instructions: "You are Codex, based on GPT-5.",
});

console.log(client.parseResponseText(payload));
```

I verified syntax with `node --check` for both files. I did not run the full login flow end-to-end because that would require an actual interactive OAuth login in your browser.

One important constraint: this is for Node/backend JavaScript. If your other app is a pure browser SPA, you should not put this logic in the frontend. In that case, move this module behind your server/API layer. If you want, I can adapt this next for `Express`, `Next.js`, or `Electron`.

# codex-oauth.js

```
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { exec } = require("child_process");

const DEFAULT_CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  redirectUri: "http://localhost:1455/auth/callback",
  callbackHost: "127.0.0.1",
  callbackPort: 1455,
  scopes: "openid profile email offline_access",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  model: "gpt-5",
  originator: "cline",
  credentialsFile: path.join(os.homedir(), ".db-val-bot", "codex_oauth_credentials.json"),
};

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function cleanText(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim().replace(/^["']|["']$/g, "").replace(/;$/, "").trim();
}

function decodeJwtPayload(token) {
  const parts = cleanText(token).split(".");
  if (parts.length !== 3) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function extractAccountId(tokenPayload) {
  if (!tokenPayload || typeof tokenPayload !== "object") {
    return "";
  }

  const authInfo = tokenPayload["https://api.openai.com/auth"];
  if (authInfo && typeof authInfo === "object" && authInfo.chatgpt_account_id) {
    return cleanText(authInfo.chatgpt_account_id);
  }

  if (Array.isArray(tokenPayload.organizations) && tokenPayload.organizations.length > 0) {
    return cleanText(tokenPayload.organizations[0]?.id);
  }

  return "";
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function openBrowser(url) {
  const escapedUrl = `"${url.replace(/"/g, '\\"')}"`;
  const platform = process.platform;
  const command =
    platform === "win32"
      ? `start "" ${escapedUrl}`
      : platform === "darwin"
        ? `open ${escapedUrl}`
        : `xdg-open ${escapedUrl}`;

  exec(command, (error) => {
    if (error) {
      // Ignore browser launch failures; callers still receive the auth URL.
    }
  });
}

class CodexOAuthClient {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  generateCodeVerifier() {
    return base64UrlEncode(crypto.randomBytes(32).toString("hex"));
  }

  generateCodeChallenge(codeVerifier) {
    return crypto.createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  }

  generateState() {
    return crypto.randomBytes(16).toString("hex");
  }

  loadCredentials() {
    if (!fs.existsSync(this.config.credentialsFile)) {
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.config.credentialsFile, "utf8"));
      if (!cleanText(parsed.access_token) || !cleanText(parsed.refresh_token)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  saveCredentials(credentials) {
    ensureParentDir(this.config.credentialsFile);
    fs.writeFileSync(this.config.credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
  }

  clearCredentials() {
    if (fs.existsSync(this.config.credentialsFile)) {
      fs.unlinkSync(this.config.credentialsFile);
    }
  }

  credentialsExpired(credentials) {
    const expires = Number(credentials?.expires || 0);
    return Date.now() >= expires - 5 * 60 * 1000;
  }

  buildAuthorizationUrl({ codeChallenge, state }) {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_type: "code",
      state,
      codex_cli_simplified_flow: "true",
      originator: this.config.originator,
    });

    return `${this.config.authorizationEndpoint}?${params.toString()}`;
  }

  async postForm(url, formData) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(formData),
    });

    const bodyText = await response.text();
    let payload = {};

    try {
      payload = JSON.parse(bodyText);
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}: ${bodyText}`);
    }

    return payload;
  }

  normalizeTokenPayload(payload, fallbackCredentials) {
    const accessToken = cleanText(payload.access_token);
    const refreshToken = cleanText(payload.refresh_token) || cleanText(fallbackCredentials?.refresh_token);
    const expiresIn = Number(payload.expires_in || 0);

    if (!accessToken || !refreshToken || !expiresIn) {
      throw new Error("Codex OAuth token response did not return the required tokens.");
    }

    const idPayload = decodeJwtPayload(payload.id_token);
    const accessPayload = decodeJwtPayload(accessToken);

    return {
      type: "openai-codex",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires: Date.now() + expiresIn * 1000,
      email:
        cleanText(payload.email) ||
        cleanText(idPayload["https://api.openai.com/profile"]?.email) ||
        cleanText(fallbackCredentials?.email),
      accountId:
        extractAccountId(idPayload) ||
        extractAccountId(accessPayload) ||
        cleanText(fallbackCredentials?.accountId),
    };
  }

  async exchangeAuthCodeForTokens(code, codeVerifier) {
    const payload = await this.postForm(this.config.tokenEndpoint, {
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });

    const credentials = this.normalizeTokenPayload(payload);
    this.saveCredentials(credentials);
    return credentials;
  }

  async refreshAccessToken(credentials) {
    const payload = await this.postForm(this.config.tokenEndpoint, {
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      refresh_token: cleanText(credentials?.refresh_token),
    });

    const refreshed = this.normalizeTokenPayload(payload, credentials);
    this.saveCredentials(refreshed);
    return refreshed;
  }

  async getAccessToken() {
    let credentials = this.loadCredentials();
    if (!credentials) {
      return { accessToken: null, credentials: null };
    }

    if (this.credentialsExpired(credentials)) {
      credentials = await this.refreshAccessToken(credentials);
    }

    return {
      accessToken: cleanText(credentials.access_token),
      credentials,
    };
  }

  async requestResponse({ prompt, instructions, model, stream = false, store = false }) {
    let { accessToken, credentials } = await this.getAccessToken();
    if (!accessToken) {
      throw new Error("Codex login is required.");
    }

    const sendRequest = async (token, creds) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        originator: this.config.originator,
        session_id: crypto.randomUUID(),
      };

      const accountId = cleanText(creds?.accountId);
      if (accountId) {
        headers["ChatGPT-Account-Id"] = accountId;
      }

      const response = await fetch(`${this.config.baseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model || this.config.model,
          instructions: instructions || "",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: prompt,
                },
              ],
            },
          ],
          stream,
          store,
        }),
      });

      const bodyText = await response.text();
      let payload = {};

      try {
        payload = JSON.parse(bodyText);
      } catch {
        payload = {};
      }

      if (!response.ok) {
        const error = new Error(`Codex request failed (${response.status}): ${bodyText}`);
        error.status = response.status;
        throw error;
      }

      return payload;
    };

    try {
      return await sendRequest(accessToken, credentials);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        credentials = await this.refreshAccessToken(credentials || {});
        accessToken = cleanText(credentials.access_token);
        return sendRequest(accessToken, credentials);
      }
      throw error;
    }
  }

  parseResponseText(payload) {
    if (!payload || typeof payload !== "object") {
      return "";
    }

    if (typeof payload.output_text === "string" && payload.output_text.trim()) {
      return payload.output_text.trim();
    }

    const collected = [];
    for (const item of payload.output || []) {
      if (!item || typeof item !== "object") {
        continue;
      }
      for (const content of item.content || []) {
        if (!content || typeof content !== "object") {
          continue;
        }
        const text = content.text || content.output_text;
        if (typeof text === "string" && text) {
          collected.push(text);
        }
      }
    }

    return collected.join("\n").trim();
  }

  startBrowserLogin({ autoOpenBrowser = true, timeoutMs = 5 * 60 * 1000 } = {}) {
    const codeVerifier = this.generateCodeVerifier();
    const state = this.generateState();
    const authUrl = this.buildAuthorizationUrl({
      codeChallenge: this.generateCodeChallenge(codeVerifier),
      state,
    });
    const flowId = crypto.randomUUID().replace(/-/g, "");

    let settled = false;
    let timeoutId;

    const completeFromManualInput = async (manualInput) => {
      const raw = cleanText(manualInput);
      if (!raw) {
        throw new Error("Authorization code or redirect URL is required.");
      }

      let code = raw;
      let receivedState = "";

      if (raw.includes("://")) {
        const parsed = new URL(raw);
        code = cleanText(parsed.searchParams.get("code"));
        receivedState = cleanText(parsed.searchParams.get("state"));
      }

      if (!code) {
        throw new Error("Could not find an authorization code in the provided input.");
      }

      if (receivedState && receivedState !== state) {
        throw new Error("The pasted redirect URL does not match the active login state.");
      }

      return this.exchangeAuthCodeForTokens(code, codeVerifier);
    };

    let resolveFlow;
    let rejectFlow;
    const completion = new Promise((resolve, reject) => {
      resolveFlow = resolve;
      rejectFlow = reject;
    });

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, this.config.redirectUri);

      if (url.pathname !== new URL(this.config.redirectUri).pathname) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      const errorValue = cleanText(url.searchParams.get("error"));
      const codeValue = cleanText(url.searchParams.get("code"));
      const stateValue = cleanText(url.searchParams.get("state"));

      if (errorValue) {
        settled = true;
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Authentication failed: ${errorValue}`);
        rejectFlow(new Error(`OAuth error: ${errorValue}`));
        server.close();
        return;
      }

      if (!codeValue || stateValue !== state) {
        settled = true;
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid callback state or missing code.");
        rejectFlow(new Error("Invalid callback state or missing code."));
        server.close();
        return;
      }

      try {
        const credentials = await this.exchangeAuthCodeForTokens(codeValue, codeVerifier);
        settled = true;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!DOCTYPE html><html><body><h2>Codex login complete</h2><p>You can return to the app.</p></body></html>");
        resolveFlow(credentials);
      } catch (error) {
        settled = true;
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Token exchange failed: ${error.message}`);
        rejectFlow(error);
      } finally {
        server.close();
      }
    });

    server.listen(this.config.callbackPort, this.config.callbackHost);

    server.on("error", (error) => {
      if (!settled) {
        settled = true;
        rejectFlow(error);
      }
    });

    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectFlow(new Error("Codex OAuth login timed out waiting for the callback."));
        server.close();
      }
    }, timeoutMs);

    completion.finally(() => {
      clearTimeout(timeoutId);
    });

    if (autoOpenBrowser) {
      openBrowser(authUrl);
    }

    return {
      flowId,
      authUrl,
      state,
      codeVerifier,
      completeFromManualInput,
      waitForCompletion: () => completion,
      close: () =>
        new Promise((resolve) => {
          clearTimeout(timeoutId);
          server.close(() => resolve());
        }),
    };
  }
}

module.exports = {
  CodexOAuthClient,
  DEFAULT_CONFIG,
};

```

# codex-oauth-example.js

```
const { CodexOAuthClient } = require("./codex-oauth");

async function main() {
  const client = new CodexOAuthClient();
  let credentials = client.loadCredentials();

  if (!credentials) {
    const flow = client.startBrowserLogin();
    console.log("OpenAI Codex OAuth started.");
    console.log(`If your browser does not open, visit:\n${flow.authUrl}\n`);

    try {
      credentials = await flow.waitForCompletion();
      console.log(`Logged in as ${credentials.email || "unknown account"}.`);
    } catch (error) {
      console.error(`Login failed: ${error.message}`);
      process.exit(1);
    }
  }

  try {
    const payload = await client.requestResponse({
      prompt: "Reply with one sentence confirming the Codex OAuth integration works.",
      instructions: "You are Codex, based on GPT-5.",
    });
    console.log(client.parseResponseText(payload) || JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

main();
```