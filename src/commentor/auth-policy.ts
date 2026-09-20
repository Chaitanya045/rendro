/**
 * Convex first asks for a possibly cached token, then asks for a fresh token.
 * The iframe has no token cache of its own, so its first request must report a
 * cache miss and let the forced request obtain the fresh token once.
 */
export class CommentorAuthPolicy {
  private checkedLocalCache = false;
  private awaitingInitialFreshToken = false;

  request(forceRefreshToken: boolean): {
    requestRemote: boolean;
    allowParentCache: boolean;
  } {
    if (!forceRefreshToken && !this.checkedLocalCache) {
      this.checkedLocalCache = true;
      this.awaitingInitialFreshToken = true;
      return { requestRemote: false, allowParentCache: false };
    }
    const allowParentCache = forceRefreshToken && this.awaitingInitialFreshToken;
    this.awaitingInitialFreshToken = false;
    return { requestRemote: true, allowParentCache };
  }
}
