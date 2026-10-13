// `zz logout`: the inverse of `zz login` -- drops the local
// credentials file so the next remote command (or `zz login` itself)
// starts fresh. Mainly for testing the not-logged-in experience and
// switching which account you're acting as, without hunting down
// ~/.zz/credentials.json by hand.
import { clearCredentials } from "../lib/credentials.js";

export function logout(): void {
  const username = clearCredentials();
  console.log(username ? `logged out of ${username}.` : "not logged in -- nothing to do.");
}
