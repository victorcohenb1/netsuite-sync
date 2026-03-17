import OAuth from "oauth-1.0a";
import crypto from "crypto";
import { env } from "../config/env";
import { childLogger } from "../lib/logger";

const log = childLogger({ module: "netsuite-auth" });

// ── Credentials ────────────────────────────────────────

const CONSUMER_KEY = env.NETSUITE_CONSUMER_KEY;
const CONSUMER_SECRET = env.NETSUITE_CONSUMER_SECRET;
const TOKEN_ID = env.NETSUITE_TOKEN_ID;
const TOKEN_SECRET = env.NETSUITE_TOKEN_SECRET;
const REALM = env.NETSUITE_ACCOUNT_ID.replace(/-/g, "_").toUpperCase();

// ── SuiteTalk REST signing (library-based, works fine) ─

const oauth = new OAuth({
  consumer: { key: CONSUMER_KEY, secret: CONSUMER_SECRET },
  signature_method: "HMAC-SHA256",
  hash_function(baseString, key) {
    return crypto.createHmac("sha256", key).update(baseString).digest("base64");
  },
});

const token = { key: TOKEN_ID, secret: TOKEN_SECRET };

export function signRequest(
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE"
): Record<string, string> {
  const authHeader = oauth.toHeader(
    oauth.authorize({ url, method }, token)
  ) as { Authorization: string };

  return {
    Authorization: authHeader.Authorization,
    "Content-Type": "application/json",
  };
}

// ── RESTlet signing (manual, mirrors Apps Script) ──────

function rfc3986Encode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function generateTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Manual OAuth 1.0 signing for NetSuite RESTlets.
 *
 * Step-by-step, identical to what Apps Script does:
 *
 * 1. Strip query string from URL → base URL for signature
 * 2. Parse query params (script, deploy) → include in signed param set
 * 3. Build OAuth params (consumer_key, token, nonce, timestamp, method, version)
 * 4. Merge query params + OAuth params, sort alphabetically
 * 5. Build parameter string: key=value joined by &
 * 6. Build signature base string: METHOD&encoded_base_url&encoded_param_string
 * 7. Build signing key: encoded_consumer_secret&encoded_token_secret
 * 8. HMAC-SHA256(signing_key, base_string) → base64 → oauth_signature
 * 9. Build Authorization header: OAuth realm="…", oauth_*="…"
 */
export function signRestletRequest(
  fullUrl: string,
  method: "GET" | "POST"
): Record<string, string> {
  // ── 1. Separate base URL from query string ──
  const parsed = new URL(fullUrl);
  const baseUrl = `${parsed.origin}${parsed.pathname}`;

  // ── 2. Extract query params ──
  const queryParams: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });

  // ── 3. Build OAuth params ──
  const nonce = generateNonce();
  const timestamp = generateTimestamp();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: timestamp,
    oauth_token: TOKEN_ID,
    oauth_version: "1.0",
  };

  // ── 4. Merge query + oauth params, sort ──
  const allParams: Record<string, string> = { ...queryParams, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();

  // ── 5. Build parameter string ──
  const paramString = sortedKeys
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(allParams[k])}`)
    .join("&");

  // ── 6. Build signature base string ──
  const signatureBaseString = [
    method.toUpperCase(),
    rfc3986Encode(baseUrl),
    rfc3986Encode(paramString),
  ].join("&");

  // ── 7. Build signing key ──
  const signingKey = `${rfc3986Encode(CONSUMER_SECRET)}&${rfc3986Encode(TOKEN_SECRET)}`;

  // ── 8. HMAC-SHA256 → base64 ──
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(signatureBaseString)
    .digest("base64");

  // ── 9. Build Authorization header ──
  const headerParams: [string, string][] = [
    ["realm", REALM],
    ["oauth_consumer_key", CONSUMER_KEY],
    ["oauth_token", TOKEN_ID],
    ["oauth_nonce", nonce],
    ["oauth_timestamp", timestamp],
    ["oauth_signature_method", "HMAC-SHA256"],
    ["oauth_version", "1.0"],
    ["oauth_signature", signature],
  ];

  const authorizationHeader =
    "OAuth " +
    headerParams
      .map(([k, v]) => `${k}="${rfc3986Encode(v)}"`)
      .join(", ");

  // ── Debug log (temporary) ──
  log.info(
    {
      signingDebug: {
        baseUrl,
        queryParamsStrippedFromBaseUrl: true,
        queryParamsInSignature: queryParams,
        realm: REALM,
        oauth_signature_method: "HMAC-SHA256",
        oauth_timestamp: timestamp,
        parameterCount: sortedKeys.length,
        signatureBaseStringPrefix: signatureBaseString.substring(0, 120) + "…",
        authHeaderPrefix: authorizationHeader.substring(0, 80) + "…",
      },
    },
    "RESTlet OAuth signature built (manual)"
  );

  return {
    Authorization: authorizationHeader,
    "Content-Type": "application/json",
  };
}

// ── URL helpers ────────────────────────────────────────

export function getSuiteQLUrl(): string {
  return `${env.NETSUITE_REST_BASE_URL}/query/v1/suiteql`;
}

export function getSavedSearchUrl(searchId: string): string {
  return `${env.NETSUITE_REST_BASE_URL}/record/v1/search/${searchId}`;
}
