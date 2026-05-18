import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import type { ResolvedVisualAsset } from "@fschat/shared";

export const DEFAULT_CODEX_MODELS = ["chatgpt-plan-default"];
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
const CODEX_CREDENTIALS_FILE = "codex_oauth_credentials.json";

type CodexCredentials = {
  access_token: string;
  refresh_token: string;
  expires: number;
  email?: string;
  accountId?: string;
};

const DEFAULT_CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  redirectUri: "http://localhost:1455/auth/callback",
  callbackHost: "127.0.0.1",
  callbackPort: 1455,
  scopes: "openid profile email offline_access",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  model: DEFAULT_CODEX_MODEL,
  originator: "cline",
  credentialsFile: path.join(os.homedir(), ".hello-files", CODEX_CREDENTIALS_FILE),
  legacyCredentialsFiles: [path.join(os.homedir(), ".filesystem-rag-chat", CODEX_CREDENTIALS_FILE)]
} as const;

const base64UrlEncode = (input: string) => Buffer.from(input).toString("base64url");

const cleanText = (value: unknown) => {
  if (value == null) {
    return "";
  }
  return String(value).trim().replace(/^["']|["']$/g, "").replace(/;$/, "").trim();
};

const decodeJwtPayload = (token: unknown): Record<string, any> => {
  const parts = cleanText(token).split(".");
  if (parts.length !== 3) {
    return {};
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
};

const extractAccountId = (tokenPayload: Record<string, any>) => {
  const authInfo = tokenPayload["https://api.openai.com/auth"];
  if (authInfo && typeof authInfo === "object" && authInfo.chatgpt_account_id) {
    return cleanText(authInfo.chatgpt_account_id);
  }

  if (Array.isArray(tokenPayload.organizations) && tokenPayload.organizations.length > 0) {
    return cleanText(tokenPayload.organizations[0]?.id);
  }

  return "";
};

const ensureParentDir = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const openBrowser = (url: string) => {
  const escapedUrl = `"${url.replace(/"/g, '\\"')}"`;
  const command =
    process.platform === "win32"
      ? `start "" ${escapedUrl}`
      : process.platform === "darwin"
        ? `open ${escapedUrl}`
        : `xdg-open ${escapedUrl}`;

  exec(command, () => {
    // Best-effort browser launch.
  });
};

const readUsageValue = (payload: any, directKey: string, nestedKey: string) => {
  if (typeof payload?.usage?.[directKey] === "number") {
    return payload.usage[directKey];
  }
  if (typeof payload?.usage?.[nestedKey] === "number") {
    return payload.usage[nestedKey];
  }
  if (typeof payload?.[directKey] === "number") {
    return payload[directKey];
  }
  return 0;
};

const collectTextFragments = (value: unknown): string[] => {
  if (typeof value === "string") {
    const cleaned = value.trim();
    return cleaned ? [cleaned] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextFragments(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const directText = [candidate.output_text, candidate.text, candidate.delta, candidate.content].flatMap((item) =>
    typeof item === "string" ? collectTextFragments(item) : []
  );

  if (directText.length > 0) {
    return directText;
  }

  return [
    ...collectTextFragments(candidate.part),
    ...collectTextFragments(candidate.parts),
    ...collectTextFragments(candidate.content),
    ...collectTextFragments(candidate.output),
    ...collectTextFragments(candidate.item),
    ...collectTextFragments(candidate.response)
  ];
};

const extractResponseText = (payload: unknown) => collectTextFragments(payload).join("\n").trim();

const parseSseEventBlock = (block: string) => {
  const dataLines = block
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  if (dataLines.length === 0) {
    return null;
  }

  const data = dataLines.join("\n");
  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

const readStreamedResponsePayload = async (response: Response) => {
  if (!response.body) {
    throw new Error("Codex response did not include a response body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputText = "";
  let completedResponse: any = null;
  const finalizedTextParts: string[] = [];

  const handleEvent = (event: any) => {
    if (!event || typeof event !== "object") {
      return;
    }

    if (event.type === "error") {
      throw new Error(event.error?.message || "Codex stream returned an error event.");
    }

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      outputText += event.delta;
      return;
    }

    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      finalizedTextParts[event.output_index ?? finalizedTextParts.length] = event.text;
      return;
    }

    if (event.type === "response.content_part.done") {
      const partText = extractResponseText(event.part);
      if (partText) {
        finalizedTextParts[event.output_index ?? finalizedTextParts.length] = partText;
      }
      return;
    }

    if (event.type === "response.output_item.done") {
      const itemText = extractResponseText(event.item);
      if (itemText) {
        finalizedTextParts[event.output_index ?? finalizedTextParts.length] = itemText;
      }
      return;
    }

    if (event.type === "response.failed") {
      throw new Error(event.response?.error?.message || "Codex response failed.");
    }

    if (event.type === "response.completed" && event.response) {
      completedResponse = event.response;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const normalized = buffer.replace(/\r\n/g, "\n");
    const chunks = normalized.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      handleEvent(parseSseEventBlock(chunk));
    }

    if (done) {
      handleEvent(parseSseEventBlock(buffer));
      break;
    }
  }

  const streamedText = finalizedTextParts.filter(Boolean).join("\n").trim() || outputText.trim();
  const completedText = extractResponseText(completedResponse);
  const finalText = streamedText || completedText;

  if (completedResponse && typeof completedResponse === "object") {
    return {
      ...completedResponse,
      output_text: cleanText((completedResponse as Record<string, unknown>).output_text) || finalText
    };
  }

  return {
    output_text: finalText,
    usage: {
      input_tokens: 0,
      output_tokens: 0
    }
  };
};

class CodexOAuthClient {
  private config = DEFAULT_CONFIG;

  generateCodeVerifier() {
    return base64UrlEncode(crypto.randomBytes(32).toString("hex"));
  }

  generateCodeChallenge(codeVerifier: string) {
    return crypto.createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  }

  generateState() {
    return crypto.randomBytes(16).toString("hex");
  }

  loadCredentials(): CodexCredentials | null {
    const credentials = this.readCredentialsFile(this.config.credentialsFile);
    if (credentials) {
      return credentials;
    }

    for (const filePath of this.config.legacyCredentialsFiles) {
      const legacyCredentials = this.readCredentialsFile(filePath);
      if (legacyCredentials) {
        this.saveCredentials(legacyCredentials);
        return legacyCredentials;
      }
    }

    return null;
  }

  saveCredentials(credentials: CodexCredentials) {
    ensureParentDir(this.config.credentialsFile);
    fs.writeFileSync(this.config.credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
  }

  clearCredentials() {
    for (const filePath of [this.config.credentialsFile, ...this.config.legacyCredentialsFiles]) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }

  private readCredentialsFile(filePath: string): CodexCredentials | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!cleanText(parsed.access_token) || !cleanText(parsed.refresh_token)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  credentialsExpired(credentials: CodexCredentials | null) {
    const expires = Number(credentials?.expires || 0);
    return Date.now() >= expires - 5 * 60 * 1000;
  }

  buildAuthorizationUrl({ codeChallenge, state }: { codeChallenge: string; state: string }) {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_type: "code",
      state,
      codex_cli_simplified_flow: "true",
      originator: this.config.originator
    });

    return `${this.config.authorizationEndpoint}?${params.toString()}`;
  }

  async postForm(url: string, formData: Record<string, string>) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(formData)
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

    return payload as Record<string, any>;
  }

  normalizeTokenPayload(payload: Record<string, any>, fallbackCredentials?: CodexCredentials | null): CodexCredentials {
    const accessToken = cleanText(payload.access_token);
    const refreshToken = cleanText(payload.refresh_token) || cleanText(fallbackCredentials?.refresh_token);
    const expiresIn = Number(payload.expires_in || 0);

    if (!accessToken || !refreshToken || !expiresIn) {
      throw new Error("Codex OAuth token response did not return the required tokens.");
    }

    const idPayload = decodeJwtPayload(payload.id_token);
    const accessPayload = decodeJwtPayload(accessToken);

    return {
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
        cleanText(fallbackCredentials?.accountId)
    };
  }

  async exchangeAuthCodeForTokens(code: string, codeVerifier: string) {
    const payload = await this.postForm(this.config.tokenEndpoint, {
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier
    });

    const credentials = this.normalizeTokenPayload(payload);
    this.saveCredentials(credentials);
    return credentials;
  }

  async refreshAccessToken(credentials: CodexCredentials) {
    const payload = await this.postForm(this.config.tokenEndpoint, {
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      refresh_token: cleanText(credentials.refresh_token)
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
      credentials
    };
  }

  async requestResponse({
    prompt,
    instructions = "",
    model,
    images = [],
    store = false
  }: {
    prompt: string;
    instructions?: string;
    model?: string;
    images?: ResolvedVisualAsset[];
    store?: boolean;
  }) {
    let { accessToken, credentials } = await this.getAccessToken();
    if (!accessToken) {
      const error = new Error("Codex login is required.");
      (error as Error & { status?: number }).status = 401;
      throw error;
    }

    const sendRequest = async (token: string, creds: CodexCredentials | null) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        originator: this.config.originator,
        session_id: crypto.randomUUID()
      };

      const accountId = cleanText(creds?.accountId);
      if (accountId) {
        headers["ChatGPT-Account-Id"] = accountId;
      }

      const response = await fetch(`${this.config.baseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: cleanText(model) || this.config.model,
          instructions,
          input: [
            {
              role: "user",
              content: buildCodexInputContent(prompt, images)
            }
          ],
          stream: true,
          store
        })
      });

      if (!response.ok) {
        const bodyText = await response.text();
        const error = new Error(`Codex request failed (${response.status}): ${bodyText}`);
        (error as Error & { status?: number }).status = response.status;
        throw error;
      }

      return readStreamedResponsePayload(response);
    };

    try {
      return await sendRequest(accessToken, credentials);
    } catch (error) {
      const status = (error as Error & { status?: number })?.status;
      if ((status === 401 || status === 403) && credentials) {
        credentials = await this.refreshAccessToken(credentials);
        accessToken = cleanText(credentials.access_token);
        return sendRequest(accessToken, credentials);
      }
      throw error;
    }
  }

  parseResponseText(payload: any) {
    if (!payload || typeof payload !== "object") {
      return "";
    }

    return extractResponseText(payload);
  }

  parseUsage(payload: any) {
    return {
      inputTokens: readUsageValue(payload, "input_tokens", "prompt_tokens"),
      outputTokens: readUsageValue(payload, "output_tokens", "completion_tokens")
    };
  }

  startBrowserLogin({ autoOpenBrowser = true, timeoutMs = 5 * 60 * 1000 } = {}) {
    const codeVerifier = this.generateCodeVerifier();
    const state = this.generateState();
    const authUrl = this.buildAuthorizationUrl({
      codeChallenge: this.generateCodeChallenge(codeVerifier),
      state
    });

    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let resolveFlow!: (credentials: CodexCredentials) => void;
    let rejectFlow!: (error: Error) => void;

    const completion = new Promise<CodexCredentials>((resolve, reject) => {
      resolveFlow = resolve;
      rejectFlow = reject;
    });

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", this.config.redirectUri);

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
        res.end(`Token exchange failed: ${(error as Error).message}`);
        rejectFlow(error instanceof Error ? error : new Error("Codex token exchange failed."));
      } finally {
        server.close();
      }
    });

    server.listen(this.config.callbackPort, this.config.callbackHost);
    server.on("error", (error) => {
      if (!settled) {
        settled = true;
        rejectFlow(error instanceof Error ? error : new Error("Codex login failed."));
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
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });

    if (autoOpenBrowser) {
      openBrowser(authUrl);
    }

    return {
      authUrl,
      waitForCompletion: () => completion
    };
  }
}

const codexClient = new CodexOAuthClient();

function buildCodexPrompt(
  history: Array<{ role: "assistant" | "user"; content: string }>,
  prompt: string
) {
  if (history.length === 0) {
    return prompt;
  }

  const transcript = history
    .map((item) => `${item.role === "assistant" ? "Assistant" : "User"}:\n${item.content}`)
    .join("\n\n");

  return ["Conversation so far:", transcript, "", "Current request:", prompt].join("\n");
}

export async function ensureCodexAuthorized() {
  const { accessToken } = await codexClient.getAccessToken();
  if (accessToken) {
    return;
  }
  const flow = codexClient.startBrowserLogin();
  await flow.waitForCompletion();
}

export function clearCodexCredentials() {
  codexClient.clearCredentials();
}

export async function callCodexText(args: {
  prompt: string;
  systemPrompt: string;
  history: Array<{ role: "assistant" | "user"; content: string }>;
  model?: string;
  images?: ResolvedVisualAsset[];
}) {
  const normalizeRequestedModel = (value?: string) => {
    const cleaned = cleanText(value);
    if (!cleaned || cleaned === "chatgpt-plan-default") {
      return DEFAULT_CODEX_MODEL;
    }
    return cleaned;
  };

  const requestedModel = normalizeRequestedModel(args.model);

  const run = async (model: string) =>
    codexClient.requestResponse({
      model,
      instructions: args.systemPrompt,
      prompt: buildCodexPrompt(args.history, args.prompt),
      images: args.images ?? []
    });

  let payload;
  try {
    payload = await run(requestedModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldRetryWithFallback =
      (message.includes("not supported when using Codex with a ChatGPT account") ||
        message.includes("does not exist"));

    if (!shouldRetryWithFallback) {
      throw error;
    }

    if (requestedModel === DEFAULT_CODEX_MODEL) {
      throw error;
    }

    payload = await run(DEFAULT_CODEX_MODEL);
  }

  return {
    text: codexClient.parseResponseText(payload),
    usage: codexClient.parseUsage(payload)
  };
}

function buildCodexInputContent(prompt: string, images: ResolvedVisualAsset[]) {
  return [
    { type: "input_text", text: prompt },
    ...images.map((image) => ({
      type: "input_image",
      image_url: `data:${image.mimeType};base64,${image.dataBase64}`
    }))
  ];
}
