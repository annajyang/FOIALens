const TOKEN_KEY = 'foialens_guest_token';
const EMAIL_KEY = 'foialens_owner_email';

export function getGuestToken(): string {
  if (typeof window === 'undefined') return '';
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(TOKEN_KEY, token);
  }
  return token;
}

export function getOwnerEmail(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(EMAIL_KEY) ?? '';
}

export function setOwnerEmail(email: string) {
  localStorage.setItem(EMAIL_KEY, email.trim().toLowerCase());
}

export function sessionHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'X-Guest-Token': getGuestToken() };
  const email = getOwnerEmail();
  if (email) h['X-Owner-Email'] = email;
  return h;
}
