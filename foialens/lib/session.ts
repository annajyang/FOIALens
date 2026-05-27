const GUEST_TOKEN_KEY = 'foialens_guest_token';
const AUTH_TOKEN_KEY  = 'foialens_auth_token';

export function getGuestToken(): string {
  if (typeof window === 'undefined') return '';
  let token = localStorage.getItem(GUEST_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(GUEST_TOKEN_KEY, token);
  }
  return token;
}

export function getAuthToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(AUTH_TOKEN_KEY) ?? '';
}

export function setAuthToken(token: string) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

/** Decode the email from the JWT payload client-side (no signature check). */
export function getSessionEmail(): string {
  const token = getAuthToken();
  if (!token) return '';
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    return payload.email ?? '';
  } catch {
    return '';
  }
}

export function isSignedIn(): boolean {
  return getSessionEmail() !== '';
}

export function sessionHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'X-Guest-Token': getGuestToken() };
  const authToken = getAuthToken();
  if (authToken) h['X-Auth-Token'] = authToken;
  return h;
}

// Legacy helpers kept for the "Save workspace" claim flow.
export function getOwnerEmail(): string {
  return getSessionEmail();
}
export function setOwnerEmail(_email: string) {
  // No-op: email identity is now derived from the verified JWT.
}
