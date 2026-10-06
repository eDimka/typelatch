export interface Session { expiresAt: number; userId: string; }

// An expired session cannot authorize a request.
export function sessionIsValid(session: Session, now: number): boolean {
  return session.expiresAt > now && session.userId.length > 0;
}
