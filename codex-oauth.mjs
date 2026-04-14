import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

export const DEFAULT_CODEX_MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini'];

const DEFAULT_CONFIG = {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    callbackHost: '127.0.0.1',
    callbackPort: 1455,
    scopes: 'openid profile email offline_access',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'gpt-5',
    originator: 'testgenai-rag',
    credentialsFile: path.join(os.homedir(), '.testgenai-rag', 'codex_oauth_credentials.json'),
};

const base64UrlEncode = (input) => Buffer.from(input).toString('base64url');

const cleanText = (value) => {
    if (value == null) return '';
    return String(value).trim().replace(/^["']|["']$/g, '').replace(/;$/, '').trim();
};

const decodeJwtPayload = (token) => {
    const parts = cleanText(token).split('.');
    if (parts.length !== 3) return {};

    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return {};
    }
};

const extractAccountId = (tokenPayload) => {
    if (!tokenPayload || typeof tokenPayload !== 'object') return '';

    const authInfo = tokenPayload['https://api.openai.com/auth'];
    if (authInfo && typeof authInfo === 'object' && authInfo.chatgpt_account_id) {
        return cleanText(authInfo.chatgpt_account_id);
    }

    if (Array.isArray(tokenPayload.organizations) && tokenPayload.organizations.length > 0) {
        return cleanText(tokenPayload.organizations[0]?.id);
    }

    return '';
};

const ensureParentDir = (filePath) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const openBrowser = (url) => {
    const escapedUrl = `"${url.replace(/"/g, '\\"')}"`;
    const platform = process.platform;
    const command =
        platform === 'win32'
            ? `start "" ${escapedUrl}`
            : platform === 'darwin'
                ? `open ${escapedUrl}`
                : `xdg-open ${escapedUrl}`;

    exec(command, () => {
        // Browser launch is best-effort; the caller still gets the auth URL.
    });
};

const readUsageValue = (payload, directKey, nestedKey) => {
    if (typeof payload?.usage?.[directKey] === 'number') return payload.usage[directKey];
    if (typeof payload?.usage?.[nestedKey] === 'number') return payload.usage[nestedKey];
    if (typeof payload?.[directKey] === 'number') return payload[directKey];
    return 0;
};

const parseSseEventBlock = (block) => {
    const dataLines = block
        .split('\n')
        .map((line) => line.replace(/\r$/, ''))
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim());

    if (dataLines.length === 0) return null;

    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') return null;

    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
};

const readStreamedResponsePayload = async (response) => {
    if (!response.body) {
        throw new Error('Codex response did not include a response body.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let outputText = '';
    let completedResponse = null;
    const finalizedTextParts = [];

    const handleEvent = (event) => {
        if (!event || typeof event !== 'object') return;

        if (event.type === 'error') {
            throw new Error(event.error?.message || 'Codex stream returned an error event.');
        }

        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            outputText += event.delta;
            return;
        }

        if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
            finalizedTextParts[event.output_index ?? finalizedTextParts.length] = event.text;
            return;
        }

        if (event.type === 'response.content_part.done' && typeof event.part?.text === 'string') {
            finalizedTextParts[event.output_index ?? finalizedTextParts.length] = event.part.text;
            return;
        }

        if (event.type === 'response.failed') {
            throw new Error(event.response?.error?.message || 'Codex response failed.');
        }

        if (event.type === 'response.completed' && event.response) {
            completedResponse = event.response;
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

        const normalized = buffer.replace(/\r\n/g, '\n');
        const chunks = normalized.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
            const event = parseSseEventBlock(chunk);
            handleEvent(event);
        }

        if (done) {
            const tailEvent = parseSseEventBlock(buffer);
            handleEvent(tailEvent);
            break;
        }
    }

    const finalText = finalizedTextParts.filter(Boolean).join('\n').trim() || outputText.trim();
    return completedResponse || {
        output_text: finalText,
        usage: {
            input_tokens: 0,
            output_tokens: 0,
        },
    };
};

export class CodexOAuthClient {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    generateCodeVerifier() {
        return base64UrlEncode(crypto.randomBytes(32).toString('hex'));
    }

    generateCodeChallenge(codeVerifier) {
        return crypto.createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
    }

    generateState() {
        return crypto.randomBytes(16).toString('hex');
    }

    loadCredentials() {
        if (!fs.existsSync(this.config.credentialsFile)) return null;

        try {
            const parsed = JSON.parse(fs.readFileSync(this.config.credentialsFile, 'utf8'));
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
        fs.writeFileSync(this.config.credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
    }

    clearCredentials() {
        if (fs.existsSync(this.config.credentialsFile)) {
            fs.unlinkSync(this.config.credentialsFile);
        }
    }

    credentialsExpired(credentials) {
        const expires = Number(credentials?.expires || 0);
        return Date.now() >= expires - (5 * 60 * 1000);
    }

    buildAuthorizationUrl({ codeChallenge, state }) {
        const params = new URLSearchParams({
            client_id: this.config.clientId,
            redirect_uri: this.config.redirectUri,
            scope: this.config.scopes,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            response_type: 'code',
            state,
            codex_cli_simplified_flow: 'true',
            originator: this.config.originator,
        });

        return `${this.config.authorizationEndpoint}?${params.toString()}`;
    }

    async postForm(url, formData) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
            throw new Error('Codex OAuth token response did not return the required tokens.');
        }

        const idPayload = decodeJwtPayload(payload.id_token);
        const accessPayload = decodeJwtPayload(accessToken);

        return {
            type: 'openai-codex',
            access_token: accessToken,
            refresh_token: refreshToken,
            expires: Date.now() + (expiresIn * 1000),
            email:
                cleanText(payload.email) ||
                cleanText(idPayload['https://api.openai.com/profile']?.email) ||
                cleanText(fallbackCredentials?.email),
            accountId:
                extractAccountId(idPayload) ||
                extractAccountId(accessPayload) ||
                cleanText(fallbackCredentials?.accountId),
        };
    }

    async exchangeAuthCodeForTokens(code, codeVerifier) {
        const payload = await this.postForm(this.config.tokenEndpoint, {
            grant_type: 'authorization_code',
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
            grant_type: 'refresh_token',
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

    async requestResponse({ prompt, instructions = '', model, stream = false, store = false }) {
        let { accessToken, credentials } = await this.getAccessToken();
        if (!accessToken) {
            const error = new Error('Codex login is required.');
            error.status = 401;
            throw error;
        }

        const sendRequest = async (token, creds) => {
            const headers = {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                Authorization: `Bearer ${token}`,
                originator: this.config.originator,
                session_id: crypto.randomUUID(),
            };

            const accountId = cleanText(creds?.accountId);
            if (accountId) {
                headers['ChatGPT-Account-Id'] = accountId;
            }

            const response = await fetch(`${this.config.baseUrl}/responses`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: model || this.config.model,
                    instructions,
                    input: [
                        {
                            role: 'user',
                            content: [{ type: 'input_text', text: prompt }],
                        },
                    ],
                    stream: true,
                    store,
                }),
            });

            if (!response.ok) {
                const bodyText = await response.text();
                const error = new Error(`Codex request failed (${response.status}): ${bodyText}`);
                error.status = response.status;
                throw error;
            }

            return await readStreamedResponsePayload(response);
        };

        try {
            return await sendRequest(accessToken, credentials);
        } catch (error) {
            if (error?.status === 401 || error?.status === 403) {
                credentials = await this.refreshAccessToken(credentials || {});
                accessToken = cleanText(credentials.access_token);
                return await sendRequest(accessToken, credentials);
            }
            throw error;
        }
    }

    parseResponseText(payload) {
        if (!payload || typeof payload !== 'object') return '';

        if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
            return payload.output_text.trim();
        }

        const collected = [];
        for (const item of payload.output || []) {
            if (!item || typeof item !== 'object') continue;
            for (const content of item.content || []) {
                if (!content || typeof content !== 'object') continue;
                const text = content.text || content.output_text;
                if (typeof text === 'string' && text) {
                    collected.push(text);
                }
            }
        }

        return collected.join('\n').trim();
    }

    parseUsage(payload) {
        return {
            inputTokens: readUsageValue(payload, 'input_tokens', 'prompt_tokens'),
            outputTokens: readUsageValue(payload, 'output_tokens', 'completion_tokens'),
        };
    }

    startBrowserLogin({ autoOpenBrowser = true, timeoutMs = 5 * 60 * 1000 } = {}) {
        const codeVerifier = this.generateCodeVerifier();
        const state = this.generateState();
        const authUrl = this.buildAuthorizationUrl({
            codeChallenge: this.generateCodeChallenge(codeVerifier),
            state,
        });
        const flowId = crypto.randomUUID().replace(/-/g, '');

        let settled = false;
        let timeoutId;

        const completeFromManualInput = async (manualInput) => {
            const raw = cleanText(manualInput);
            if (!raw) throw new Error('Authorization code or redirect URL is required.');

            let code = raw;
            let receivedState = '';

            if (raw.includes('://')) {
                const parsed = new URL(raw);
                code = cleanText(parsed.searchParams.get('code'));
                receivedState = cleanText(parsed.searchParams.get('state'));
            }

            if (!code) throw new Error('Could not find an authorization code in the provided input.');
            if (receivedState && receivedState !== state) {
                throw new Error('The pasted redirect URL does not match the active login state.');
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
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
                return;
            }

            const errorValue = cleanText(url.searchParams.get('error'));
            const codeValue = cleanText(url.searchParams.get('code'));
            const stateValue = cleanText(url.searchParams.get('state'));

            if (errorValue) {
                settled = true;
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Authentication failed: ${errorValue}`);
                rejectFlow(new Error(`OAuth error: ${errorValue}`));
                server.close();
                return;
            }

            if (!codeValue || stateValue !== state) {
                settled = true;
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Invalid callback state or missing code.');
                rejectFlow(new Error('Invalid callback state or missing code.'));
                server.close();
                return;
            }

            try {
                const credentials = await this.exchangeAuthCodeForTokens(codeValue, codeVerifier);
                settled = true;
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<!DOCTYPE html><html><body><h2>Codex login complete</h2><p>You can return to the app.</p></body></html>');
                resolveFlow(credentials);
            } catch (error) {
                settled = true;
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Token exchange failed: ${error.message}`);
                rejectFlow(error);
            } finally {
                server.close();
            }
        });

        server.listen(this.config.callbackPort, this.config.callbackHost);

        server.on('error', (error) => {
            if (!settled) {
                settled = true;
                rejectFlow(error);
            }
        });

        timeoutId = setTimeout(() => {
            if (!settled) {
                settled = true;
                rejectFlow(new Error('Codex OAuth login timed out waiting for the callback.'));
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
            close: () => new Promise((resolve) => {
                clearTimeout(timeoutId);
                server.close(() => resolve());
            }),
        };
    }
}
